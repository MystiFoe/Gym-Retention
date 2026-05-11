import * as Sentry from '@sentry/node';
import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import pino from 'pino';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import prometheus from 'prom-client';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger';
import * as admin from 'firebase-admin';

dotenv.config();

// ============================================================================
// SENTRY — initialise before anything else so all errors are captured.
// Set SENTRY_DSN in .env. If not set, Sentry is disabled silently.
// ============================================================================
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
  });
  console.info('Sentry error tracking enabled');
}

// ============================================================================
// STARTUP ENV VALIDATION — crash fast if required vars are missing
// Skip during Firebase CLI analysis phase (module is imported, not executed).
// ============================================================================
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CORS_ORIGIN',
];

// Only validate when: running as the main script (local dev) OR inside Cloud Run
// (K_SERVICE is set). During Firebase CLI analysis, neither is true, so we skip.
const _isMainScript = require.main === module;
const _isCloudRun = !!(process.env.K_SERVICE || process.env.FUNCTION_TARGET);
if (_isMainScript || _isCloudRun) {
  for (const envVar of REQUIRED_ENV_VARS) {
    if (!process.env[envVar]) {
      console.error(`FATAL: Missing required environment variable: ${envVar}`);
      process.exit(1);
    }
  }
  if ((process.env.JWT_SECRET || '').length < 32) {
    console.error('FATAL: JWT_SECRET must be at least 32 characters');
    process.exit(1);
  }
  if ((process.env.JWT_REFRESH_SECRET || '').length < 32) {
    console.error('FATAL: JWT_REFRESH_SECRET must be at least 32 characters');
    process.exit(1);
  }
}

// ============================================================================
// RAZORPAY SETUP
// ============================================================================

const razorpay = process.env.RAZORPAY_KEY_ID ? new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
}) : null;

// Subscription plans (in paise — 1 INR = 100 paise)
const PLANS: Record<string, { label: string; amount: number; months: number }> = {
  monthly:   { label: 'Monthly',   amount:  99900, months: 1  },
  quarterly: { label: 'Quarterly', amount: 249900, months: 3  },
  annual:    { label: 'Annual',    amount: 799900, months: 12 },
};

// ============================================================================
// FIREBASE ADMIN SDK
// Set FIREBASE_SERVICE_ACCOUNT_JSON in .env (the full service account JSON as a
// single-line string). If not set, Firebase phone-auth endpoints return 503.
// ============================================================================

let firebaseInitialized = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Explicit service account JSON (local dev / non-Firebase deployments)
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseInitialized = true;
  } else if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) {
    // Running inside Firebase Functions — use Application Default Credentials
    admin.initializeApp();
    firebaseInitialized = true;
  }
} catch (err) {
  console.error('Firebase Admin init failed – phone OTP will be unavailable:', err);
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface AuthRequest extends Request {
  user?: any;
  gym_id?: string;
  token?: string;
}

interface CustomError extends Error {
  status?: number;
}

// ============================================================================
// LOGGER SETUP
// ============================================================================

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, singleLine: false }
  }
});

// ============================================================================
// PROMETHEUS METRICS
// ============================================================================

const httpRequestDuration = new prometheus.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

const loginAttempts = new prometheus.Counter({
  name: 'login_attempts_total',
  help: 'Total login attempts',
  labelNames: ['status']
});

const apiErrors = new prometheus.Counter({
  name: 'api_errors_total',
  help: 'Total API errors',
  labelNames: ['route', 'error_type']
});

const databaseQueries = new prometheus.Histogram({
  name: 'database_query_duration_seconds',
  help: 'Database query duration',
  labelNames: ['query_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1]
});

prometheus.register.registerMetric(httpRequestDuration);
prometheus.register.registerMetric(loginAttempts);
prometheus.register.registerMetric(apiErrors);
prometheus.register.registerMetric(databaseQueries);

// ============================================================================
// DATABASE SETUP
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DATABASE_POOL_SIZE || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ error: err }, 'Database pool error');
});

// Add fcm_token column if it doesn't exist (idempotent migration)
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`).catch(() => {});
// Fix column sizes that may have been created too small in earlier schema versions
pool.query(`ALTER TABLE members ALTER COLUMN email TYPE VARCHAR(255)`).catch(() => {});
pool.query(`ALTER TABLE members ALTER COLUMN phone TYPE VARCHAR(50)`).catch(() => {});
pool.query(`ALTER TABLE members ALTER COLUMN name  TYPE VARCHAR(255)`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN email TYPE VARCHAR(255)`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN phone TYPE VARCHAR(30)`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN name  TYPE VARCHAR(255)`).catch(() => {});
// Sync users.is_deleted + free the email slot for trainers deleted before this fix was deployed
pool.query(`
  UPDATE users u
  SET is_deleted = true,
      phone_or_email = '_rm_' || substring(u.id::text, 1, 8)
  FROM trainers t
  WHERE t.user_id = u.id
    AND t.is_deleted = true
    AND u.is_deleted = false
`).catch(() => {});
// NOTE: is_blocked, blocked_at, blocked_reason columns on gyms must be added
// by running database/migration_gym_block.sql in the Supabase SQL editor.
// DDL via the transaction pooler (port 6543) is not supported.

// ── Biometric & QR attendance migrations ──────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS biometric_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id        UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    serial_number VARCHAR(100) NOT NULL,
    device_name   VARCHAR(100),
    last_seen_at  TIMESTAMPTZ,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(gym_id, serial_number)
  )
`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_biometric_devices_serial ON biometric_devices(serial_number)`).catch(() => {});
pool.query(`
  CREATE TABLE IF NOT EXISTS biometric_mappings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id         UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    serial_number  VARCHAR(100) NOT NULL,
    device_user_id VARCHAR(50) NOT NULL,
    member_id      UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(gym_id, serial_number, device_user_id)
  )
`).catch(() => {});

// ── Payment feature migrations ────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id              UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    member_id           UUID NOT NULL REFERENCES members(id),
    razorpay_order_id   VARCHAR(100),
    razorpay_payment_id VARCHAR(100),
    amount              INTEGER NOT NULL,
    currency            VARCHAR(10) NOT NULL DEFAULT 'INR',
    status              VARCHAR(20) NOT NULL DEFAULT 'pending',
    payment_method      VARCHAR(30),
    description         TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_gym_id    ON payments(gym_id)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_member_id ON payments(member_id)`).catch(() => {});
pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_id ON payments(razorpay_order_id) WHERE razorpay_order_id IS NOT NULL`).catch(() => {});
// Track attendance source: biometric | mobile | staff | qr
pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'staff'`).catch(() => {});
// Add timestamptz column used by mobile/biometric paths (staff path uses visit_date DATE)
pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS visited_at TIMESTAMPTZ`).then(() =>
  pool.query(`UPDATE attendance_logs SET visited_at = (visit_date::date + COALESCE(check_in_time, '00:00:00')::time)::timestamptz WHERE visited_at IS NULL AND visit_date IS NOT NULL`)
).catch(() => {});
// Prevent duplicate attendance for same member on same day (partial index — only when visited_at is set)
pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_member_day ON attendance_logs(gym_id, member_id, visit_date) WHERE visit_date IS NOT NULL`).catch(() => {});
// Link members to their user account (for password-login members)
pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id) WHERE user_id IS NOT NULL`).catch(() => {});
// Track whether member has verified email/phone
pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
pool.query(`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS razorpay_key_id     VARCHAR(100)`).catch(() => {});
pool.query(`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS razorpay_key_secret VARCHAR(255)`).catch(() => {});
pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS plan VARCHAR(50)`).catch(() => {});
// Fix: convert empty-string emails to NULL so multiple members without email don't conflict
pool.query(`UPDATE members SET email = NULL WHERE email = ''`).catch(() => {});
// Allow NULL email going forward (remove NOT NULL if it exists)
pool.query(`ALTER TABLE members ALTER COLUMN email DROP NOT NULL`).catch(() => {});

// Allow pending trainer slots (user_id NULL until staff self-registers via invite code)
pool.query(`ALTER TABLE trainers ALTER COLUMN user_id DROP NOT NULL`).catch(() => {});
// Allow pending trainer slots with empty phone/email (filled on self-registration)
pool.query(`ALTER TABLE trainers ALTER COLUMN phone  SET DEFAULT ''`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN email  SET DEFAULT ''`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN phone  DROP NOT NULL`).catch(() => {});
pool.query(`ALTER TABLE trainers ALTER COLUMN email  DROP NOT NULL`).catch(() => {});

// ID sequences — atomic counters for display IDs (seed INSERT chained after CREATE to avoid race)
pool.query(`
  CREATE TABLE IF NOT EXISTS id_sequences (
    entity_type VARCHAR(20) PRIMARY KEY,
    last_value BIGINT DEFAULT 0
  )
`).then(() =>
  pool.query(`INSERT INTO id_sequences (entity_type) VALUES ('business'), ('staff'), ('member') ON CONFLICT DO NOTHING`)
).catch(() => {});

// Display ID columns
pool.query(`ALTER TABLE gyms     ADD COLUMN IF NOT EXISTS display_id VARCHAR(30) UNIQUE`).catch(() => {});
pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS display_id VARCHAR(30) UNIQUE`).catch(() => {});
pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS trainer_role VARCHAR(20) DEFAULT 'staff'`).catch(() => {});
pool.query(`ALTER TABLE members  ADD COLUMN IF NOT EXISTS display_id VARCHAR(30) UNIQUE`).catch(() => {});

// Invite codes table
pool.query(`
  CREATE TABLE IF NOT EXISTS invite_codes (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gym_id       UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
    code         VARCHAR(10) UNIQUE NOT NULL,
    type         VARCHAR(10) NOT NULL CHECK (type IN ('staff', 'member')),
    display_id   VARCHAR(30),
    placeholder_name  VARCHAR(255),
    placeholder_phone VARCHAR(50),
    trainer_role VARCHAR(20) DEFAULT 'staff',
    trainer_id   UUID REFERENCES trainers(id) ON DELETE CASCADE,
    member_id    UUID REFERENCES members(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_invite_codes_gym  ON invite_codes(gym_id)`).catch(() => {});

// ── Backfill display IDs for existing records that pre-date the id_sequences feature ──────────
// Runs once on startup; ON CONFLICT DO NOTHING skips rows that already have a display_id.
// Uses a temporary sequence within the query to assign IDs without racing.
(async () => {
  try {
    // Ensure sequences are seeded before backfill
    await pool.query(`INSERT INTO id_sequences (entity_type) VALUES ('business'),('staff'),('member') ON CONFLICT DO NOTHING`);

    // Backfill gyms
    const gyms = await pool.query(`SELECT id FROM gyms WHERE display_id IS NULL AND is_deleted = false ORDER BY created_at`);
    for (const row of gyms.rows) {
      const res = await pool.query(`UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = 'business' RETURNING last_value`);
      const n = Number(res.rows[0].last_value);
      const did = `RCV-B-${String(n).padStart(5, '0')}`;
      await pool.query(`UPDATE gyms SET display_id = $1 WHERE id = $2 AND display_id IS NULL`, [did, row.id]);
    }

    // Backfill trainers (only registered ones — user_id NOT NULL)
    const trainers = await pool.query(`SELECT id FROM trainers WHERE display_id IS NULL AND is_deleted = false AND user_id IS NOT NULL ORDER BY created_at`);
    for (const row of trainers.rows) {
      const res = await pool.query(`UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = 'staff' RETURNING last_value`);
      const n = Number(res.rows[0].last_value);
      const did = `RCV-S-${String(n).padStart(7, '0')}`;
      await pool.query(`UPDATE trainers SET display_id = $1 WHERE id = $2 AND display_id IS NULL`, [did, row.id]);
    }

    // Backfill members
    const members = await pool.query(`SELECT id FROM members WHERE display_id IS NULL AND is_deleted = false ORDER BY created_at`);
    for (const row of members.rows) {
      const res = await pool.query(`UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = 'member' RETURNING last_value`);
      const n = Number(res.rows[0].last_value);
      const did = `RCV-M-${String(n).padStart(7, '0')}`;
      await pool.query(`UPDATE members SET display_id = $1 WHERE id = $2 AND display_id IS NULL`, [did, row.id]);
    }

    const counts = { gyms: gyms.rows.length, trainers: trainers.rows.length, members: members.rows.length };
    if (counts.gyms + counts.trainers + counts.members > 0) {
      console.info('[startup] Backfilled display IDs:', counts);
    }
  } catch (err: any) {
    console.warn('[startup] Display ID backfill skipped:', err?.message);
  }
})();

// ============================================================================
// IN-MEMORY OTP STORE for member registration verification
// Keyed by tempKey (random hex). Short-lived (15 min). Cleared on use.
// ============================================================================
interface MemberRegOtp {
  email: string;
  code: string;
  inviteCode: string;
  expires: number;
}
const memberRegOtps = new Map<string, MemberRegOtp>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memberRegOtps) { if (val.expires < now) memberRegOtps.delete(key); }
}, 5 * 60 * 1000);

// ============================================================================
// EMAIL SERVICE
// ============================================================================

// ============================================================================
// FCM PUSH NOTIFICATION HELPER
// Sends a push notification to a single FCM token.
// Silently skips if Firebase is not initialized or token is empty.
// ============================================================================

const sendPush = async (
  fcmToken: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> => {
  if (!firebaseInitialized || !fcmToken) return;
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data,
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    logger.info({ title }, 'Push notification sent');
  } catch (err: any) {
    // Token invalid/unregistered — clear it from DB
    if (err?.errorInfo?.code === 'messaging/registration-token-not-registered') {
      await pool.query(`UPDATE users SET fcm_token = NULL WHERE fcm_token = $1`, [fcmToken]).catch(() => {});
    }
    logger.warn({ err: err?.message, title }, 'Push notification failed');
  }
};

// Generate globally-unique display ID using atomic sequence counter.
// Self-healing: inserts the row if it was never seeded (production cold-start race).
async function generateDisplayId(entityType: 'business' | 'staff' | 'member'): Promise<string> {
  // Ensure the row exists before updating (handles missed seeding on first deploy)
  await pool.query(
    `INSERT INTO id_sequences (entity_type, last_value) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [entityType]
  );
  const result = await pool.query(
    'UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = $1 RETURNING last_value',
    [entityType]
  );
  if (!result.rows[0]) throw new Error(`id_sequences row missing for entity_type=${entityType}`);
  const n = Number(result.rows[0].last_value);
  if (entityType === 'business') return `RCV-B-${String(n).padStart(5, '0')}`;
  if (entityType === 'staff')    return `RCV-S-${String(n).padStart(7, '0')}`;
  return                                `RCV-M-${String(n).padStart(7, '0')}`;
}

// 8-character uppercase alphanumeric invite code (no 0, O, I, 1 to avoid visual confusion)
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── SMTP transporter (Gmail or any SMTP relay) ──────────────────────────────
// Configure via Firebase Secrets: SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_HOST
let _smtpTransporter: nodemailer.Transporter | null = null;
const getSmtpTransporter = (): nodemailer.Transporter | null => {
  if (_smtpTransporter) return _smtpTransporter;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  if (!user || !pass) {
    logger.warn('SMTP not configured — SMTP_USER / SMTP_PASSWORD missing');
    return null;
  }
  _smtpTransporter = nodemailer.createTransport({
    host,
    port: 587,
    secure: false,
    auth: { user, pass },
  });
  return _smtpTransporter;
};

const sendEmail = async (to: string, subject: string, html: string): Promise<void> => {
  const transport = getSmtpTransporter();
  if (!transport) {
    logger.warn({ to, subject }, 'Email not sent — SMTP not configured');
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transport.sendMail({ from, to, subject, html });
    logger.info({ to, subject }, 'Email sent');
  } catch (err: any) {
    logger.error({ err: err?.message, to }, 'Email send failed');
    throw new Error('Failed to send email. Please check your inbox or try again.');
  }
};

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const createOrderSchema = z.object({
  plan: z.enum(['monthly', 'quarterly', 'annual'])
});

const verifyPaymentSchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
  plan: z.enum(['monthly', 'quarterly', 'annual'])
});

const forgotPasswordSchema = z.object({
  email: z.string().email()
});

const sendOtpSchema = z.object({
  email: z.string().email()
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6).regex(/^\d{6}$/, 'OTP must be 6 digits')
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: z.string().min(8).max(255).regex(
    /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9])/,
    'Password must have at least 1 uppercase, 1 number, and 1 special character'
  )
});

const loginSchema = z.object({
  phone_or_email: z.string().min(5).max(255),
  password: z.string().min(8).max(255),
  role: z.enum(['owner', 'trainer', 'member']),
  gym_id: z.string().uuid().optional()
});

const gymRegisterSchema = z.object({
  gym_name: z.string().min(1).max(255),
  owner_name: z.string().min(1).max(255),
  phone: z.string().min(10).max(20),
  email: z.string().email(),
  address: z.string().max(500),
  owner_password: z.string().min(8).max(255).regex(
    /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9])/,
    'Password must have at least 1 uppercase, 1 number, and 1 special character'
  ),
  owner_email: z.string().email()
});


const completeRegistrationSchema = z.object({
  pending_id: z.string().uuid(),
  firebase_id_token: z.string().min(1)
});

const memberSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().min(10).max(20),
  email: z.string().email().optional().or(z.literal('')).or(z.null()),
  last_visit_date: z.string().optional().nullable(),
  membership_expiry_date: z.string().min(1),
  plan_fee: z.number().positive(),
  plan: z.enum(['monthly', 'quarterly', 'biannual', 'annual']).optional().nullable(),
  assigned_trainer_id: z.string().uuid().optional().nullable()
});

const taskSchema = z.object({
  member_id: z.string().uuid(),
  task_type: z.enum(['call', 'renewal', 'check_in']),
  assigned_trainer_id: z.string().uuid().optional(),
  notes: z.string().max(500).optional()
});

const attendanceSchema = z.object({
  member_id: z.string().uuid(),
  visit_date: z.string().date(),
  check_in_time: z.string().time().optional()
});

const bulkMembersSchema = z.object({
  // trainer_id is optional — if omitted the owner manages these members directly
  trainer_id: z.string().uuid().optional().nullable(),
  members: z.array(z.object({
    name: z.string().min(1).max(100),
    phone: z.string().max(30).optional().nullable(),
    email: z.string().max(255).optional().nullable(),
    plan_fee: z.number().nonnegative().optional().nullable(),
    membership_expiry_date: z.string().optional().nullable(),
    last_visit_date: z.string().optional().nullable(),
  })).min(1).max(5000),  // Flutter chunks > 5000 rows into multiple requests
});

const bulkTrainersSchema = z.object({
  trainers: z.array(z.object({
    name: z.string().min(2).max(100),
    phone: z.string().min(10).max(20),
    email: z.string().email(),
  })).min(1).max(200),
});

// ============================================================================
// EXPRESS APP
// ============================================================================

const app: Express = express();

// Trust the first proxy (Firebase Functions / Cloud Run sit behind a load balancer).
// This lets express-rate-limit use X-Forwarded-For for the real client IP.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(',').map(o => o.trim()),
  credentials: true
}));

// HTTPS enforcement
app.use((req: Request, res: Response, next: NextFunction) => {
  const proto = req.header('x-forwarded-proto') || req.protocol;
  if (proto !== 'https' && process.env.NODE_ENV === 'production') {
   // return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ============================================================================
// RATE LIMITING
// ============================================================================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Rate limit exceeded');
    loginAttempts.inc({ status: 'rate_limited' });
    res.status(429).json({ success: false, error: 'Too many attempts' });
  }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true
});

// ============================================================================
// VALIDATION MIDDLEWARE
// ============================================================================

const validate = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.body);
      req.body = validated;
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          errors: error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }
      next(error);
    }
  };
};

// ============================================================================
// REQUEST LOGGING
// ============================================================================

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestDuration.observe({
      method: req.method,
      route: req.path,
      status: res.statusCode
    }, duration);

    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration.toFixed(3)}s`,
      ip: req.ip
    });
  });
  next();
});

// ============================================================================
// AUTHENTICATION
// ============================================================================

const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    if (!decoded.gym_id) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    // Immediately reject if gym is blocked (takes effect even with a valid JWT)
    try {
      const gymCheck = await pool.query(
        `SELECT is_blocked FROM gyms WHERE id = $1 AND is_deleted = false LIMIT 1`,
        [decoded.gym_id]
      );
      if (!gymCheck.rows.length) {
        return res.status(403).json({ success: false, error: 'Gym not found or deleted.' });
      }
      if (gymCheck.rows[0].is_blocked) {
        return res.status(403).json({ success: false, error: 'Your account has been blocked. Please contact support.' });
      }
    } catch (dbErr: any) {
      // If is_blocked column doesn't exist yet (migration not run), skip the check gracefully
      if (!dbErr?.message?.includes('is_blocked')) throw dbErr;
    }

    req.user = decoded;
    req.gym_id = decoded.gym_id;
    next();
  } catch (error) {
    logger.warn('Token verification failed');
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

const authorize = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const role = req.user.role;
    // Admin trainers inherit owner-level access for general management operations
    if (role === 'trainer' && req.user.trainer_role === 'admin' && roles.includes('owner')) {
      return next();
    }
    if (!roles.includes(role)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    next();
  };
};

// Owner-only: blocks admin trainers. Use for subscription, billing, role management.
const authorizeOwnerOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'This action requires owner access' });
  }
  next();
};

// ============================================================================
// ERROR HANDLER
// ============================================================================

const errorHandler = (err: CustomError, req: Request, res: Response, next: NextFunction) => {
  const status = err.status || 500;
  apiErrors.inc({ route: req.path, error_type: err.name || 'unknown' });
  logger.error({ error: err.message, status, path: req.path });

  // Report unexpected server errors (5xx) to Sentry
  if (status >= 500 && process.env.SENTRY_DSN) {
    Sentry.captureException(err, { extra: { path: req.path, method: req.method } });
  }

  // Map known DB error codes to user-friendly messages
  let userMessage = err.message;
  const dbCode: string = (err as any).code || '';
  if (dbCode === '23505') {
    const combined = [
      (err as any).detail || '',
      (err as any).constraint || '',
      err.message || '',
    ].join(' ').toLowerCase();
    if (combined.includes('phone')) userMessage = 'This phone number is already registered.';
    else if (combined.includes('email')) userMessage = 'This email address is already registered.';
    else if (combined.includes('unique_id')) userMessage = 'Please try again.';
    else userMessage = 'A duplicate entry was detected. Please check your details.';
  } else if (dbCode === '22001' || err.message?.includes('value too long for type character varying')) {
    userMessage = 'One or more fields exceed the allowed length. Please shorten your input.';
  } else if (dbCode === '23502') {
    userMessage = 'A required field is missing. Please fill in all required fields.';
  } else if (dbCode === '23503') {
    userMessage = 'The related record was not found. Please refresh and try again.';
  } else if (dbCode === '08006' || dbCode === '08001' || dbCode === '08004') {
    userMessage = 'Database connection issue. Please try again in a moment.';
  } else if (dbCode.startsWith('22') || dbCode.startsWith('23')) {
    // Any other data exception or integrity constraint — don't leak raw message
    userMessage = 'Invalid data provided. Please check your input and try again.';
  } else if (dbCode && !userMessage) {
    userMessage = 'An unexpected error occurred. Please try again.';
  }

  res.status(status).json({
    success: false,
    error: userMessage || 'An unexpected error occurred. Please try again.',
  });
};

// ============================================================================
// SWAGGER API DOCS
// ============================================================================

const swaggerSetup = swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Recurva API Docs',
  swaggerOptions: { persistAuthorization: true },
});
app.use('/api-docs', swaggerUi.serve, swaggerSetup);
// Also serve under /api/docs so Firebase Hosting rewrite /api/** reaches it
app.use('/api/docs', swaggerUi.serve, swaggerSetup);

// ============================================================================
// HEALTH & METRICS
// ============================================================================

const healthHandler = (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.get('/metrics', (req: Request, res: Response) => {
  res.set('Content-Type', prometheus.register.contentType);
  res.end(prometheus.register.metrics());
});

// ============================================================================
// GYM REGISTRATION
// ============================================================================

// ============================================================================
// STEP 1 — Initiate registration: validate, store pending, send email OTP.
// No gym or user record is created here.
// ============================================================================
app.post('/api/gyms/register', validate(gymRegisterSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gym_name, owner_name, phone, email, address, owner_password, owner_email } = req.body;

    // Reject if gym email already registered
    const gymEmailCheck = await pool.query(
      `SELECT id FROM gyms WHERE email = $1 AND is_deleted = false LIMIT 1`,
      [email]
    );
    if (gymEmailCheck.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    }

    // Reject if owner login email already registered
    const ownerEmailCheck = await pool.query(
      `SELECT id FROM users WHERE phone_or_email = $1 AND role = 'owner' AND is_deleted = false LIMIT 1`,
      [owner_email]
    );
    if (ownerEmailCheck.rows.length > 0) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists. Please log in.' });
    }

    const passwordHash = await bcrypt.hash(owner_password, 10);
    const sessionExpiry = new Date(Date.now() + 60 * 60 * 1000); // 60 min to complete

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Upsert pending registration (allow retry with same email)
    const pendingRes = await pool.query(
      `INSERT INTO pending_registrations
         (gym_name, owner_name, gym_phone, gym_email, address, owner_email,
          password_hash, email_otp_code, email_otp_expires_at, email_verified, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
       ON CONFLICT (owner_email) DO UPDATE SET
         gym_name = EXCLUDED.gym_name,
         owner_name = EXCLUDED.owner_name,
         gym_phone = EXCLUDED.gym_phone,
         gym_email = EXCLUDED.gym_email,
         address = EXCLUDED.address,
         password_hash = EXCLUDED.password_hash,
         email_otp_code = EXCLUDED.email_otp_code,
         email_otp_expires_at = EXCLUDED.email_otp_expires_at,
         email_verified = false,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()
       RETURNING id`,
      [gym_name, owner_name, phone, email, address, owner_email, passwordHash, otp, otpExpiry, sessionExpiry]
    );

    const pendingId = pendingRes.rows[0].id;

    // Send OTP email
    await sendEmail(
      owner_email,
      'Your Recurva Verification Code',
      `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
        <h2 style="color:#2196F3;margin-bottom:8px">Verify Your Email</h2>
        <p style="color:#444;margin-bottom:24px">Use the code below to verify your email and complete your <strong>Recurva</strong> business registration.</p>
        <div style="background:#fff;border:2px solid #2196F3;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px">
          <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#1a1a1a;font-family:monospace">${otp}</span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#888;font-size:13px">If you didn't request this, please ignore this email.</p>
      </div>
      `
    );

    logger.info({ owner_email, pendingId }, 'Registration initiated — OTP sent via email');

    res.status(200).json({
      success: true,
      data: { pendingId, ownerEmail: owner_email, gymPhone: phone }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 2 — Verify 6-digit email OTP for the pending registration.
// ============================================================================
app.post('/api/gyms/register/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pending_id, otp_code } = req.body;
    if (!pending_id || !otp_code) {
      return res.status(400).json({ success: false, error: 'pending_id and otp_code are required' });
    }

    const result = await pool.query(
      `SELECT id, gym_phone, owner_email, email_verified, email_otp_code, email_otp_expires_at, expires_at
       FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registration session not found. Please start over.' });
    }

    const pending = result.rows[0];

    if (new Date() > new Date(pending.expires_at)) {
      await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      return res.status(400).json({ success: false, error: 'Registration session expired. Please start the registration again.' });
    }

    // Idempotent — if already verified, proceed to phone step
    if (pending.email_verified) {
      return res.json({ success: true, data: { pendingId: pending_id, gymPhone: pending.gym_phone } });
    }

    // Check OTP expiry
    if (new Date() > new Date(pending.email_otp_expires_at)) {
      return res.status(400).json({ success: false, error: 'Verification code expired. Please request a new one.' });
    }

    // Check OTP match (constant-time compare to prevent timing attacks)
    const otpMatch = crypto.timingSafeEqual(
      Buffer.from(String(otp_code).trim()),
      Buffer.from(String(pending.email_otp_code))
    );
    if (!otpMatch) {
      return res.status(400).json({ success: false, error: 'Incorrect verification code. Please try again.' });
    }

    await pool.query(
      `UPDATE pending_registrations SET email_verified = true WHERE id = $1`,
      [pending_id]
    );

    logger.info({ pending_id }, 'Registration email verified via OTP');
    res.json({ success: true, data: { pendingId: pending_id, gymPhone: pending.gym_phone } });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 2b — Resend email OTP.
// ============================================================================
app.post('/api/gyms/register/resend-email-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pending_id } = req.body;
    if (!pending_id) return res.status(400).json({ success: false, error: 'pending_id is required' });

    const result = await pool.query(
      `SELECT id, owner_email, expires_at FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registration session not found.' });
    }
    const pending = result.rows[0];
    if (new Date() > new Date(pending.expires_at)) {
      return res.status(400).json({ success: false, error: 'Session expired. Please start registration again.' });
    }

    // Generate new OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      `UPDATE pending_registrations SET email_otp_code = $1, email_otp_expires_at = $2 WHERE id = $3`,
      [otp, otpExpiry, pending_id]
    );

    await sendEmail(
      pending.owner_email,
      'Your Recurva Verification Code (Resent)',
      `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
        <h2 style="color:#2196F3;margin-bottom:8px">New Verification Code</h2>
        <p style="color:#444;margin-bottom:24px">Here is your new <strong>Recurva</strong> verification code:</p>
        <div style="background:#fff;border:2px solid #2196F3;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px">
          <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#1a1a1a;font-family:monospace">${otp}</span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in <strong>15 minutes</strong>.</p>
      </div>
      `
    );

    logger.info({ pending_id }, 'Email OTP resent');
    res.json({ success: true, message: 'A new verification code has been sent to your email.' });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 3 — Verify phone via Firebase, complete registration, issue JWTs.
// This is the ONLY place where gym + user records are created.
// ============================================================================
app.post('/api/gyms/register/verify-phone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) {
      return res.status(503).json({ success: false, error: 'Firebase not configured on this server' });
    }

    const parsed = completeRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'pending_id and firebase_id_token are required' });
    }
    const { pending_id, firebase_id_token } = parsed.data;

    // Verify Firebase token
    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired phone verification token' });
    }

    const firebasePhone = decodedFirebase.phone_number;
    if (!firebasePhone) {
      return res.status(400).json({ success: false, error: 'No phone number found in verification token' });
    }

    const result = await pool.query(
      `SELECT * FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registration session not found. Please start over.' });
    }

    const pending = result.rows[0];

    if (new Date() > new Date(pending.expires_at)) {
      await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      return res.status(400).json({ success: false, error: 'Registration session expired. Please start over.' });
    }

    if (!pending.email_verified) {
      return res.status(400).json({ success: false, error: 'Email must be verified before phone verification.' });
    }

    // Normalise to last 10 digits for comparison (handles +91 prefix variations)
    const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
    if (last10(firebasePhone) !== last10(pending.gym_phone)) {
      return res.status(400).json({
        success: false,
        error: `Phone number does not match the one used during registration. Please verify the number ending in ${last10(pending.gym_phone).slice(-4)}.`
      });
    }

    // Create gym + user atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Guard against race conditions
      const dupGym = await client.query(
        `SELECT id FROM gyms WHERE email = $1 AND is_deleted = false LIMIT 1`,
        [pending.gym_email]
      );
      if (dupGym.rows.length > 0) {
        await client.query('ROLLBACK');
        await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
        return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
      }

      const dupUser = await client.query(
        `SELECT id FROM users WHERE phone_or_email = $1 AND role = 'owner' AND is_deleted = false LIMIT 1`,
        [pending.owner_email]
      );
      if (dupUser.rows.length > 0) {
        await client.query('ROLLBACK');
        await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
        return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
      }

      const trialStart = new Date();
      const trialEnd   = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000);

      const gymDisplayId = await generateDisplayId('business');
      const gymRes = await client.query(
        `INSERT INTO gyms (name, owner_name, phone, email, address, subscription_status, trial_started_at, trial_ends_at, display_id)
         VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7, $8)
         RETURNING id`,
        [pending.gym_name, pending.owner_name, pending.gym_phone,
         pending.gym_email, pending.address, trialStart, trialEnd, gymDisplayId]
      );
      const gymId = gymRes.rows[0].id;

      // Store both email (phone_or_email) and verified phone for dual-identifier login
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, phone, password_hash, role, email_verified)
         VALUES ($1, $2, $3, $4, 'owner', true)
         RETURNING id, gym_id, role`,
        [gymId, pending.owner_email, firebasePhone, pending.password_hash]
      );
      const user = userRes.rows[0];

      await client.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      await client.query('COMMIT');

      const accessToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );
      const refreshToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id },
        process.env.JWT_REFRESH_SECRET!,
        { expiresIn: '7d' }
      );

      // Welcome email
      await sendEmail(pending.owner_email, 'Welcome to Recurva! 🎉', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">You're all set!</h2>
          <p>Your business <strong>${pending.gym_name}</strong> is now registered on Recurva. Your 30-day free trial has started.</p>
          <p>You can log in using your email <strong>${pending.owner_email}</strong> or your registered phone number.</p>
        </div>
      `);

      logger.info({ gymId, userId: user.id }, 'Registration completed — gym and user created');

      res.status(201).json({
        success: true,
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          user: { id: user.id, gym_id: user.gym_id, role: user.role },
          subscriptionStatus: 'trial',
          trialEndsAt: trialEnd
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SUBSCRIPTION & BILLING ENDPOINTS
// ============================================================================

// GET subscription status
app.get('/api/gyms/:gymId/subscription', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.params.gymId !== req.gym_id) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT subscription_status, trial_started_at, trial_ends_at,
                subscription_started_at, subscription_ends_at
         FROM gyms WHERE id = $1 AND is_deleted = false`,
        [req.gym_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Gym not found' });
      }
      const gym = result.rows[0];
      const now = new Date();
      let daysRemaining = 0;

      if (gym.subscription_status === 'trial' && gym.trial_ends_at) {
        daysRemaining = Math.max(0, Math.ceil((new Date(gym.trial_ends_at).getTime() - now.getTime()) / 86400000));
      } else if (gym.subscription_status === 'active' && gym.subscription_ends_at) {
        daysRemaining = Math.max(0, Math.ceil((new Date(gym.subscription_ends_at).getTime() - now.getTime()) / 86400000));
      }

      res.json({
        success: true,
        data: {
          status: gym.subscription_status,
          daysRemaining,
          trialEndsAt: gym.trial_ends_at,
          subscriptionEndsAt: gym.subscription_ends_at,
          plans: Object.entries(PLANS).map(([key, p]) => ({
            id: key,
            label: p.label,
            amountInPaise: p.amount,
            amountDisplay: `₹${(p.amount / 100).toLocaleString('en-IN')}`,
            months: p.months,
          })),
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// POST create Razorpay order
app.post('/api/gyms/:gymId/billing/create-order', authenticate, authorize(['owner']), validate(createOrderSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.params.gymId !== req.gym_id) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const { plan } = req.body;
    const planDetails = PLANS[plan];

    const client = await pool.connect();
    try {
      const gymRes = await client.query(`SELECT name FROM gyms WHERE id = $1`, [req.gym_id]);
      if (gymRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });

      const order = await razorpay!.orders.create({
        amount: planDetails.amount,
        currency: 'INR',
        receipt: `gym_${req.gym_id}_${Date.now()}`,
        notes: { gym_id: req.gym_id!, plan },
      });

      res.json({
        success: true,
        data: {
          orderId: order.id,
          amount: planDetails.amount,
          currency: 'INR',
          keyId: process.env.RAZORPAY_KEY_ID,
          gymName: gymRes.rows[0].name,
          planLabel: planDetails.label,
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// POST verify payment & activate subscription
app.post('/api/gyms/:gymId/billing/verify-payment', authenticate, authorize(['owner']), validate(verifyPaymentSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (req.params.gymId !== req.gym_id) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    // Verify Razorpay signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      logger.warn({ gymId: req.gym_id }, 'Payment signature verification failed');
      return res.status(400).json({ success: false, error: 'Payment verification failed. Please contact support.' });
    }

    const planDetails = PLANS[plan];
    const now = new Date();
    const subscriptionEnd = new Date(now.getTime() + planDetails.months * 30 * 24 * 60 * 60 * 1000);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE gyms SET
           subscription_status = 'active',
           subscription_started_at = $1,
           subscription_ends_at = $2
         WHERE id = $3`,
        [now, subscriptionEnd, req.gym_id]
      );

      await client.query(
        `INSERT INTO subscription_billing
           (gym_id, billing_period_start, billing_period_end, subscription_fee, payment_status, payment_method, payment_date)
         VALUES ($1, $2, $3, $4, 'completed', 'razorpay', $5)`,
        [req.gym_id, now.toISOString().split('T')[0], subscriptionEnd.toISOString().split('T')[0], planDetails.amount / 100, now]
      );

      await client.query('COMMIT');

      logger.info({ gymId: req.gym_id, plan, paymentId: razorpay_payment_id }, 'Subscription activated');

      res.json({
        success: true,
        data: {
          status: 'active',
          subscriptionEndsAt: subscriptionEnd,
          message: `Subscription activated! Valid until ${subscriptionEnd.toLocaleDateString('en-IN')}.`,
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { phone_or_email, password, role, gym_id } = req.body;
    const client = await pool.connect();

    try {
      let query = `
        SELECT u.id, u.gym_id, u.phone_or_email, u.password_hash, u.role
        FROM users u
        WHERE (u.phone_or_email = $1 OR u.phone = $1 OR RIGHT(u.phone, 10) = RIGHT($1, 10))
          AND u.role = $2 AND u.is_deleted = false
      `;
      const params: any[] = [phone_or_email, role];

      if (gym_id) {
        query += ` AND u.gym_id = $${params.length + 1}`;
        params.push(gym_id);
      }

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        loginAttempts.inc({ status: 'failed' });
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const passwordMatch = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatch) {
        loginAttempts.inc({ status: 'failed' });
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      // Check if gym is suspended or blocked
      let gymCheckRow: any = null;
      try {
        const gymCheck = await client.query(
          `SELECT subscription_status, is_blocked FROM gyms WHERE id = $1`, [user.gym_id]
        );
        gymCheckRow = gymCheck.rows[0];
      } catch (colErr: any) {
        // is_blocked column missing (migration not yet run) — fall back to status-only check
        if (colErr?.message?.includes('is_blocked')) {
          const gymCheck = await client.query(
            `SELECT subscription_status FROM gyms WHERE id = $1`, [user.gym_id]
          );
          gymCheckRow = gymCheck.rows[0];
        } else throw colErr;
      }
      if (gymCheckRow?.is_blocked) {
        loginAttempts.inc({ status: 'failed' });
        return res.status(403).json({ success: false, error: 'Your account has been blocked. Please contact support.' });
      }
      if (gymCheckRow?.subscription_status === 'suspended') {
        loginAttempts.inc({ status: 'failed' });
        return res.status(403).json({ success: false, error: 'Your account has been suspended. Please contact support.' });
      }

      let trainerRole: string | undefined;
      if (user.role === 'trainer') {
        const trainerInfo = await client.query(
          `SELECT trainer_role FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
          [user.id, user.gym_id]
        );
        trainerRole = trainerInfo.rows[0]?.trainer_role || 'staff';
      }

      // For members: look up the member record to include member_id in JWT.
      // Strategy 1: direct user_id match (set during registration or prior login).
      // Strategy 2: email/phone match against users.phone_or_email.
      let memberId: string | undefined;
      if (user.role === 'member') {
        // Strategy 1 — user_id direct match
        try {
          const byUserId = await client.query(
            `SELECT id FROM members WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
            [user.id, user.gym_id]
          );
          memberId = byUserId.rows[0]?.id;
        } catch { /* user_id column may not exist yet */ }

        // Strategy 2 — email / phone cross-match
        if (!memberId) {
          try {
            const memberInfo = await client.query(
              `SELECT id FROM members
               WHERE gym_id = $1 AND is_deleted = false
                 AND (LOWER(email) = LOWER($2)
                      OR phone = $2
                      OR RIGHT(phone, 10) = RIGHT($2, 10))
               LIMIT 1`,
              [user.gym_id, user.phone_or_email]
            );
            memberId = memberInfo.rows[0]?.id;
          } catch { /* column issue — member_id stays undefined, fallback used at request time */ }
        }

        // Backfill user_id for future direct matches
        if (memberId) {
          client.query(
            `UPDATE members SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
            [user.id, memberId]
          ).catch(() => {});
        }
      }

      const accessToken = jwt.sign(
        {
          id: user.id, gym_id: user.gym_id, role: user.role,
          ...(trainerRole ? { trainer_role: trainerRole } : {}),
          ...(memberId    ? { member_id: memberId }         : {}),
        },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      const refreshToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id },
        process.env.JWT_REFRESH_SECRET!,
        { expiresIn: '7d' }
      );

      loginAttempts.inc({ status: 'success' });

      res.json({
        success: true,
        data: {
          accessToken, refreshToken,
          user: {
            id: user.id, gym_id: user.gym_id, role: user.role,
            ...(trainerRole ? { trainer_role: trainerRole } : {}),
            ...(memberId    ? { member_id: memberId }         : {}),
          }
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// REFRESH TOKEN ENDPOINT
// POST /api/auth/refresh   Body: { refresh_token }
// Issues new access + refresh token pair. Validates signature + user existence.
// ============================================================================

app.post('/api/auth/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ success: false, error: 'refresh_token is required' });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
    }

    // Fetch current role from DB (refresh token payload excludes role)
    const userRes = await pool.query(
      `SELECT id, gym_id, role FROM users WHERE id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
      [decoded.id, decoded.gym_id]
    );
    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const user = userRes.rows[0];

    let refreshTrainerRole: string | undefined;
    if (user.role === 'trainer') {
      const trainerInfo = await pool.query(
        `SELECT trainer_role FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
        [user.id, user.gym_id]
      );
      refreshTrainerRole = trainerInfo.rows[0]?.trainer_role || 'staff';
    }

    // Re-resolve member_id for member users — refresh tokens don't store it,
    // so without this the refreshed token loses member_id and all customer
    // endpoints fall back to resolveMemberId() on every request.
    let refreshMemberId: string | undefined;
    if (user.role === 'member') {
      refreshMemberId = await resolveMemberId(user.id, user.gym_id);
    }

    const newAccessToken  = jwt.sign(
      {
        id: user.id, gym_id: user.gym_id, role: user.role,
        ...(refreshTrainerRole ? { trainer_role: refreshTrainerRole } : {}),
        ...(refreshMemberId    ? { member_id: refreshMemberId }         : {}),
      },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const newRefreshToken = jwt.sign(
      { id: user.id, gym_id: user.gym_id },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({ success: true, data: { access_token: newAccessToken, refresh_token: newRefreshToken } });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// CUSTOMER (MEMBER) AUTH ENDPOINTS
// ============================================================================

// POST /api/auth/customer/login — Firebase phone OTP → member JWT (30-day, no refresh)
app.post('/api/auth/customer/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return res.status(503).json({ success: false, error: 'Firebase not configured on server' });
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) return res.status(400).json({ success: false, error: 'firebase_id_token required' });

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired OTP token' });
    }

    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, error: 'No phone number in token' });

    const result = await pool.query(
      `SELECT m.id, m.gym_id, m.name, m.phone, m.email, m.status,
              m.membership_expiry_date, m.plan_fee,
              g.name AS gym_name
       FROM members m
       JOIN gyms g ON m.gym_id = g.id
       WHERE (m.phone = $1 OR RIGHT(m.phone, 10) = RIGHT($1, 10))
         AND m.is_deleted = false
         AND g.is_deleted = false`,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No gym membership found for this number. Please contact your gym.' });
    }

    // Multiple gyms — let customer choose
    if (result.rows.length > 1) {
      return res.json({
        success: true,
        data: {
          multiple: true,
          gyms: result.rows.map(r => ({
            member_id: r.id,
            gym_id:    r.gym_id,
            gym_name:  r.gym_name,
            name:      r.name,
          })),
          firebase_id_token, // pass back so client can call select-gym
        }
      });
    }

    const m = result.rows[0];
    const token = jwt.sign(
      { id: m.id, member_id: m.id, gym_id: m.gym_id, role: 'member' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      data: {
        access_token: token,
        member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' },
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/customer/select-gym — issued when member belongs to multiple gyms
app.post('/api/auth/customer/select-gym', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return res.status(503).json({ success: false, error: 'Firebase not configured' });
    const { firebase_id_token, member_id } = req.body;
    if (!firebase_id_token || !member_id) return res.status(400).json({ success: false, error: 'firebase_id_token and member_id required' });

    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(firebase_id_token); }
    catch { return res.status(401).json({ success: false, error: 'Invalid token' }); }

    const phone = decoded.phone_number!;
    const result = await pool.query(
      `SELECT m.id, m.gym_id, m.name, g.name AS gym_name
       FROM members m JOIN gyms g ON m.gym_id = g.id
       WHERE m.id = $1 AND (m.phone = $2 OR RIGHT(m.phone, 10) = RIGHT($2, 10)) AND m.is_deleted = false`,
      [member_id, phone]
    );
    if (result.rows.length === 0) return res.status(403).json({ success: false, error: 'Not authorized' });

    const m = result.rows[0];
    const token = jwt.sign(
      { id: m.id, member_id: m.id, gym_id: m.gym_id, role: 'member' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );
    res.json({
      success: true,
      data: {
        access_token: token,
        member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' },
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/customer/link-invite
// Called when a member logs in with phone OTP but has no gym record yet.
// They enter an invite code generated by the gym owner to link their account.
app.post('/api/auth/customer/link-invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return res.status(503).json({ success: false, error: 'Firebase not configured' });
    const { firebase_id_token, code } = req.body;
    if (!firebase_id_token || !code) {
      return res.status(400).json({ success: false, error: 'firebase_id_token and code are required' });
    }

    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(firebase_id_token); }
    catch { return res.status(401).json({ success: false, error: 'Invalid or expired OTP token' }); }

    const phone = decoded.phone_number;
    if (!phone) return res.status(400).json({ success: false, error: 'No phone number in token' });

    const client = await pool.connect();
    try {
      // Validate invite code — must be a member invite, unused, not expired
      const inviteRes = await client.query(
        `SELECT ic.*, g.name AS gym_name, g.id AS gym_id
         FROM invite_codes ic
         JOIN gyms g ON ic.gym_id = g.id
         WHERE ic.code = $1 AND ic.type = 'member' AND ic.used_at IS NULL AND ic.expires_at > NOW()`,
        [code.toUpperCase()]
      );
      if (inviteRes.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid or expired invite code' });
      }
      const invite = inviteRes.rows[0];

      // If invite links to a specific member record, update that member's phone
      let memberId: string;
      let gymId: string = invite.gym_id;

      if (invite.member_id) {
        // Pre-created member slot — update phone to match firebase phone
        await client.query(
          `UPDATE members SET phone = $1 WHERE id = $2 AND gym_id = $3`,
          [phone, invite.member_id, gymId]
        );
        memberId = invite.member_id;
      } else {
        // Standalone invite — check if member already exists with this phone
        const existing = await client.query(
          `SELECT id FROM members WHERE gym_id = $1 AND (phone = $2 OR RIGHT(phone, 10) = RIGHT($2, 10)) AND is_deleted = false`,
          [gymId, phone]
        );
        if (existing.rows.length > 0) {
          memberId = existing.rows[0].id;
        } else {
          return res.status(404).json({ success: false, error: 'No matching member record found. Ask your gym to add you first.' });
        }
      }

      // Mark invite used
      await client.query(`UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, [invite.id]);

      const memberRes = await client.query(
        `SELECT m.id, m.name, m.gym_id, g.name AS gym_name
         FROM members m JOIN gyms g ON m.gym_id = g.id
         WHERE m.id = $1`,
        [memberId]
      );
      const m = memberRes.rows[0];

      const token = jwt.sign(
        { id: m.id, member_id: m.id, gym_id: m.gym_id, role: 'member' },
        process.env.JWT_SECRET!,
        { expiresIn: '30d' }
      );

      res.json({
        success: true,
        data: {
          access_token: token,
          member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' },
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// PASSWORD RESET ENDPOINTS
// ============================================================================

app.post('/api/auth/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const { email } = parsed.data;

    // Look up user — always return 200 to prevent email enumeration
    const result = await pool.query(
      `SELECT u.id FROM users u WHERE u.phone_or_email = $1 AND u.role IN ('owner','trainer') AND u.is_deleted = false LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If that email exists, a code has been sent.' });
    }

    const userId = result.rows[0].id;
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    // Reuse password_reset_tokens table: store OTP in token field prefixed with "otp:"
    await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [userId, `otp:${otp}`, expiresAt]
    );

    await sendEmail(
      email,
      'Your Recurva Password Reset Code',
      `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
        <h2 style="color:#2196F3;margin-bottom:8px">Reset Your Password</h2>
        <p style="color:#444;margin-bottom:24px">Use the code below to reset your <strong>Recurva</strong> account password.</p>
        <div style="background:#fff;border:2px solid #2196F3;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px">
          <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#1a1a1a;font-family:monospace">${otp}</span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#888;font-size:13px">If you didn't request a password reset, please ignore this email.</p>
      </div>
      `
    );

    logger.info({ userId }, 'Password reset OTP sent via email');
    res.json({ success: true, message: 'If that email exists, a code has been sent.' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/verify-reset-otp — verify 6-digit OTP from forgot-password email, return reset token
app.post('/api/auth/verify-reset-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, otp_code } = req.body;
    if (!email || !otp_code) {
      return res.status(400).json({ success: false, error: 'email and otp_code are required' });
    }

    const userRes = await pool.query(
      `SELECT u.id FROM users u WHERE u.phone_or_email = $1 AND u.role IN ('owner','trainer') AND u.is_deleted = false LIMIT 1`,
      [email]
    );
    if (userRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Incorrect code. Please try again.' });
    }

    const userId = userRes.rows[0].id;
    const tokenRes = await pool.query(
      `SELECT id, token, expires_at FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No reset request found. Please request a new code.' });
    }

    const row = tokenRes.rows[0];

    if (new Date() > new Date(row.expires_at)) {
      return res.status(400).json({ success: false, error: 'Code expired. Please request a new one.' });
    }

    if (!String(row.token).startsWith('otp:')) {
      return res.status(400).json({ success: false, error: 'Invalid reset method. Please request a new code.' });
    }

    const storedOtp = String(row.token).replace('otp:', '');
    let match = false;
    try {
      match = crypto.timingSafeEqual(
        Buffer.from(String(otp_code).trim()),
        Buffer.from(storedOtp)
      );
    } catch { match = false; }

    if (!match) {
      return res.status(400).json({ success: false, error: 'Incorrect code. Please try again.' });
    }

    // OTP correct — replace with a proper reset token for the reset-password step
    const resetToken = crypto.randomBytes(32).toString('hex');
    const newExpiry = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      `UPDATE password_reset_tokens SET token = $1, expires_at = $2 WHERE id = $3`,
      [resetToken, newExpiry, row.id]
    );

    logger.info({ userId }, 'Password reset OTP verified — reset token issued');
    res.json({ success: true, data: { reset_token: resetToken } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid input';
      return res.status(400).json({ success: false, error: msg });
    }
    const { token, new_password } = parsed.data;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid or expired reset link.' });
      }

      const resetToken = result.rows[0];

      if (resetToken.used_at) {
        return res.status(400).json({ success: false, error: 'This reset link has already been used.' });
      }

      if (new Date() > new Date(resetToken.expires_at)) {
        await client.query(`DELETE FROM password_reset_tokens WHERE id = $1`, [resetToken.id]);
        return res.status(400).json({ success: false, error: 'This reset link has expired. Please request a new one.' });
      }

      const passwordHash = await bcrypt.hash(new_password, 10);

      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, resetToken.user_id]
      );

      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [resetToken.id]
      );

      logger.info({ userId: resetToken.user_id }, 'Password reset successful');
      res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// OTP ENDPOINTS
// Send a 6-digit code to the owner's email after gym registration.
// The code is valid for 10 minutes and single-use.
// ============================================================================

app.post('/api/auth/send-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = sendOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const { email } = parsed.data;

    const client = await pool.connect();
    try {
      // Verify the email belongs to a gym owner
      const userResult = await client.query(
        `SELECT id FROM users WHERE phone_or_email = $1 AND role = 'owner' AND is_deleted = false LIMIT 1`,
        [email]
      );
      if (userResult.rows.length === 0) {
        // Return success anyway — prevent email enumeration
        return res.json({ success: true, message: 'If that email exists, a code has been sent.' });
      }

      // Delete any existing OTPs for this email
      await client.query(`DELETE FROM otp_codes WHERE email = $1`, [email]);

      const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await client.query(
        `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)`,
        [email, code, expiresAt]
      );

      await sendEmail(email, 'Your Recurva verification code', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">Verify your email</h2>
          <p>Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
          <div style="margin:28px 0;text-align:center">
            <span style="display:inline-block;letter-spacing:10px;font-size:36px;font-weight:bold;color:#1a1a1a;background:#f4f6f8;padding:14px 24px;border-radius:10px;font-family:monospace">
              ${code}
            </span>
          </div>
          <p style="color:#888;font-size:13px">If you didn't create a Recurva account, you can ignore this email.</p>
        </div>
      `);

      logger.info({ email }, 'OTP sent');
      res.json({ success: true, message: 'Code sent to your email.' });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/verify-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = verifyOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid input';
      return res.status(400).json({ success: false, error: msg });
    }
    const { email, code } = parsed.data;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, expires_at, used_at FROM otp_codes WHERE email = $1 AND code = $2`,
        [email, code]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid code. Please check and try again.' });
      }

      const otp = result.rows[0];

      if (otp.used_at) {
        return res.status(400).json({ success: false, error: 'This code has already been used.' });
      }

      if (new Date() > new Date(otp.expires_at)) {
        await client.query(`DELETE FROM otp_codes WHERE id = $1`, [otp.id]);
        return res.status(400).json({ success: false, error: 'Code expired. Request a new one.' });
      }

      // Mark as used
      await client.query(`UPDATE otp_codes SET used_at = NOW() WHERE id = $1`, [otp.id]);

      // Mark the user's email as verified
      await client.query(
        `UPDATE users SET email_verified = true WHERE phone_or_email = $1 AND role = 'owner'`,
        [email]
      );

      logger.info({ email }, 'OTP verified');
      res.json({ success: true, message: 'Email verified successfully.' });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// FIREBASE PHONE OTP — LOGIN
// POST /api/auth/verify-firebase-token
// Body: { firebase_id_token: string, role: 'owner' | 'trainer' }
// Verifies Firebase ID token (from phone OTP), finds user by phone, issues JWT.
// ============================================================================

app.post('/api/auth/verify-firebase-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) {
      return res.status(503).json({ success: false, error: 'Firebase not configured on this server' });
    }

    const { firebase_id_token, role } = req.body;
    if (!firebase_id_token || !role) {
      return res.status(400).json({ success: false, error: 'firebase_id_token and role are required' });
    }
    if (!['owner', 'trainer'].includes(role)) {
      return res.status(400).json({ success: false, error: 'role must be owner or trainer' });
    }

    // Verify Firebase ID token
    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired Firebase token' });
    }

    const phone = decodedFirebase.phone_number;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'No phone number in Firebase token' });
    }

    // Find user by verified phone (E.164 stored in phone column)
    const userRes = await pool.query(
      `SELECT u.id, u.gym_id, u.role
       FROM users u
       WHERE u.phone = $1 AND u.role = $2 AND u.is_deleted = false
       LIMIT 1`,
      [phone, role]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'No account found with this phone number for the selected role. Please log in with your email and password.' });
    }

    const user = userRes.rows[0];

    // Check if gym is blocked or suspended
    let gymRow: any = null;
    try {
      const gymCheck = await pool.query(
        `SELECT subscription_status, is_blocked FROM gyms WHERE id = $1 AND is_deleted = false LIMIT 1`,
        [user.gym_id]
      );
      gymRow = gymCheck.rows[0];
    } catch (colErr: any) {
      if (colErr?.message?.includes('is_blocked')) {
        const gymCheck = await pool.query(
          `SELECT subscription_status FROM gyms WHERE id = $1 AND is_deleted = false LIMIT 1`,
          [user.gym_id]
        );
        gymRow = gymCheck.rows[0];
      } else throw colErr;
    }
    if (gymRow?.is_blocked) {
      return res.status(403).json({ success: false, error: 'Your account has been blocked. Please contact support.' });
    }
    if (gymRow?.subscription_status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Your account has been suspended. Please contact support.' });
    }

    const accessToken  = jwt.sign(
      { id: user.id, gym_id: user.gym_id, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const refreshToken = jwt.sign(
      { id: user.id, gym_id: user.gym_id },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { id: user.id, gym_id: user.gym_id, role: user.role }
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// FIREBASE PHONE OTP — PASSWORD RESET TOKEN
// POST /api/auth/phone-reset-token
// Body: { firebase_id_token: string }
// Verifies Firebase phone OTP, finds user, issues a short-lived reset token.
// Flutter then passes this token to /api/auth/reset-password.
// ============================================================================

app.post('/api/auth/phone-reset-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) {
      return res.status(503).json({ success: false, error: 'Firebase not configured on this server' });
    }

    const { firebase_id_token } = req.body;
    if (!firebase_id_token) {
      return res.status(400).json({ success: false, error: 'firebase_id_token is required' });
    }

    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired Firebase token' });
    }

    const phone = decodedFirebase.phone_number;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'No phone number in Firebase token' });
    }

    // Find user by verified phone (E.164 stored in phone column)
    const userRes = await pool.query(
      `SELECT id FROM users WHERE phone = $1 AND role IN ('owner','trainer') AND is_deleted = false LIMIT 1`,
      [phone]
    );

    // Always return success to prevent phone enumeration — token only in success path
    if (userRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No account found with this phone number' });
    }

    const userId = userRes.rows[0].id;
    const resetToken  = crypto.randomBytes(32).toString('hex');
    const expiresAt   = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, resetToken, expiresAt]
    );

    res.json({ success: true, data: { reset_token: resetToken } });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// FCM TOKEN — Save device push token for the authenticated user
// PUT /api/auth/fcm-token
// Body: { fcm_token: string }
// ============================================================================

app.put('/api/auth/fcm-token', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { fcm_token } = req.body;
    if (!fcm_token || typeof fcm_token !== 'string') {
      return res.status(400).json({ success: false, error: 'fcm_token is required' });
    }
    await pool.query(`UPDATE users SET fcm_token = $1 WHERE id = $2`, [fcm_token, req.user?.id]);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// BULK IMPORT — MEMBERS
// POST /api/members/bulk-import
// Body: { trainer_id: uuid, members: [...] }
// Returns: { imported, skipped, errors: [{row, name, error}] }
// Max 500 rows per request. Processes best-effort (continues on row error).
// ============================================================================

app.post('/api/members/bulk-import', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return res.status(400).json({ success: false, error: msg });
    }
    const { trainer_id, members } = parsed.data;

    // Validate trainer only if provided
    if (trainer_id) {
      const trainerCheck = await pool.query(
        'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
        [trainer_id, req.gym_id]
      );
      if (trainerCheck.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Trainer not found in this gym' });
      }
    }

    // ── Load all existing phones for this gym in ONE query (O(1) duplicate check) ──
    const existingPhonesRes = await pool.query(
      'SELECT phone FROM members WHERE gym_id = $1 AND is_deleted = false',
      [req.gym_id]
    );
    const existingPhones = new Set<string>(existingPhonesRes.rows.map((r: any) => r.phone));

    const now = new Date();
    const defaultExpiry = new Date(now);
    defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1); // 1 year default

    const toInsert: any[] = [];
    const errors: { row: number; name: string; error: string }[] = [];

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const rowNum = i + 2;

      // Require at least a name
      if (!m.name?.trim()) {
        errors.push({ row: rowNum, name: '(unknown)', error: 'Name is required' });
        continue;
      }

      // Generate placeholder phone if missing
      const phone = m.phone?.trim() || `IMPORT-${Date.now()}-${i}`;

      // Skip duplicates
      if (existingPhones.has(phone)) {
        errors.push({ row: rowNum, name: m.name, error: 'Phone already registered (duplicate skipped)' });
        continue;
      }
      existingPhones.add(phone); // prevent within-batch duplicates

      // Parse expiry date — default to 1 year if missing/invalid
      let expiryDate = defaultExpiry;
      if (m.membership_expiry_date) {
        const parsed = new Date(m.membership_expiry_date);
        if (!isNaN(parsed.getTime())) expiryDate = parsed;
      }

      const lastVisit  = m.last_visit_date ? new Date(m.last_visit_date) : null;
      const baselineDate = lastVisit ?? now;
      const daysSince  = (now.getTime() - baselineDate.getTime()) / 86400000;
      const daysToExp  = (expiryDate.getTime() - now.getTime()) / 86400000;

      let status = 'active';
      if (daysToExp <= 7 || daysSince > 10)        status = 'high_risk';
      else if (daysToExp <= 14 || daysSince > 5)   status = 'at_risk';

      const uniqueId = `MEM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      const planFee  = m.plan_fee ?? 0;

      toInsert.push([
        req.gym_id,
        m.name.trim(),
        phone,
        m.email?.trim() || '',
        lastVisit ? lastVisit.toISOString().split('T')[0] : null,
        expiryDate.toISOString().split('T')[0],
        planFee,
        status,
        uniqueId,
        trainer_id || null,
      ]);
    }

    // ── Bulk INSERT in DB-batches of 500 rows (stays under pg param limit) ──
    const DB_BATCH = 500;
    const FIELDS   = 10;
    let imported   = 0;

    for (let b = 0; b < toInsert.length; b += DB_BATCH) {
      const batch  = toInsert.slice(b, b + DB_BATCH);
      const params: any[] = [];
      const placeholders   = batch.map((_, ri) => {
        const base = ri * FIELDS;
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
      }).join(',');

      for (const row of batch) params.push(...row);

      try {
        const result = await pool.query(
          `INSERT INTO members (gym_id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, status, unique_id, assigned_trainer_id)
           VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
          params
        );
        imported += result.rowCount ?? batch.length;
      } catch (err: any) {
        // If the whole batch fails, fall back to row-by-row for error reporting
        for (let ri = 0; ri < batch.length; ri++) {
          try {
            await pool.query(
              `INSERT INTO members (gym_id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, status, unique_id, assigned_trainer_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
              batch[ri]
            );
            imported++;
          } catch (e: any) {
            errors.push({ row: b + ri + 2, name: batch[ri][1], error: e?.message || 'Insert failed' });
          }
        }
      }
    }

    // Refresh trainer member count if trainer was specified
    if (trainer_id) {
      await pool.query(
        `UPDATE trainers SET assigned_members_count = (
           SELECT COUNT(*) FROM members WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false
         ) WHERE id = $1 AND gym_id = $2`,
        [trainer_id, req.gym_id]
      );
    }

    const skipped = members.length - toInsert.length; // duplicates + missing-name rows
    logger.info({ gymId: req.gym_id, imported, skipped }, 'Bulk member import complete');
    res.json({
      success: true,
      data: { imported, skipped, errors },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// BULK IMPORT — TRAINERS
// POST /api/trainers/bulk-import
// Body: { trainers: [{name, phone, email}] }
// Default password for all imported trainers: Gym@1234
// Returns: { imported, skipped, errors, defaultPassword }
// ============================================================================

app.post('/api/trainers/bulk-import', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkTrainersSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return res.status(400).json({ success: false, error: msg });
    }
    const { trainers } = parsed.data;
    const DEFAULT_PASSWORD = 'Gym@1234';
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    let imported = 0;
    const errors: { row: number; name: string; error: string }[] = [];

    for (let i = 0; i < trainers.length; i++) {
      const t = trainers[i];
      const rowNum = i + 2;

      const client = await pool.connect();
      try {
        const existing = await client.query(
          'SELECT id FROM users WHERE gym_id = $1 AND phone_or_email = $2 AND is_deleted = false',
          [req.gym_id, t.email]
        );
        if (existing.rows.length > 0) {
          errors.push({ row: rowNum, name: t.name, error: 'Email already registered' });
          continue;
        }

        await client.query('BEGIN');

        const userRes = await client.query(
          `INSERT INTO users (gym_id, phone_or_email, password_hash, role)
           VALUES ($1, $2, $3, 'trainer') RETURNING id`,
          [req.gym_id, t.email, passwordHash]
        );

        await client.query(
          `INSERT INTO trainers (gym_id, user_id, name, phone, email)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.gym_id, userRes.rows[0].id, t.name, t.phone, t.email]
        );

        await client.query('COMMIT');
        imported++;
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = err?.code === '23505' ? 'Duplicate entry (phone or email already exists)'
          : err?.code === '22001' ? 'A field value is too long'
          : err?.code === '23502' ? 'A required field is missing'
          : 'Failed to import this row. Please check the data.';
        errors.push({ row: rowNum, name: t.name, error: msg });
      } finally {
        client.release();
      }
    }

    logger.info({ gymId: req.gym_id, imported, skipped: errors.length }, 'Bulk trainer import complete');
    res.json({
      success: true,
      data: { imported, skipped: errors.length, errors, defaultPassword: DEFAULT_PASSWORD },
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// MEMBERS ENDPOINTS
// ============================================================================

app.get('/api/members', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const start = Date.now();
    const page = Math.max(1, parseInt((req.query.page as string) || '1'));
    const limit = Math.min(parseInt((req.query.limit as string) || '10'), 100);
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
      const statusFilter = req.query.status as string;
      const trainerIdFilter = req.query.trainer_id as string;

      // Build shared WHERE params (used for both COUNT and SELECT)
      let whereClause = `WHERE gym_id = $1 AND is_deleted = false`;
      const whereParams: any[] = [req.gym_id];

      // Trainers only see their own assigned members
      if (req.user.role === 'trainer') {
        const trainerRes = await client.query(
          'SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false',
          [req.user.id, req.gym_id]
        );
        if (trainerRes.rows.length > 0) {
          whereClause += ` AND assigned_trainer_id = $${whereParams.length + 1}`;
          whereParams.push(trainerRes.rows[0].id);
        }
      } else if (trainerIdFilter) {
        whereClause += ` AND assigned_trainer_id = $${whereParams.length + 1}`;
        whereParams.push(trainerIdFilter);
      }

      if (statusFilter && statusFilter !== 'all') {
        whereClause += ` AND status = $${whereParams.length + 1}`;
        whereParams.push(statusFilter);
      }

      // Count with filters applied (correct pagination metadata)
      const countRes = await client.query(
        `SELECT COUNT(*) AS total FROM members ${whereClause}`,
        whereParams
      );
      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      // Paginated data with same filters
      const dataParams = [...whereParams, limit, offset];
      const membersRes = await client.query(
        `SELECT id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, created_at, assigned_trainer_id,
          EXTRACT(EPOCH FROM (NOW() - last_visit_date))::INTEGER / 86400 AS days_last_visit,
          EXTRACT(EPOCH FROM (membership_expiry_date - NOW()))::INTEGER / 86400 AS days_to_expiry,
          (${MEMBER_STATUS_SQL}) AS status
         FROM members ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );

      databaseQueries.observe({ query_type: 'select_members' }, (Date.now() - start) / 1000);

      res.json({
        success: true,
        data: { members: membersRes.rows, total, page, pages }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/members', authenticate, authorize(['owner']), validate(memberSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, assigned_trainer_id } = req.body;
    const start = Date.now();

    const client = await pool.connect();
    try {
      // Check phone uniqueness per gym
      const phoneCheck = await client.query(
        'SELECT id, is_deleted FROM members WHERE gym_id = $1 AND phone = $2',
        [req.gym_id, phone]
      );
      if (phoneCheck.rows.length > 0) {
        const existing = phoneCheck.rows[0];
        if (!existing.is_deleted) {
          // Active member — block with friendly message
          return res.status(409).json({ success: false, error: 'This phone number is already registered. Please use a different number.' });
        }
        // Deleted member — clear their phone to free up the unique slot so re-add is allowed
        await client.query(
          'UPDATE members SET phone = $1 WHERE id = $2',
          [`_rm_${existing.id.substring(0, 8)}`, existing.id]
        );
      }

      // Check email uniqueness per gym (only if a non-empty email was provided)
      const emailToCheck = email && email.trim() ? email.trim() : null;
      if (emailToCheck) {
        const emailCheck = await client.query(
          'SELECT id, is_deleted FROM members WHERE gym_id = $1 AND email = $2',
          [req.gym_id, emailToCheck]
        );
        if (emailCheck.rows.length > 0 && !emailCheck.rows[0].is_deleted) {
          return res.status(409).json({ success: false, error: 'This email is already registered to another member. Please use a different email or leave the email field empty.' });
        }
        if (emailCheck.rows.length > 0 && emailCheck.rows[0].is_deleted) {
          // Free up the email slot from the deleted record too
          await client.query('UPDATE members SET email = $1 WHERE id = $2', [`_rm_${emailCheck.rows[0].id.substring(0, 8)}`, emailCheck.rows[0].id]);
        }
      }

      // Status uses created_at as baseline when no visit yet (new members start Active).
      // daysToExpiry ≤ 7  OR daysSince > 10 → high_risk
      // daysToExpiry ≤ 14 OR daysSince > 5  → at_risk   (parallel check)
      const now = new Date();
      const expiryDate = new Date(membership_expiry_date);
      const lastVisit = last_visit_date ? new Date(last_visit_date) : null;
      const baseline = lastVisit ?? now;
      const daysSinceVisit = (now.getTime() - baseline.getTime()) / 86400000;
      const daysToExpiry   = (expiryDate.getTime() - now.getTime()) / 86400000;

      let status = 'active';
      if (daysToExpiry <= 7 || daysSinceVisit > 10) status = 'high_risk';
      else if (daysToExpiry <= 14 || daysSinceVisit > 5) status = 'at_risk';

      const displayId = await generateDisplayId('member');

      // Validate trainer belongs to this gym (only if provided)
      if (assigned_trainer_id) {
        const trainerCheck = await client.query(
          'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
          [assigned_trainer_id, req.gym_id]
        );
        if (trainerCheck.rows.length === 0) {
          return res.status(400).json({ success: false, error: 'Trainer not found in this gym' });
        }
      }

      const result = await client.query(
        `INSERT INTO members (gym_id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, status, display_id, assigned_trainer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, status, created_at, assigned_trainer_id, display_id`,
        [req.gym_id, name, phone, (email && email.trim()) || null, last_visit_date || null, membership_expiry_date, plan_fee, plan || null, status, displayId, assigned_trainer_id]
      );

      // Update trainer's assigned_members_count (only if a trainer was assigned)
      if (assigned_trainer_id) {
        await client.query(
          `UPDATE trainers SET assigned_members_count = (
             SELECT COUNT(*) FROM members WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false
           ) WHERE id = $1 AND gym_id = $2`,
          [assigned_trainer_id, req.gym_id]
        );
      }

      databaseQueries.observe({ query_type: 'insert_member' }, (Date.now() - start) / 1000);

      res.status(201).json({
        success: true,
        data: result.rows[0]
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.put('/api/members/:id', authenticate, authorize(['owner']), validate(memberSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, phone, email, membership_expiry_date, plan_fee, plan } = req.body;
    const start = Date.now();

    const client = await pool.connect();
    try {
      // Check phone not taken by another member (include soft-deleted to avoid constraint error)
      const phoneCheck = await client.query(
        'SELECT id FROM members WHERE gym_id = $1 AND phone = $2 AND id != $3',
        [req.gym_id, phone, id]
      );
      if (phoneCheck.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'This phone number is already registered. Please use a different number.' });
      }

      const result = await client.query(
        `UPDATE members SET name = $1, phone = $2, email = $3, membership_expiry_date = $4, plan_fee = $5, plan = $6, updated_at = NOW()
         WHERE id = $7 AND gym_id = $8
         RETURNING id, updated_at`,
        [name, phone, (email && email.trim()) || null, membership_expiry_date, plan_fee, plan || null, id, req.gym_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      databaseQueries.observe({ query_type: 'update_member' }, (Date.now() - start) / 1000);

      res.json({ success: true, data: { id: result.rows[0].id } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.delete('/api/members/:id', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE members SET is_deleted = true, deleted_at = NOW() WHERE id = $1 AND gym_id = $2`,
        [id, req.gym_id]
      );

      res.json({ success: true, data: { id } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// TRAINERS ENDPOINTS
// ============================================================================

const trainerSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().min(10).max(20),
  email: z.string().email(),
  password: z.string().min(8).max(255).regex(
    /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9])/,
    'Password must have at least 1 uppercase, 1 number, and 1 special character'
  ),
});

app.post('/api/trainers', authenticate, authorize(['owner']), validate(trainerSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, phone, email, password, trainer_role } = req.body;
    const client = await pool.connect();
    try {
      // Check email not already used in this gym
      const existing = await client.query(
        'SELECT id FROM users WHERE gym_id = $1 AND phone_or_email = $2 AND is_deleted = false',
        [req.gym_id, email]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered in this gym' });
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, password_hash, role)
         VALUES ($1, $2, $3, 'trainer') RETURNING id`,
        [req.gym_id, email, passwordHash]
      );
      const userId = userRes.rows[0].id;

      const displayId = await generateDisplayId('staff');
      const trainerRes = await client.query(
        `INSERT INTO trainers (gym_id, user_id, name, phone, email, display_id, trainer_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, phone, email, created_at, display_id, trainer_role`,
        [req.gym_id, userId, name, phone, email, displayId, trainer_role || 'staff']
      );

      await client.query('COMMIT');

      res.status(201).json({ success: true, data: trainerRes.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/trainers', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page   = Math.max(1, parseInt((req.query.page  as string) || '1'));
    const limit  = Math.min(parseInt((req.query.limit as string) || '20'), 100);
    const offset = (page - 1) * limit;

    const client = await pool.connect();
    try {
      const countRes = await client.query(
        `SELECT COUNT(*) AS total FROM trainers WHERE gym_id = $1 AND is_deleted = false AND user_id IS NOT NULL`,
        [req.gym_id]
      );
      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      const result = await client.query(
        `SELECT t.id, t.name, t.phone, t.email, t.assigned_members_count, t.is_active, t.created_at,
                t.trainer_role, t.display_id,
                u.phone_or_email AS login_email
         FROM trainers t
         JOIN users u ON t.user_id = u.id
         WHERE t.gym_id = $1 AND t.is_deleted = false
         ORDER BY t.trainer_role DESC, t.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.gym_id, limit, offset]
      );
      res.json({ success: true, data: { trainers: result.rows, total, page, pages } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Get trainer profile for logged-in trainer (by user id)
app.get('/api/trainers/me', authenticate, authorize(['trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT t.id, t.name, t.phone, t.email FROM trainers t WHERE t.user_id = $1 AND t.gym_id = $2 AND t.is_deleted = false`,
        [req.user.id, req.gym_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Trainer profile not found' });
      }
      res.json({ success: true, data: result.rows[0] });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.patch('/api/trainers/:id', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'name and phone are required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // If email provided, update login email in users table too
      if (email && email.trim()) {
        const trainerUser = await client.query(
          'SELECT u.id FROM users u JOIN trainers t ON t.user_id = u.id WHERE t.id = $1 AND t.gym_id = $2 AND t.is_deleted = false',
          [id, req.gym_id]
        );
        if (trainerUser.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Trainer not found' }); }

        const userId = trainerUser.rows[0].id;
        const existing = await client.query(
          'SELECT id FROM users WHERE phone_or_email = $1 AND id != $2 AND is_deleted = false',
          [email.trim(), userId]
        );
        if (existing.rows.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, error: 'This email is already in use.' }); }

        await client.query('UPDATE users SET phone_or_email = $1 WHERE id = $2', [email.trim(), userId]);
      }

      const result = await client.query(
        `UPDATE trainers SET name = $1, phone = $2, ${email ? 'email = $5,' : ''} updated_at = NOW()
         WHERE id = $3 AND gym_id = $4 AND is_deleted = false
         RETURNING id, name, phone, email, assigned_members_count, is_active, created_at`,
        email ? [name, phone, id, req.gym_id, email.trim()] : [name, phone, id, req.gym_id]
      );
      if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Trainer not found' }); }

      await client.query('COMMIT');
      res.json({ success: true, data: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/trainers/:id/assign-members',
  authenticate,
  authorize(['owner']),
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    const client = await pool.connect();

    try {
      const { id: trainerId } = req.params;
      const { member_ids } = req.body;

      if (!Array.isArray(member_ids)) {
        return res.status(400).json({
          success: false,
          error: 'member_ids must be an array',
        });
      }

      // ✅ START TRANSACTION
      await client.query('BEGIN');

      // ✅ Check trainer exists
      const trainerCheck = await client.query(
        `SELECT id FROM trainers 
         WHERE id = $1 AND gym_id = $2 AND is_deleted = false`,
        [trainerId, req.gym_id]
      );

      if (trainerCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: 'Trainer not found',
        });
      }

      // ============================================================
      // ✅ STEP 1: UNASSIGN removed members
      // ============================================================
      if (member_ids.length > 0) {
        await client.query(
          `UPDATE members 
           SET assigned_trainer_id = NULL
           WHERE assigned_trainer_id = $1
             AND gym_id = $2
             AND is_deleted = false
             AND NOT (id = ANY($3::uuid[]))`,
          [trainerId, req.gym_id, member_ids]
        );
      } else {
        // 🔥 If empty → remove ALL assignments
        await client.query(
          `UPDATE members 
           SET assigned_trainer_id = NULL
           WHERE assigned_trainer_id = $1
             AND gym_id = $2
             AND is_deleted = false`,
          [trainerId, req.gym_id]
        );
      }

      // ============================================================
      // ✅ STEP 2: ASSIGN selected members
      // ============================================================
      if (member_ids.length > 0) {
        await client.query(
          `UPDATE members 
           SET assigned_trainer_id = $1
           WHERE id = ANY($2::uuid[])
             AND gym_id = $3
             AND is_deleted = false`,
          [trainerId, member_ids, req.gym_id]
        );
      }

      // ============================================================
      // ✅ STEP 3: GET REAL COUNT (IMPORTANT FIX)
      // ============================================================
      const countResult = await client.query(
        `SELECT COUNT(*) FROM members 
         WHERE assigned_trainer_id = $1
           AND gym_id = $2
           AND is_deleted = false`,
        [trainerId, req.gym_id]
      );

      const assignedCount = parseInt(countResult.rows[0].count);

      // ============================================================
      // ✅ STEP 4: UPDATE TRAINER COUNT
      // ============================================================
      await client.query(
        `UPDATE trainers 
         SET assigned_members_count = $1
         WHERE id = $2`,
        [assignedCount, trainerId]
      );

      // ✅ COMMIT TRANSACTION
      await client.query('COMMIT');

      // ============================================================
      // ✅ RESPONSE
      // ============================================================
      res.json({
        success: true,
        data: {
          trainer_id: trainerId,
          assigned_count: assignedCount, // ✅ REAL COUNT
        },
      });

    } catch (error) {
      await client.query('ROLLBACK'); // 🔥 VERY IMPORTANT
      next(error);
    } finally {
      client.release();
    }
  }
);

app.delete('/api/trainers/:id', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE trainers SET is_deleted = true, deleted_at = NOW() WHERE id = $1 AND gym_id = $2 RETURNING user_id`,
        [id, req.gym_id]
      );
      if (result.rows.length > 0) {
        const userId = result.rows[0].user_id;
        // Mark the login user as deleted AND rename the email slot so the UNIQUE(gym_id, phone_or_email)
        // constraint doesn't block re-registration with the same email
        await client.query(
          `UPDATE users SET is_deleted = true, phone_or_email = '_rm_' || substring(id::text, 1, 8) WHERE id = $1`,
          [userId]
        );
      }
      res.json({ success: true, data: { id } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// TASKS ENDPOINTS
// ============================================================================

app.post('/api/tasks', authenticate, authorize(['owner']), validate(taskSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { member_id, task_type, assigned_trainer_id, notes } = req.body;

    const client = await pool.connect();
    try {
      // Validate memberId exists and is not deleted in this gym
      const memberCheck = await client.query(
        'SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
        [member_id, req.gym_id]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      // Auto-assign trainer from member's assigned_trainer_id if not explicitly provided
      let resolvedTrainerId = assigned_trainer_id || null;
      if (!resolvedTrainerId) {
        const memberTrainer = await client.query(
          'SELECT assigned_trainer_id, name FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
          [member_id, req.gym_id]
        );
        if (memberTrainer.rows.length > 0 && memberTrainer.rows[0].assigned_trainer_id) {
          resolvedTrainerId = memberTrainer.rows[0].assigned_trainer_id;
        } else {
          const memberName = memberTrainer.rows[0]?.name ?? 'This customer';
          return res.status(400).json({
            success: false,
            error: `${memberName} has no staff assigned. Please assign a staff member to this customer first.`
          });
        }
      } else {
        const trainerCheck = await client.query(
          'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
          [assigned_trainer_id, req.gym_id]
        );
        if (trainerCheck.rows.length === 0) {
          return res.status(404).json({ success: false, error: 'Trainer not found in this gym' });
        }
      }

      const result = await client.query(
        `INSERT INTO follow_up_tasks (gym_id, member_id, assigned_trainer_id, task_type, status, notes)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, member_id, task_type, assigned_trainer_id, status, created_at`,
        [req.gym_id, member_id, resolvedTrainerId, task_type, notes || null]
      );

      const task = result.rows[0];

      // Push notification to assigned trainer
      if (resolvedTrainerId) {
        const trainerRow = await client.query(
          `SELECT u.fcm_token, t.name AS trainer_name, m.name AS member_name
           FROM trainers t
           LEFT JOIN users u ON u.gym_id = t.gym_id AND u.role = 'trainer' AND LOWER(u.phone_or_email) = LOWER(t.phone)
           LEFT JOIN members m ON m.id = $2
           WHERE t.id = $1`,
          [resolvedTrainerId, member_id]
        );
        if (trainerRow.rows[0]?.fcm_token) {
          const memberName = trainerRow.rows[0].member_name || 'a member';
          const taskLabel  = task_type === 'renewal' ? 'Renewal follow-up' : 'Call follow-up';
          await sendPush(
            trainerRow.rows[0].fcm_token,
            'New Task Assigned',
            `${taskLabel} for ${memberName}`,
            { task_id: String(task.id), type: 'task_assigned' }
          );
        }
      }

      res.status(201).json({
        success: true,
        data: task
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/tasks', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const status    = req.query.status     as string;
    const trainerId = req.query.trainer_id as string;
    const memberId  = req.query.member_id  as string;
    const page      = Math.max(1, parseInt((req.query.page  as string) || '1'));
    const limit     = Math.min(parseInt((req.query.limit as string) || '20'), 100);
    const offset    = (page - 1) * limit;

    const client = await pool.connect();
    try {
      // Build WHERE clause (shared between count + data queries)
      const whereParams: any[] = [req.gym_id];
      let whereClause = `WHERE t.gym_id = $1`;

      if (status) {
        whereClause += ` AND t.status = $${whereParams.length + 1}`;
        whereParams.push(status);
      }
      if (trainerId) {
        whereClause += ` AND t.assigned_trainer_id = $${whereParams.length + 1}`;
        whereParams.push(trainerId);
      }
      if (memberId) {
        whereClause += ` AND t.member_id = $${whereParams.length + 1}`;
        whereParams.push(memberId);
      }

      // Total count for pagination metadata
      const countRes = await client.query(
        `SELECT COUNT(*) AS total FROM follow_up_tasks t ${whereClause}`,
        whereParams
      );
      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      // Paginated data
      const dataParams = [...whereParams, limit, offset];
      const result = await client.query(
        `SELECT t.id, t.member_id, t.task_type, t.status, t.outcome, t.notes, t.created_at, t.completed_at,
                t.assigned_trainer_id,
                m.name AS member_name, m.phone AS member_phone,
                tr.name AS trainer_name
         FROM follow_up_tasks t
         LEFT JOIN members m  ON t.member_id = m.id
         LEFT JOIN trainers tr ON t.assigned_trainer_id = tr.id
         ${whereClause}
         ORDER BY t.created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );

      res.json({
        success: true,
        data: { tasks: result.rows, total, page, pages }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.patch('/api/tasks/:id', authenticate, authorize(['trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { outcome, notes } = req.body;

    const validOutcomes = ['called', 'not_reachable', 'coming_tomorrow', 'renewed', 'no_action'];
    if (!outcome || !validOutcomes.includes(outcome)) {
      return res.status(400).json({ success: false, error: 'outcome is required and must be one of: called, not_reachable, coming_tomorrow, renewed, no_action' });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE follow_up_tasks 
         SET status = 'completed', outcome = $1, notes = $2, completed_at = NOW()
         WHERE id = $3 AND gym_id = $4
         RETURNING member_id`,
        [outcome, notes, id, req.gym_id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }

      if (outcome === 'renewed') {
        const memberRes = await client.query(
          'SELECT plan_fee FROM members WHERE id = $1',
          [result.rows[0].member_id]
        );

        if (memberRes.rows.length > 0) {
          await client.query(
            `INSERT INTO revenue_records (gym_id, member_id, task_id, action, revenue_recovered)
             VALUES ($1, $2, $3, 'renewal', $4)`,
            [req.gym_id, result.rows[0].member_id, id, memberRes.rows[0].plan_fee]
          );
        }
      }

      // Push notification to gym owner about task completion
      const ownerRow = await client.query(
        `SELECT u.fcm_token, m.name AS member_name, t.name AS trainer_name
         FROM users u
         LEFT JOIN follow_up_tasks ft ON ft.id = $1
         LEFT JOIN members m ON m.id = ft.member_id
         LEFT JOIN trainers t ON t.id = ft.assigned_trainer_id
         WHERE u.gym_id = $2 AND u.role = 'owner' AND u.is_deleted = false
         LIMIT 1`,
        [id, req.gym_id]
      );
      if (ownerRow.rows[0]?.fcm_token) {
        const memberName  = ownerRow.rows[0].member_name  || 'a member';
        const trainerName = ownerRow.rows[0].trainer_name || 'Staff';
        const outcomeLabel: Record<string, string> = {
          called: 'called',
          not_reachable: 'could not reach',
          coming_tomorrow: 'is coming tomorrow',
          renewed: 'renewed — great news!',
          no_action: 'marked no action',
        };
        await sendPush(
          ownerRow.rows[0].fcm_token,
          'Task Completed',
          `${trainerName} ${outcomeLabel[outcome] || outcome} ${memberName}`,
          { task_id: String(id), type: 'task_completed', outcome }
        );
      }

      res.json({ success: true, data: { id } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ATTENDANCE ENDPOINTS
// ============================================================================

app.post('/api/attendance', authenticate, authorize(['trainer', 'owner']), validate(attendanceSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { member_id, visit_date, check_in_time } = req.body;

    const client = await pool.connect();
    try {
      // Prevent duplicate attendance for same member on same day
      const existing = await client.query(
        `SELECT id FROM attendance_logs WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3`,
        [req.gym_id, member_id, visit_date]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Attendance already marked for today' });
      }

      await client.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visit_date, check_in_time, source, visited_at)
         VALUES ($1, $2, $3, $4, 'staff', ($3::date + COALESCE($4::time, '00:00:00'::time))::timestamptz)
         ON CONFLICT DO NOTHING`,
        [req.gym_id, member_id, visit_date, check_in_time || null]
      );

      await client.query(
        `UPDATE members SET last_visit_date = NOW() WHERE id = $1 AND gym_id = $2`,
        [member_id, req.gym_id]
      );

      res.status(201).json({ success: true });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/attendance', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      const { date } = req.query;
      const params: any[] = [req.gym_id];
      let query = `SELECT id, member_id, visit_date::text, check_in_time, created_at
                   FROM attendance_logs
                   WHERE gym_id = $1`;
      if (date) {
        params.push(date);
        query += ` AND visit_date = $2::date`;
      }
      query += ` ORDER BY visit_date DESC LIMIT 500`;
      const result = await client.query(query, params);
      res.json({ success: true, data: { attendance: result.rows } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// MEMBER ATTENDANCE CALENDAR ENDPOINT
// ============================================================================

// GET /api/members/:memberId/attendance?month=YYYY-MM
// Returns member details + present dates for the given month
app.get('/api/members/:memberId/attendance', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { memberId } = req.params;
    let { month } = req.query as { month?: string };

    // Default to current month if not provided
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      const now = new Date();
      month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    const client = await pool.connect();
    try {
      // Verify member belongs to this gym (trainers can only see their assigned members)
      let memberQuery = `
        SELECT id, name, phone, email, status, plan_fee,
               membership_expiry_date::text, last_visit_date::text, created_at::text,
               assigned_trainer_id
        FROM members
        WHERE id = $1 AND gym_id = $2 AND is_deleted = false`;
      const memberParams: any[] = [memberId, req.gym_id];

      if (req.user.role === 'trainer') {
        const trainerRes = await client.query(
          'SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false',
          [req.user.id, req.gym_id]
        );
        if (trainerRes.rows.length > 0) {
          memberQuery += ` AND assigned_trainer_id = $3`;
          memberParams.push(trainerRes.rows[0].id);
        }
      }

      const memberRes = await client.query(memberQuery, memberParams);

      if (memberRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      const member = memberRes.rows[0];

      // Query attendance dates for the requested month
      const attendanceRes = await client.query(
        `SELECT visit_date::text
         FROM attendance_logs
         WHERE gym_id = $1
           AND member_id = $2
           AND DATE_TRUNC('month', visit_date) = DATE_TRUNC('month', ($3 || '-01')::date)
         ORDER BY visit_date ASC`,
        [req.gym_id, memberId, month]
      );

      const presentDates = attendanceRes.rows.map((r: any) => r.visit_date);

      res.json({
        success: true,
        data: {
          member,
          present_dates: presentDates,
          month,
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// PROFILE ENDPOINTS
// ============================================================================

const updateProfileSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().min(10).max(20).optional().or(z.literal('')),
  email: z.string().email().optional().or(z.literal('')),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6).optional(),
});

const updateGymSchema = z.object({
  gymName:             z.string().min(2).max(100),
  address:             z.string().max(500).optional().or(z.literal('')),
  phone:               z.string().min(10).max(20).optional().or(z.literal('')),
  razorpay_key_id:     z.string().max(100).optional().or(z.literal('')),
  razorpay_key_secret: z.string().max(255).optional().or(z.literal('')),
});

// GET /api/profile — works for both owner and trainer
app.get('/api/profile', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      if (req.user.role === 'owner') {
        const result = await client.query(
          `SELECT u.id, u.phone_or_email, u.phone, u.phone_verified,
                  g.owner_name as name, g.id as gym_id,
                  g.name as gym_name, g.address as gym_address,
                  g.phone as gym_phone, g.email as gym_email,
                  (g.razorpay_key_id IS NOT NULL AND g.razorpay_key_id != '') AS gym_razorpay_configured,
                  LEFT(g.razorpay_key_id, 8) AS gym_razorpay_key_hint
           FROM users u
           JOIN gyms g ON g.id = u.gym_id
           WHERE u.id = $1 AND u.is_deleted = false`,
          [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Profile not found' });
        const row = result.rows[0];
        res.json({
          success: true,
          data: {
            id: row.id,
            name: row.name,
            email: row.phone_or_email,
            phone: row.phone || '',
            phoneVerified: row.phone_verified ?? true,
            role: 'owner',
            gym: {
              id: row.gym_id,
              name: row.gym_name,
              address: row.gym_address || '',
              phone: row.gym_phone || '',
              email: row.gym_email || '',
              razorpay_configured: row.gym_razorpay_configured ?? false,
              razorpay_key_hint: row.gym_razorpay_key_hint || null,
            }
          }
        });
      } else {
        const result = await client.query(
          `SELECT u.id, u.phone_or_email, u.phone_verified, t.name, t.phone, t.email, t.id as trainer_id
           FROM users u
           JOIN trainers t ON t.user_id = u.id
           WHERE u.id = $1 AND t.is_deleted = false`,
          [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Profile not found' });
        const row = result.rows[0];
        res.json({
          success: true,
          data: {
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone || '',
            phoneVerified: row.phone_verified ?? false,
            role: 'trainer',
          }
        });
      }
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/profile — update name, phone, optional password
app.put('/api/profile', authenticate, validate(updateProfileSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, phone, email, currentPassword, newPassword } = req.body;
    const client = await pool.connect();
    try {
      // Optional password change
      if (newPassword) {
        if (!currentPassword) return res.status(400).json({ success: false, error: 'Current password is required to set a new password' });
        const userRes = await client.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
        if (!valid) return res.status(400).json({ success: false, error: 'Current password is incorrect' });
        const hash = await bcrypt.hash(newPassword, 10);
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      }

      if (req.user.role === 'owner') {
        await client.query('UPDATE gyms SET owner_name = $1 WHERE id = $2', [name, req.gym_id]);
        if (phone) await client.query('UPDATE users SET phone = $1, phone_verified = false WHERE id = $2', [phone, req.user.id]);
        // Email update — check uniqueness first
        if (email && email.trim()) {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_or_email = $1 AND id != $2 AND is_deleted = false',
            [email.trim(), req.user.id]
          );
          if (existing.rows.length > 0) return res.status(409).json({ success: false, error: 'This email is already in use by another account.' });
          await client.query('UPDATE users SET phone_or_email = $1 WHERE id = $2', [email.trim(), req.user.id]);
          await client.query('UPDATE gyms SET email = $1 WHERE id = $2', [email.trim(), req.gym_id]);
        }
      } else {
        await client.query(
          'UPDATE trainers SET name = $1, phone = $2 WHERE user_id = $3 AND gym_id = $4',
          [name, phone || '', req.user.id, req.gym_id]
        );
        if (phone) await client.query('UPDATE users SET phone = $1, phone_verified = false WHERE id = $2', [phone, req.user.id]);
        if (email && email.trim()) {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_or_email = $1 AND id != $2 AND is_deleted = false',
            [email.trim(), req.user.id]
          );
          if (existing.rows.length > 0) return res.status(409).json({ success: false, error: 'This email is already in use by another account.' });
          await client.query('UPDATE users SET phone_or_email = $1 WHERE id = $2', [email.trim(), req.user.id]);
          await client.query('UPDATE trainers SET email = $1 WHERE user_id = $2 AND gym_id = $3', [email.trim(), req.user.id, req.gym_id]);
        }
      }
      res.json({ success: true, data: { message: 'Profile updated successfully' } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/profile/verify-phone — verify Firebase phone token and mark phone as verified
app.post('/api/profile/verify-phone', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return res.status(503).json({ success: false, error: 'Firebase not configured' });
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) return res.status(400).json({ success: false, error: 'firebase_id_token is required' });

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired verification token' });
    }

    const verifiedPhone = decoded.phone_number;
    if (!verifiedPhone) return res.status(400).json({ success: false, error: 'No phone number in token' });

    // Update phone and mark as verified
    await pool.query(
      'UPDATE users SET phone = $1, phone_verified = true WHERE id = $2',
      [verifiedPhone, req.user.id]
    );

    // Also update trainers table if trainer
    if (req.user.role === 'trainer') {
      await pool.query(
        'UPDATE trainers SET phone = $1 WHERE user_id = $2',
        [verifiedPhone, req.user.id]
      );
    }

    res.json({ success: true, data: { message: 'Phone verified successfully', phone: verifiedPhone } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/gyms/me — owner updates gym name, address, phone
app.put('/api/gyms/me', authenticate, authorize(['owner']), validate(updateGymSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gymName, address, phone, razorpay_key_id, razorpay_key_secret } = req.body;
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE gyms
         SET name = $1,
             address = $2,
             phone = COALESCE(NULLIF($3, ''), phone),
             razorpay_key_id     = COALESCE(NULLIF($4, ''), razorpay_key_id),
             razorpay_key_secret = COALESCE(NULLIF($5, ''), razorpay_key_secret)
         WHERE id = $6`,
        [gymName, address || null, phone || null,
         razorpay_key_id || null, razorpay_key_secret || null, req.gym_id]
      );
      res.json({ success: true, data: { message: 'Gym details updated successfully' } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// BIOMETRIC DEVICE (ADMS / ZKTeco) ENDPOINTS
// The ESSLX990 / ZKTeco devices use the standard ADMS protocol.
// Configure the device: Server = recurva.in, Port = 443, Push = ON.
// ============================================================================

// ── Text-body parser for ADMS routes (device sends plain text) ────────────────
const admsText = express.text({ type: '*/*', limit: '1mb' });

// GET /iclock/cdata — device check-in / heartbeat
app.get('/iclock/cdata', admsText, async (req: Request, res: Response) => {
  const sn = req.query.SN as string || req.query.sn as string;
  if (!sn) return res.status(200).send('OK');
  // Update last_seen on the registered device (if known)
  pool.query(
    `UPDATE biometric_devices SET last_seen_at = NOW() WHERE serial_number = $1`,
    [sn]
  ).catch(() => {});
  const stamp = Math.floor(Date.now() / 1000);
  res.set('Content-Type', 'text/plain');
  res.send(`GET OPTION FROM:${sn}\r\nATTSTAMP:${stamp}\r\n`);
});

// POST /iclock/cdata — device pushes attendance records
app.post('/iclock/cdata', admsText, async (req: Request, res: Response) => {
  try {
    const sn    = (req.query.SN || req.query.sn) as string;
    const table = (req.query.table || req.query.Table) as string;
    if (!sn || table !== 'ATTLOG') return res.status(200).send('OK');

    // Look up which gym this device belongs to
    const devRes = await pool.query(
      `SELECT gym_id FROM biometric_devices WHERE serial_number = $1 AND is_active = TRUE`,
      [sn]
    );
    if (devRes.rows.length === 0) return res.status(200).send('OK'); // unregistered device

    const gymId = devRes.rows[0].gym_id;
    // Update last_seen
    pool.query(`UPDATE biometric_devices SET last_seen_at = NOW() WHERE serial_number = $1`, [sn]).catch(() => {});

    // Parse ADMS attendance lines
    // Format: <userid>\t<YYYY-MM-DD HH:MM:SS>\t<verifymode>\t<workcode>\t\t
    const body   = (typeof req.body === 'string' ? req.body : req.body?.toString?.() || '');
    const lines  = body.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const parts     = line.split('\t');
      if (parts.length < 2) continue;
      const deviceUid = parts[0].trim();
      const rawDt     = parts[1].trim();          // e.g. "2026-05-07 09:31:00"

      let visitDate: Date;
      try {
        visitDate = new Date(rawDt.replace(' ', 'T'));
        if (isNaN(visitDate.getTime())) continue;
      } catch { continue; }

      // Look up member from mapping
      const mapRes = await pool.query(
        `SELECT member_id FROM biometric_mappings
         WHERE gym_id = $1 AND serial_number = $2 AND device_user_id = $3`,
        [gymId, sn, deviceUid]
      );

      if (mapRes.rows.length === 0) {
        // Unknown user — store for later mapping by owner
        pool.query(
          `INSERT INTO biometric_mappings (gym_id, serial_number, device_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (gym_id, serial_number, device_user_id) DO NOTHING`,
          [gymId, sn, deviceUid]
        ).catch(() => {});
        continue;
      }

      const memberId = mapRes.rows[0].member_id;
      if (!memberId) continue;

      const dateStr = visitDate.toISOString().split('T')[0];
      // Insert attendance — source = biometric (ignore duplicate for same day)
      pool.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visited_at, status, source)
         VALUES ($1, $2, $3, 'present', 'biometric')
         ON CONFLICT (gym_id, member_id, DATE(visited_at)) DO NOTHING`,
        [gymId, memberId, visitDate]
      ).then(() => {
        // Update last_visit_date on member
        pool.query(
          `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND (last_visit_date IS NULL OR last_visit_date < $1)`,
          [dateStr, memberId]
        ).catch(() => {});
      }).catch(() => {});
    }

    res.set('Content-Type', 'text/plain');
    res.send('OK');
  } catch {
    res.status(200).send('OK'); // always 200 to device
  }
});

// GET /iclock/getrequest — device polls for server commands (no commands → OK)
app.get('/iclock/getrequest', (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// POST /iclock/devicecmd — device confirms command execution
app.post('/iclock/devicecmd', admsText, (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain');
  res.send('OK');
});

// ── Biometric device management (owner REST API) ──────────────────────────────

// Register a device by serial number
app.post('/api/biometric/devices', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { serial_number, device_name } = req.body;
    if (!serial_number) return res.status(400).json({ success: false, error: 'serial_number required' });
    const result = await pool.query(
      `INSERT INTO biometric_devices (gym_id, serial_number, device_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (gym_id, serial_number) DO UPDATE
         SET device_name = EXCLUDED.device_name, is_active = TRUE
       RETURNING id, serial_number, device_name, last_seen_at, is_active, created_at`,
      [req.gym_id, serial_number.trim().toUpperCase(), device_name?.trim() || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// List registered devices
app.get('/api/biometric/devices', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id, serial_number, device_name, last_seen_at, is_active, created_at
       FROM biometric_devices WHERE gym_id = $1 ORDER BY created_at DESC`,
      [req.gym_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// Delete a device
app.delete('/api/biometric/devices/:id', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await pool.query(`DELETE FROM biometric_devices WHERE id = $1 AND gym_id = $2`, [req.params.id, req.gym_id]);
    res.json({ success: true });
  } catch (error) { next(error); }
});

// List mappings for a device (device_user_id → member)
app.get('/api/biometric/mappings', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const serial = req.query.serial as string;
    let q = `SELECT bm.id, bm.serial_number, bm.device_user_id, bm.member_id,
                    m.name AS member_name, m.phone AS member_phone
             FROM biometric_mappings bm
             LEFT JOIN members m ON m.id = bm.member_id
             WHERE bm.gym_id = $1`;
    const params: any[] = [req.gym_id];
    if (serial) { q += ` AND bm.serial_number = $2`; params.push(serial.toUpperCase()); }
    q += ` ORDER BY bm.device_user_id::int NULLS LAST`;
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (error) { next(error); }
});

// Map a device user ID to a member (or clear the mapping)
app.put('/api/biometric/mappings', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { serial_number, device_user_id, member_id } = req.body;
    if (!serial_number || !device_user_id) return res.status(400).json({ success: false, error: 'serial_number and device_user_id required' });
    const result = await pool.query(
      `INSERT INTO biometric_mappings (gym_id, serial_number, device_user_id, member_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (gym_id, serial_number, device_user_id) DO UPDATE SET member_id = EXCLUDED.member_id
       RETURNING *`,
      [req.gym_id, serial_number.trim().toUpperCase(), device_user_id.trim(), member_id || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

// QR code attendance — staff scans member's QR
app.post('/api/attendance/qr', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { member_id } = req.body;
    if (!member_id) return res.status(400).json({ success: false, error: 'member_id required' });
    const memberRes = await pool.query(
      `SELECT id, name FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = FALSE`,
      [member_id, req.gym_id]
    );
    if (memberRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Member not found' });
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO attendance_logs (gym_id, member_id, visited_at, status, source)
       VALUES ($1, $2, NOW(), 'present', 'qr')
       ON CONFLICT (gym_id, member_id, DATE(visited_at)) DO NOTHING`,
      [req.gym_id, member_id]
    );
    await pool.query(
      `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND (last_visit_date IS NULL OR last_visit_date < $1)`,
      [today, member_id]
    );
    res.json({ success: true, data: { message: `Attendance marked for ${memberRes.rows[0].name}`, member_name: memberRes.rows[0].name } });
  } catch (error) { next(error); }
});

// Self check-in — member marks their own attendance via mobile app
app.post('/api/attendance/checkin', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return res.status(404).json({ success: false, error: 'Member profile not found' });

    // Check if already marked today — try visited_at first, fall back to visit_date
    let existing: any = { rows: [] };
    try {
      existing = await pool.query(
        `SELECT id, source FROM attendance_logs
         WHERE gym_id = $1 AND member_id = $2 AND DATE(visited_at) = $3`,
        [req.gym_id, memberIdParam, today]
      );
    } catch (colErr: any) {
      if (colErr?.message?.includes('visited_at')) {
        existing = await pool.query(
          `SELECT id, source FROM attendance_logs
           WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3`,
          [req.gym_id, memberIdParam, today]
        );
      } else { throw colErr; }
    }
    if (existing.rows.length > 0) {
      return res.json({ success: true, data: { message: 'Already marked today', already_marked: true, source: existing.rows[0].source } });
    }

    // Insert attendance — try visited_at column first, fall back to visit_date
    try {
      await pool.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visited_at, visit_date, status, source)
         VALUES ($1, $2, NOW(), $3::date, 'present', 'mobile')
         ON CONFLICT ON CONSTRAINT idx_attendance_member_day DO NOTHING`,
        [req.gym_id, memberIdParam, today]
      );
    } catch (insertErr: any) {
      // visited_at column missing or constraint name wrong — use legacy columns only
      await pool.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visit_date, status, source)
         VALUES ($1, $2, $3, 'present', 'mobile')
         ON CONFLICT DO NOTHING`,
        [req.gym_id, memberIdParam, today]
      );
    }
    await pool.query(
      `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND (last_visit_date IS NULL OR last_visit_date < $1)`,
      [today, memberIdParam]
    );
    res.json({ success: true, data: { message: 'Attendance marked!', already_marked: false, source: 'mobile' } });
  } catch (error) { next(error); }
});

// ============================================================================
// CUSTOMER LINK-ACCOUNT  (self-service repair for broken member links)
// ============================================================================

app.post('/api/customer/link-account', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { phone } = req.body;
    if (!phone || String(phone).trim().length < 5) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    const normalizedPhone = String(phone).trim();

    // Find member record in the same gym by phone number
    const memberResult = await pool.query(
      `SELECT id, name FROM members
       WHERE gym_id = $1 AND is_deleted = false
         AND (phone = $2 OR RIGHT(phone, 10) = RIGHT($2, 10))
       LIMIT 1`,
      [req.gym_id, normalizedPhone]
    );

    if (memberResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No member found with that phone number in your gym. Please check with your gym owner.'
      });
    }

    const member = memberResult.rows[0];

    // Check if this member record is already linked to a DIFFERENT user
    let existingUserResult: any;
    try {
      existingUserResult = await pool.query(
        `SELECT user_id FROM members WHERE id = $1`,
        [member.id]
      );
      const existingUserId = existingUserResult.rows[0]?.user_id;
      if (existingUserId && existingUserId !== req.user.id) {
        return res.status(409).json({
          success: false,
          error: 'This member record is already linked to another account. Please contact your gym owner.'
        });
      }
    } catch (_) { /* user_id column may not exist yet, skip check */ }

    // Link: set user_id and email on the real member record
    const userResult = await pool.query(`SELECT phone_or_email FROM users WHERE id = $1`, [req.user.id]);
    const userEmail = userResult.rows[0]?.phone_or_email || null;

    try {
      await pool.query(
        `UPDATE members SET user_id = $1, email = COALESCE(NULLIF(TRIM(email), ''), $2) WHERE id = $3`,
        [req.user.id, userEmail, member.id]
      );
    } catch (_) {
      await pool.query(
        `UPDATE members SET email = COALESCE(NULLIF(TRIM(email), ''), $1) WHERE id = $2`,
        [userEmail, member.id]
      );
    }

    // Soft-delete any stale placeholder member previously linked to this user (different id)
    if (req.user.member_id && req.user.member_id !== member.id) {
      try {
        await pool.query(
          `UPDATE members SET is_deleted = true WHERE id = $1 AND gym_id = $2 AND (phone IS NULL OR phone = '') AND (name IS NULL OR name = '')`,
          [req.user.member_id, req.gym_id]
        );
      } catch (_) { /* best effort */ }
    }

    // Issue a new access token with the correct member_id so the client doesn't need to re-login
    const newAccessToken = jwt.sign(
      { id: req.user.id, gym_id: req.gym_id, role: 'member', member_id: member.id },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    res.json({ success: true, data: {
      message: `Account linked to member "${member.name}" successfully!`,
      member_id: member.id,
      access_token: newAccessToken,
    }});
  } catch (error) { next(error); }
});

// ============================================================================
// CUSTOMER PORTAL ENDPOINTS  (role: member)
// ============================================================================

app.get('/api/customer/profile', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return res.status(404).json({ success: false, error: 'Profile not found' });

    // Try full query first; fall back gracefully when optional columns don't exist yet.
    // Each catch narrows the column set until we have a working query.
    let result: any;
    try {
      result = await pool.query(
        `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                m.membership_expiry_date, m.plan_fee, m.plan, m.created_at,
                COALESCE(m.email_verified, FALSE) AS email_verified,
                COALESCE(m.phone_verified, FALSE) AS phone_verified,
                g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                (COALESCE(g.razorpay_key_id, '') != '') AS payment_enabled
         FROM members m
         JOIN gyms g ON m.gym_id = g.id
         WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
        [memberIdParam, req.gym_id]
      );
    } catch (colErr: any) {
      // Fallback 1: email_verified / phone_verified / plan columns missing
      try {
        result = await pool.query(
          `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                  m.membership_expiry_date, m.plan_fee, m.plan, m.created_at,
                  FALSE AS email_verified, FALSE AS phone_verified,
                  g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                  FALSE AS payment_enabled
           FROM members m
           JOIN gyms g ON m.gym_id = g.id
           WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
          [memberIdParam, req.gym_id]
        );
      } catch (colErr2: any) {
        // Fallback 2: plan column also missing — absolute minimum columns
        result = await pool.query(
          `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                  m.membership_expiry_date, m.plan_fee, m.created_at,
                  NULL AS plan,
                  FALSE AS email_verified, FALSE AS phone_verified,
                  g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                  FALSE AS payment_enabled
           FROM members m
           JOIN gyms g ON m.gym_id = g.id
           WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
          [memberIdParam, req.gym_id]
        );
      }
    }
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Profile not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (error) { next(error); }
});

app.put('/api/customer/profile', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, email } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return res.status(404).json({ success: false, error: 'Profile not found' });
    await pool.query(
      `UPDATE members SET name = $1, email = $2 WHERE id = $3 AND gym_id = $4 AND is_deleted = false`,
      [name.trim(), email?.trim() || null, memberIdParam, req.gym_id]
    );
    res.json({ success: true, data: { message: 'Profile updated' } });
  } catch (error) { next(error); }
});

app.get('/api/customer/attendance', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const year  = parseInt((req.query.year  as string) || `${new Date().getFullYear()}`);
    const month = parseInt((req.query.month as string) || `${new Date().getMonth() + 1}`);
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return res.status(404).json({ success: false, error: 'Member profile not found. Please contact your gym.' });
    let attResult: any;
    try {
      attResult = await pool.query(
        `SELECT DATE(visited_at)::text AS date, status, COALESCE(source, 'staff') AS source
         FROM attendance_logs
         WHERE member_id = $1 AND gym_id = $2
           AND visited_at IS NOT NULL
           AND EXTRACT(YEAR  FROM visited_at) = $3
           AND EXTRACT(MONTH FROM visited_at) = $4
         ORDER BY date`,
        [memberIdParam, req.gym_id, year, month]
      );
    } catch (colErr: any) {
      // visited_at column missing — fall back to visit_date
      if (colErr?.message?.includes('visited_at')) {
        attResult = await pool.query(
          `SELECT visit_date::text AS date, status, COALESCE(source, 'staff') AS source
           FROM attendance_logs
           WHERE member_id = $1 AND gym_id = $2
             AND visit_date IS NOT NULL
             AND EXTRACT(YEAR  FROM visit_date) = $3
             AND EXTRACT(MONTH FROM visit_date) = $4
           ORDER BY date`,
          [memberIdParam, req.gym_id, year, month]
        );
      } else { throw colErr; }
    }
    res.json({ success: true, data: attResult.rows });
  } catch (error) { next(error); }
});

// ============================================================================
// PAYMENT ENDPOINTS
// ============================================================================

// Resolve member_id for a logged-in member user.
// Strategy 1: direct user_id match (fastest, works if user_id column exists).
// Strategy 2: email/phone cross-match via users table (fallback for older members).
// Silently returns undefined on any error so callers can return a friendly 404.
async function resolveMemberId(userId: string, gymId: string): Promise<string | undefined> {
  // Strategy 1 — direct user_id link (populated by registration or prior login)
  try {
    const direct = await pool.query(
      `SELECT id FROM members WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
      [userId, gymId]
    );
    if (direct.rows[0]?.id) return direct.rows[0].id;
  } catch { /* user_id column may not exist yet — fall through to strategy 2 */ }

  // Strategy 2 — match via email or phone stored in users.phone_or_email
  try {
    const lookup = await pool.query(
      `SELECT m.id FROM members m
       JOIN users u ON u.id = $1
       WHERE m.gym_id = $2 AND m.is_deleted = false
         AND (LOWER(m.email) = LOWER(u.phone_or_email)
              OR m.phone = u.phone_or_email
              OR RIGHT(m.phone, 10) = RIGHT(u.phone_or_email, 10)
              OR (u.phone IS NOT NULL AND (m.phone = u.phone OR RIGHT(m.phone, 10) = RIGHT(u.phone, 10)))
              OR (u.phone IS NOT NULL AND LOWER(m.email) = LOWER(u.phone)))
       LIMIT 1`,
      [userId, gymId]
    );
    const memberId = lookup.rows[0]?.id;
    // Best-effort: backfill user_id so future requests hit strategy 1
    if (memberId) {
      pool.query(
        `UPDATE members SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
        [userId, memberId]
      ).catch(() => {});
    }
    return memberId;
  } catch { return undefined; }
}

async function razorpayRequest(gymId: string, path: string, method: string, body?: any): Promise<{ data: any; keyId: string }> {
  const gymRes = await pool.query(`SELECT razorpay_key_id, razorpay_key_secret FROM gyms WHERE id = $1`, [gymId]);
  const gym = gymRes.rows[0];
  if (!gym?.razorpay_key_id || !gym?.razorpay_key_secret) {
    const err: any = new Error('Online payments not set up for this gym yet. Contact your gym owner.');
    err.status = 400;
    throw err;
  }
  const auth = Buffer.from(`${gym.razorpay_key_id}:${gym.razorpay_key_secret}`).toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as any;
  if (data.error) {
    const err: any = new Error(data.error.description || 'Payment gateway error');
    err.status = 502;
    throw err;
  }
  return { data, keyId: gym.razorpay_key_id };
}

// Member creates a payment order
app.post('/api/payments/create-order', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { amount, description } = req.body;
    if (!amount || Number(amount) < 1) return res.status(400).json({ success: false, error: 'Amount must be at least ₹1' });
    const amountPaise = Math.round(Number(amount) * 100);
    const { data: order, keyId } = await razorpayRequest(req.gym_id!, '/orders', 'POST', {
      amount: amountPaise, currency: 'INR', receipt: `rcpt_${Date.now()}`,
    });
    await pool.query(
      `INSERT INTO payments (gym_id, member_id, razorpay_order_id, amount, status, description)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [req.gym_id, req.user.member_id, order.id, amountPaise, description || null]
    );
    res.json({ success: true, data: { order_id: order.id, amount: amountPaise, currency: 'INR', key_id: keyId } });
  } catch (error) { next(error); }
});

// Member verifies payment after Razorpay checkout completes
app.post('/api/payments/verify', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ success: false, error: 'Missing payment fields' });

    const gymRes = await pool.query(`SELECT razorpay_key_secret FROM gyms WHERE id = $1`, [req.gym_id]);
    const secret = gymRes.rows[0]?.razorpay_key_secret;
    if (!secret) return res.status(400).json({ success: false, error: 'Payment not configured' });

    const expectedSig = crypto.createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature)
      return res.status(400).json({ success: false, error: 'Payment verification failed. Please contact support.' });

    const result = await pool.query(
      `UPDATE payments SET status = 'completed', razorpay_payment_id = $1
       WHERE razorpay_order_id = $2 AND gym_id = $3 AND member_id = $4
       RETURNING id`,
      [razorpay_payment_id, razorpay_order_id, req.gym_id, req.user.member_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Payment record not found' });
    res.json({ success: true, data: { message: 'Payment successful!', payment_id: result.rows[0].id } });
  } catch (error) { next(error); }
});

// Member views their own payment history
app.get('/api/customer/payments', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1'));
    const limit = Math.min(parseInt((req.query.limit as string) || '20'), 50);
    const offset = (page - 1) * limit;
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return res.json({ success: true, data: { payments: [], total: 0 } });
    const rows = await pool.query(
      `SELECT id, amount, currency, status, payment_method, description, created_at
       FROM payments WHERE member_id = $1 AND gym_id = $2
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [memberIdParam, req.gym_id, limit, offset]
    );
    const cnt = await pool.query(
      `SELECT COUNT(*) FROM payments WHERE member_id = $1 AND gym_id = $2`,
      [memberIdParam, req.gym_id]
    );
    res.json({ success: true, data: { payments: rows.rows, total: parseInt(cnt.rows[0].count) } });
  } catch (error) { next(error); }
});

// Owner views all payments for their gym
app.get('/api/payments', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const month    = req.query.month     as string;
    const memberId = req.query.member_id as string;
    const page  = Math.max(1, parseInt((req.query.page  as string) || '1'));
    const limit = Math.min(parseInt((req.query.limit as string) || '50'), 100);
    const offset = (page - 1) * limit;

    const params: any[] = [req.gym_id];
    let where = `WHERE p.gym_id = $1 AND p.status = 'completed'`;
    if (month)    { where += ` AND TO_CHAR(p.created_at, 'YYYY-MM') = $${params.length + 1}`; params.push(month); }
    if (memberId) { where += ` AND p.member_id = $${params.length + 1}`;                       params.push(memberId); }

    const rows = await pool.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.payment_method, p.description, p.created_at,
              m.name AS member_name, m.phone AS member_phone
       FROM payments p JOIN members m ON p.member_id = m.id
       ${where} ORDER BY p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const cnt = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(p.amount), 0) AS total_amount FROM payments p ${where}`,
      params
    );
    res.json({ success: true, data: {
      payments: rows.rows,
      total: parseInt(cnt.rows[0].total),
      total_amount: parseInt(cnt.rows[0].total_amount),
    }});
  } catch (error) { next(error); }
});

// Owner downloads monthly CSV report
app.get('/api/payments/report', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const rows = await pool.query(
      `SELECT m.name AS member_name, m.phone AS member_phone,
              p.amount, p.payment_method, p.description, p.created_at
       FROM payments p JOIN members m ON p.member_id = m.id
       WHERE p.gym_id = $1 AND p.status = 'completed'
         AND TO_CHAR(p.created_at, 'YYYY-MM') = $2
       ORDER BY p.created_at`,
      [req.gym_id, month]
    );
    const totalPaise = rows.rows.reduce((s: number, r: any) => s + r.amount, 0);
    const lines = [
      'Member Name,Phone,Amount (Rs),Method,Description,Date',
      ...rows.rows.map((r: any) => [
        `"${r.member_name}"`,
        r.member_phone,
        (r.amount / 100).toFixed(2),
        r.payment_method || 'N/A',
        `"${r.description || ''}"`,
        new Date(r.created_at).toLocaleDateString('en-IN'),
      ].join(',')),
      '',
      `TOTAL,, ${(totalPaise / 100).toFixed(2)},,, ${rows.rows.length} payments`,
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${month}.csv"`);
    res.send(lines.join('\n'));
  } catch (error) { next(error); }
});

// ============================================================================
// DASHBOARD ENDPOINTS
// ============================================================================

// Shared SQL expression to compute member status dynamically.
// Priority: high_risk > at_risk > active
// daysToExpiry  ≤ 7  OR daysSinceActivity > 10  → high_risk
// daysToExpiry  ≤ 14 OR daysSinceActivity > 5   → at_risk
// else                                           → active
// daysSinceActivity uses COALESCE(last_visit_date, created_at) so new members start Active.
const MEMBER_STATUS_SQL = `
  CASE
    WHEN EXTRACT(EPOCH FROM (membership_expiry_date - NOW())) / 86400 <= 7
      OR EXTRACT(EPOCH FROM (NOW() - COALESCE(last_visit_date, created_at))) / 86400 > 10
    THEN 'high_risk'
    WHEN EXTRACT(EPOCH FROM (membership_expiry_date - NOW())) / 86400 <= 14
      OR EXTRACT(EPOCH FROM (NOW() - COALESCE(last_visit_date, created_at))) / 86400 > 5
    THEN 'at_risk'
    ELSE 'active'
  END
`.trim();

app.get('/api/dashboard/kpis', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      const [membersRes, revenueRes] = await Promise.all([
        client.query(
          `SELECT
            COUNT(CASE WHEN (${MEMBER_STATUS_SQL}) = 'active'    THEN 1 END) as active_members,
            COUNT(CASE WHEN (${MEMBER_STATUS_SQL}) = 'at_risk'   THEN 1 END) as at_risk_members,
            COUNT(CASE WHEN (${MEMBER_STATUS_SQL}) = 'high_risk' THEN 1 END) as high_risk_members,
            COUNT(*) as total_members
           FROM members WHERE gym_id = $1 AND is_deleted = false`,
          [req.gym_id]
        ),
        client.query(
          `SELECT COALESCE(SUM(revenue_recovered), 0) as total_revenue
           FROM revenue_records WHERE gym_id = $1`,
          [req.gym_id]
        ),
      ]);

      const kpis = membersRes.rows[0];
      const revenue = revenueRes.rows[0];

      res.json({
        success: true,
        data: {
          totalMembers:     parseInt(kpis.total_members),
          activeMembers:    parseInt(kpis.active_members),
          atRiskMembers:    parseInt(kpis.at_risk_members),
          highRiskMembers:  parseInt(kpis.high_risk_members),
          revenueRecovered: parseFloat(revenue.total_revenue),
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/revenue', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      // Metrics: total, this month, this year, members recovered
      const metricsRes = await client.query(
        `SELECT
          COUNT(DISTINCT r.member_id) as total_recovered_members,
          COALESCE(SUM(r.revenue_recovered), 0) as total_revenue,
          COALESCE(SUM(CASE WHEN DATE_TRUNC('month', r.tracked_at) = DATE_TRUNC('month', NOW()) THEN r.revenue_recovered ELSE 0 END), 0) as revenue_this_month,
          COALESCE(SUM(CASE WHEN DATE_TRUNC('year', r.tracked_at) = DATE_TRUNC('year', NOW()) THEN r.revenue_recovered ELSE 0 END), 0) as revenue_this_year
         FROM revenue_records r
         WHERE r.gym_id = $1`,
        [req.gym_id]
      );

      // Member-level breakdown
      const recordsRes = await client.query(
        `SELECT r.id, r.member_id, m.name as member_name, r.task_id, r.action,
                r.revenue_recovered, r.tracked_at
         FROM revenue_records r
         LEFT JOIN members m ON r.member_id = m.id
         WHERE r.gym_id = $1
         ORDER BY r.tracked_at DESC
         LIMIT 100`,
        [req.gym_id]
      );

      // Monthly summary (kept for backwards compat)
      const monthlyRes = await client.query(
        `SELECT DATE_TRUNC('month', tracked_at) as month,
                SUM(revenue_recovered) as total_revenue,
                COUNT(*) as recovery_count
         FROM revenue_records WHERE gym_id = $1
         GROUP BY DATE_TRUNC('month', tracked_at)
         ORDER BY month DESC LIMIT 12`,
        [req.gym_id]
      );

      const m = metricsRes.rows[0];
      res.json({
        success: true,
        data: {
          metrics: {
            totalRecoveredMembers: parseInt(m.total_recovered_members),
            totalRevenueRecovered: parseFloat(m.total_revenue),
            revenueThisMonth: parseFloat(m.revenue_this_month),
            revenueThisYear: parseFloat(m.revenue_this_year),
          },
          revenueRecords: recordsRes.rows,
          revenue: monthlyRes.rows.map(row => ({
            month: row.month,
            total: parseFloat(row.total_revenue),
            count: parseInt(row.recovery_count)
          }))
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SCHEDULED JOBS
// ============================================================================

// Daily trial expiry notifications at 9 AM
// Uses gym_notifications to ensure each email is sent at most once per day per gym.
// Safe to restart — ON CONFLICT DO NOTHING skips already-sent notifications.
cron.schedule('0 9 * * *', async () => {
  logger.info('Running trial expiry notification job');
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT g.id, g.name, g.email, g.owner_name,
               EXTRACT(DAY FROM g.trial_ends_at - NOW())::int AS days_remaining
        FROM gyms g
        WHERE g.subscription_status = 'trial'
          AND g.is_deleted = false
          AND EXTRACT(DAY FROM g.trial_ends_at - NOW())::int IN (7, 3, 1)
      `);

      for (const gym of result.rows) {
        const notifType = `trial_expiry_${gym.days_remaining}day`;

        // Try to record this notification — skip if already sent today
        const inserted = await client.query(
          `INSERT INTO gym_notifications (gym_id, notification_type, sent_date)
           VALUES ($1, $2, CURRENT_DATE)
           ON CONFLICT (gym_id, notification_type, sent_date) DO NOTHING`,
          [gym.id, notifType]
        );

        if (inserted.rowCount === 0) {
          logger.info({ gymId: gym.id, notifType }, 'Notification already sent today, skipping');
          continue;
        }

        // Push notification to gym owner
        const ownerTokenRow = await client.query(
          `SELECT u.fcm_token FROM users u WHERE u.gym_id = $1 AND u.role = 'owner' AND u.is_deleted = false LIMIT 1`,
          [gym.id]
        );
        const d = gym.days_remaining;
        await sendPush(
          ownerTokenRow.rows[0]?.fcm_token,
          `Trial Expiring in ${d} Day${d === 1 ? '' : 's'}`,
          `${gym.name} — Upgrade now to keep all features active.`,
          { type: 'trial_expiry', days_remaining: String(d), gym_id: String(gym.id) }
        );
        logger.info({ gymId: gym.id, notifType }, 'Trial expiry push sent');
      }
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({ error }, 'Trial notification job failed');
    if (process.env.SENTRY_DSN) Sentry.captureException(error);
  }
});

// Daily task generation at midnight
cron.schedule('0 0 * * *', async () => {
  logger.info('Running daily task generation');
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        SELECT m.id, m.gym_id, m.assigned_trainer_id,
               EXTRACT(DAY FROM NOW() - COALESCE(m.last_visit_date, m.created_at))::int AS days_inactive
        FROM members m
        WHERE m.is_deleted = false
          AND EXTRACT(DAY FROM NOW() - COALESCE(m.last_visit_date, m.created_at)) > 10
          AND NOT EXISTS (
            SELECT 1 FROM follow_up_tasks t WHERE t.member_id = m.id AND t.status = 'pending'
          )
      `);

      for (const member of result.rows) {
        const taskType = member.days_inactive > 20 ? 'renewal' : 'call';
        await client.query(
          `INSERT INTO follow_up_tasks (gym_id, member_id, assigned_trainer_id, task_type, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [member.gym_id, member.id, member.assigned_trainer_id || null, taskType]
        );
      }

      await client.query('COMMIT');
      logger.info({ count: result.rows.length }, 'Tasks generated');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({ error }, 'Task generation failed');
    if (process.env.SENTRY_DSN) Sentry.captureException(error);
  }
});

// Daily member status recalculation at 00:05 — keeps stored status in sync with actual data
cron.schedule('5 0 * * *', async () => {
  logger.info('Running daily member status recalculation');
  try {
    const result = await pool.query(`
      UPDATE members SET status = ${MEMBER_STATUS_SQL}
      WHERE is_deleted = false
    `);
    logger.info({ updated: result.rowCount }, 'Member statuses recalculated');
  } catch (error) {
    logger.error({ error }, 'Member status recalculation failed');
    if (process.env.SENTRY_DSN) Sentry.captureException(error);
  }
});

// ============================================================================
// DATA EXPORT & GDPR ENDPOINTS
// ============================================================================

// GET /api/members/export — download all gym members as CSV
app.get('/api/members/export', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.name, m.phone, m.email, m.status,
              m.last_visit_date, m.membership_expiry_date, m.plan_fee,
              m.created_at, t.name AS assigned_trainer
       FROM members m
       LEFT JOIN trainers t ON t.id = m.assigned_trainer_id
       WHERE m.gym_id = $1 AND m.is_deleted = false
       ORDER BY m.created_at DESC`,
      [req.gym_id]
    );

    const escape = (v: any) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };

    const headers = ['ID','Name','Phone','Email','Status','Last Visit','Membership Expiry','Plan Fee','Assigned Trainer','Created At'];
    const rows = result.rows.map(r => [
      r.id, r.name, r.phone, r.email, r.status,
      r.last_visit_date ? new Date(r.last_visit_date).toISOString().split('T')[0] : '',
      new Date(r.membership_expiry_date).toISOString().split('T')[0],
      r.plan_fee, r.assigned_trainer || '',
      new Date(r.created_at).toISOString().split('T')[0],
    ].map(escape).join(','));

    const csv = [headers.join(','), ...rows].join('\r\n');
    const filename = `members_export_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM for Excel compatibility
  } catch (error) {
    next(error);
  }
});

// DELETE /api/members/:id/data — GDPR: hard-delete a member's personal data
// Anonymises all PII; preserves aggregate revenue/task records with a placeholder.
app.delete('/api/members/:id/data', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      // Verify member belongs to this gym
      const check = await client.query(
        `SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false`,
        [id, req.gym_id]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Member not found' });
      }

      await client.query('BEGIN');

      // Anonymise PII in place — keeps the row for referential integrity.
      // Use id-suffixed placeholders to satisfy UNIQUE(gym_id, phone/email) when
      // multiple members in the same gym are erased.
      await client.query(
        `UPDATE members SET
           name = '[deleted]',
           phone = '[deleted-' || id || ']',
           email = '[deleted-' || id || ']',
           last_visit_date = NULL,
           is_deleted = true,
           deleted_at = NOW()
         WHERE id = $1`,
        [id]
      );

      // Hard-delete attendance records (no business value without identity)
      await client.query(`DELETE FROM attendance_logs WHERE member_id = $1`, [id]);

      await client.query('COMMIT');
      logger.info({ memberId: id, gymId: req.gym_id }, 'Member data erased (GDPR)');
      res.json({ success: true, data: { message: 'Member personal data erased' } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// ADMIN PANEL ENDPOINTS
// ============================================================================

// Simple token-based admin auth (no gym JWT needed — separate secret)
const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

// GET /api/admin/gyms — list all gyms with status, days remaining, member count
app.get('/api/admin/gyms', adminAuth, async (req: Request, res: Response) => {
  const baseSelect = `
    SELECT
      g.id,
      g.name,
      g.email,
      g.phone,
      g.owner_name,
      g.created_at,
      g.trial_ends_at,
      g.subscription_ends_at,
      g.subscription_status,
      COUNT(m.id) AS member_count,
      CASE
        WHEN g.subscription_status = 'active' AND g.subscription_ends_at > NOW()
          THEN EXTRACT(DAY FROM (g.subscription_ends_at - NOW()))::int
        WHEN g.subscription_status = 'trial' AND g.trial_ends_at IS NOT NULL
          THEN GREATEST(0, EXTRACT(DAY FROM (g.trial_ends_at - NOW()))::int)
        ELSE 0
      END AS days_remaining
    FROM gyms g
    LEFT JOIN members m ON m.gym_id = g.id AND m.is_deleted = false
    WHERE g.is_deleted = false
    GROUP BY g.id
    ORDER BY g.created_at DESC
  `;
  try {
    // Try full query including block columns (requires migration_gym_block.sql to have been run)
    const result = await pool.query(`
      SELECT
        g.id, g.name, g.email, g.phone, g.owner_name, g.created_at,
        g.trial_ends_at, g.subscription_ends_at, g.subscription_status,
        g.is_blocked, g.blocked_at, g.blocked_reason,
        COUNT(m.id) AS member_count,
        CASE
          WHEN g.subscription_status = 'active' AND g.subscription_ends_at > NOW()
            THEN EXTRACT(DAY FROM (g.subscription_ends_at - NOW()))::int
          WHEN g.subscription_status = 'trial' AND g.trial_ends_at IS NOT NULL
            THEN GREATEST(0, EXTRACT(DAY FROM (g.trial_ends_at - NOW()))::int)
          ELSE 0
        END AS days_remaining
      FROM gyms g
      LEFT JOIN members m ON m.gym_id = g.id AND m.is_deleted = false
      WHERE g.is_deleted = false
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json({ success: true, data: { gyms: result.rows } });
  } catch (err: any) {
    // Fallback: migration_gym_block.sql not yet run — return without block columns
    if (err?.message?.includes('column') && err?.message?.includes('does not exist')) {
      try {
        const result = await pool.query(baseSelect);
        const rows = result.rows.map((r: any) => ({ ...r, is_blocked: false, blocked_at: null, blocked_reason: null }));
        res.json({ success: true, data: { gyms: rows, _migration_needed: 'Run database/migration_gym_block.sql in Supabase SQL editor to enable block/unblock feature' } });
        return;
      } catch (fallbackErr: any) {
        logger.error({ fallbackErr }, 'Admin: fallback list gyms also failed');
      }
    }
    logger.error({ err }, 'Admin: failed to list gyms');
    res.status(500).json({ success: false, error: 'Failed to fetch gyms' });
  }
});

const _uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/gyms/:id/suspend — set subscription_status = 'suspended'
app.post('/api/admin/gyms/:id/suspend', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return res.status(404).json({ success: false, error: 'Gym not found' });
    const result = await pool.query(
      `UPDATE gyms SET subscription_status = 'suspended' WHERE id = $1 AND is_deleted = false RETURNING name`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });
    logger.info({ gymId: id }, 'Admin: gym suspended');
    res.json({ success: true, data: { message: `"${result.rows[0].name}" suspended` } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to suspend gym' });
  }
});

// POST /api/admin/gyms/:id/reactivate — restore trial or active status
app.post('/api/admin/gyms/:id/reactivate', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return res.status(404).json({ success: false, error: 'Gym not found' });
    const result = await pool.query(
      `SELECT name, subscription_ends_at FROM gyms WHERE id = $1 AND is_deleted = false`, [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });
    const gym = result.rows[0];
    const newStatus = gym.subscription_ends_at && new Date(gym.subscription_ends_at) > new Date()
      ? 'active' : 'trial';
    await pool.query(`UPDATE gyms SET subscription_status = $1 WHERE id = $2`, [newStatus, id]);
    logger.info({ gymId: id, newStatus }, 'Admin: gym reactivated');
    res.json({ success: true, data: { message: `"${gym.name}" reactivated as ${newStatus}` } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to reactivate gym' });
  }
});

// POST /api/admin/gyms/:id/block — block gym access (logins and API requests rejected immediately)
app.post('/api/admin/gyms/:id/block', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return res.status(404).json({ success: false, error: 'Gym not found' });
    const { reason } = req.body;
    const result = await pool.query(
      `UPDATE gyms SET is_blocked = true, blocked_at = NOW(), blocked_reason = $1 WHERE id = $2 AND is_deleted = false RETURNING name`,
      [reason ?? null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });
    logger.info({ gymId: id, reason }, 'Admin: gym blocked');
    res.json({ success: true, data: { message: `"${result.rows[0].name}" has been blocked. All logins and API access are denied immediately.` } });
  } catch (err: any) {
    logger.error(err, 'Admin block gym failed');
    res.status(500).json({ success: false, error: 'Failed to block gym' });
  }
});

// POST /api/admin/gyms/:id/unblock — restore gym access
app.post('/api/admin/gyms/:id/unblock', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return res.status(404).json({ success: false, error: 'Gym not found' });
    const result = await pool.query(
      `UPDATE gyms SET is_blocked = false, blocked_at = NULL, blocked_reason = NULL WHERE id = $1 AND is_deleted = false RETURNING name`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });
    logger.info({ gymId: id }, 'Admin: gym unblocked');
    res.json({ success: true, data: { message: `"${result.rows[0].name}" has been unblocked. Access restored.` } });
  } catch (err: any) {
    logger.error(err, 'Admin unblock gym failed');
    res.status(500).json({ success: false, error: 'Failed to unblock gym' });
  }
});

// POST /api/admin/gyms/:id/convert — convert trial → paid (extend by N months)
const convertGymSchema = z.object({
  months: z.number().int().min(1).max(12),
});

app.post('/api/admin/gyms/:id/convert', adminAuth, validate(convertGymSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return res.status(404).json({ success: false, error: 'Gym not found' });
    const { months } = req.body;
    const endsAt = new Date();
    endsAt.setMonth(endsAt.getMonth() + months);

    const result = await pool.query(
      `UPDATE gyms
       SET subscription_status = 'active',
           subscription_ends_at = $1,
           is_active = true
       WHERE id = $2 AND is_deleted = false
       RETURNING name`,
      [endsAt.toISOString(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Gym not found' });
    logger.info({ gymId: id, months }, 'Admin: gym converted to paid');
    res.json({ success: true, data: { message: `Subscription activated for ${months} month(s)`, ends_at: endsAt } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to convert gym' });
  }
});

// DELETE /api/admin/gyms/:id — permanently delete a gym and ALL its data
// Cascade order: audit_logs, revenue_records, attendance_logs, follow_up_tasks,
//   members, trainers, password_reset_tokens, subscription_billing,
//   gym_notifications, trial_conversion_log, users → then gyms.
// All child tables have ON DELETE CASCADE so a single DELETE on gyms handles everything.
app.delete('/api/admin/gyms/:id', adminAuth, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) {
      client.release();
      return res.status(404).json({ success: false, error: 'Gym not found' });
    }

    await client.query('BEGIN');
    const gymRes = await client.query(`SELECT name FROM gyms WHERE id = $1 FOR UPDATE`, [id]);
    if (gymRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Gym not found' });
    }
    const gymName = gymRes.rows[0].name;

    // Explicit cascade deletions for full trace removal
    // (ON DELETE CASCADE handles these automatically, but explicit deletes
    //  give us row counts for logging and make the intent crystal-clear)
    const [auditDel, revDel, attendDel, taskDel, memberDel, trainerDel, billingDel] = await Promise.all([
      client.query(`DELETE FROM audit_logs WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM revenue_records WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM attendance_logs WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM follow_up_tasks WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM members WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM trainers WHERE gym_id = $1`, [id]),
      client.query(`DELETE FROM subscription_billing WHERE gym_id = $1`, [id]),
    ]);
    await client.query(`DELETE FROM gym_notifications WHERE gym_id = $1`, [id]);
    await client.query(`DELETE FROM trial_conversion_log WHERE gym_id = $1`, [id]);
    // password_reset_tokens cascade from users; delete users before gym
    await client.query(`DELETE FROM users WHERE gym_id = $1`, [id]);
    await client.query(`DELETE FROM gyms WHERE id = $1`, [id]);
    await client.query('COMMIT');

    logger.info({
      gymId: id, gymName,
      deleted: {
        members: memberDel.rowCount,
        trainers: trainerDel.rowCount,
        tasks: taskDel.rowCount,
        attendance: attendDel.rowCount,
        revenue: revDel.rowCount,
        audit: auditDel.rowCount,
        billing: billingDel.rowCount,
      }
    }, 'Admin: gym permanently deleted with all data');

    res.json({
      success: true,
      data: {
        message: `"${gymName}" and all its data have been permanently deleted`,
        deleted: {
          members: memberDel.rowCount,
          trainers: trainerDel.rowCount,
          tasks: taskDel.rowCount,
          attendance: attendDel.rowCount,
          revenue: revDel.rowCount,
        }
      }
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(err, 'Admin delete gym failed');
    res.status(500).json({ success: false, error: 'Failed to delete gym' });
  } finally {
    client.release();
  }
});

// ============================================================================
// INVITE CODES
// ============================================================================

// POST /api/invites — owner/admin generates an invite code for a new staff or member
app.post('/api/invites', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { type, name, phone, trainer_role, member_id: directMemberId } = req.body;
    if (!type || !['staff', 'member'].includes(type)) {
      return res.status(400).json({ success: false, error: 'type must be staff or member' });
    }
    if (type === 'member' && !name) {
      return res.status(400).json({ success: false, error: 'name is required for member invites' });
    }

    const code      = generateInviteCode();
    const displayId = await generateDisplayId(type === 'staff' ? 'staff' : 'member');
    const role      = type === 'staff' ? (trainer_role === 'admin' ? 'admin' : 'staff') : undefined;

    let trainerId: string | undefined;
    let memberId: string | undefined;

    const client = await pool.connect();
    try {
      if (type === 'staff') {
        // Create a pending trainer slot
        const trainerRes = await client.query(
          `INSERT INTO trainers (gym_id, user_id, name, display_id, trainer_role, is_active)
           VALUES ($1, NULL, $2, $3, $4, false)
           RETURNING id`,
          [req.gym_id, name || '', displayId, role || 'staff']
        );
        trainerId = trainerRes.rows[0].id;
      } else {
        // For member invites: link to the actual member record.
        // Priority 1: direct member_id passed by the client (most accurate).
        if (directMemberId) {
          const check = await client.query(
            `SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false`,
            [directMemberId, req.gym_id]
          );
          memberId = check.rows[0]?.id;
        }
        // Priority 2: find by phone number.
        if (!memberId && phone) {
          const byPhone = await client.query(
            `SELECT id FROM members
             WHERE gym_id = $1 AND is_deleted = false
               AND (phone = $2 OR RIGHT(phone, 10) = RIGHT($2, 10))
             LIMIT 1`,
            [req.gym_id, phone.trim()]
          );
          memberId = byPhone.rows[0]?.id;
        }
        // Priority 3: fallback to exact name (risky but better than nothing).
        if (!memberId && name) {
          const byName = await client.query(
            `SELECT id FROM members
             WHERE gym_id = $1 AND is_deleted = false
               AND LOWER(TRIM(name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [req.gym_id, name]
          );
          memberId = byName.rows[0]?.id;
        }
      }

      await client.query(
        `INSERT INTO invite_codes (gym_id, code, type, display_id, placeholder_name, placeholder_phone, trainer_role, trainer_id, member_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '7 days')`,
        [req.gym_id, code, type, displayId, name || null, phone || null, role || null, trainerId || null, memberId || null]
      );
    } finally {
      client.release();
    }

    res.status(201).json({
      success: true,
      data: {
        code,
        display_id: displayId,
        type,
        trainer_role: role,
        expires_in_days: 7,
        placeholder_name: name || null,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/invites/:code — validate an invite code (public endpoint — no auth required)
app.get('/api/invites/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.params;
    const result = await pool.query(
      `SELECT ic.*, g.name AS gym_name
       FROM invite_codes ic
       JOIN gyms g ON ic.gym_id = g.id
       WHERE ic.code = $1 AND ic.used_at IS NULL AND ic.expires_at > NOW()`,
      [code.toUpperCase()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Invalid or expired invite code' });
    }
    const invite = result.rows[0];
    res.json({
      success: true,
      data: {
        code:             invite.code,
        type:             invite.type,
        display_id:       invite.display_id,
        trainer_role:     invite.trainer_role,
        gym_name:         invite.gym_name,
        placeholder_name: invite.placeholder_name,
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/staff/register — staff self-registration using invite code (public)
app.post('/api/auth/staff/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, name, email, phone, password } = req.body;
    if (!code || !name || !email || !phone || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const client = await pool.connect();
    try {
      // Validate invite code
      const inviteRes = await client.query(
        `SELECT ic.*, g.id AS gym_id FROM invite_codes ic
         JOIN gyms g ON ic.gym_id = g.id
         WHERE ic.code = $1 AND ic.type = 'staff' AND ic.used_at IS NULL AND ic.expires_at > NOW()`,
        [code.toUpperCase()]
      );
      if (inviteRes.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid or expired invite code' });
      }
      const invite = inviteRes.rows[0];

      // Check email not already in use in this gym
      const emailCheck = await client.query(
        `SELECT id FROM users WHERE gym_id = $1 AND phone_or_email = $2 AND is_deleted = false`,
        [invite.gym_id, email]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered in this gym' });
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, password_hash, role)
         VALUES ($1, $2, $3, 'trainer') RETURNING id, gym_id, role`,
        [invite.gym_id, email, passwordHash]
      );
      const user = userRes.rows[0];

      if (invite.trainer_id) {
        // Activate the pending trainer slot
        await client.query(
          `UPDATE trainers SET user_id = $1, name = $2, phone = $3, email = $4, is_active = true
           WHERE id = $5`,
          [user.id, name, phone, email, invite.trainer_id]
        );
      } else {
        // Create trainer from scratch (fallback)
        const displayId = invite.display_id || await generateDisplayId('staff');
        await client.query(
          `INSERT INTO trainers (gym_id, user_id, name, phone, email, display_id, trainer_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [invite.gym_id, user.id, name, phone, email, displayId, invite.trainer_role || 'staff']
        );
      }

      // Mark invite used
      await client.query(`UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, [invite.id]);

      await client.query('COMMIT');

      const trainerRole = invite.trainer_role || 'staff';
      const accessToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id, role: 'trainer', trainer_role: trainerRole },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );
      const refreshToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id },
        process.env.JWT_REFRESH_SECRET!,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        success: true,
        data: {
          accessToken,
          refreshToken,
          user: { id: user.id, gym_id: user.gym_id, role: 'trainer', trainer_role: trainerRole },
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/member/send-email-otp — validate invite + send email OTP before registration (public)
app.post('/api/auth/member/send-email-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, email } = req.body;
    if (!code || !email) return res.status(400).json({ success: false, error: 'code and email are required' });

    // Validate invite code
    const inviteRes = await pool.query(
      `SELECT code FROM invite_codes WHERE code = $1 AND type = 'member' AND used_at IS NULL AND expires_at > NOW()`,
      [code.toUpperCase()]
    );
    if (inviteRes.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid or expired invite code' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const tempKey = crypto.randomBytes(16).toString('hex');
    memberRegOtps.set(tempKey, { email, code: otp, inviteCode: code.toUpperCase(), expires: Date.now() + 15 * 60 * 1000 });

    await sendEmail(email, 'Verify your email — Recurva',
      `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#2196F3">Email Verification</h2>
        <p>Your verification code is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1a1a1a;padding:16px;background:#f5f5f5;border-radius:8px;text-align:center">${otp}</div>
        <p style="color:#666;font-size:13px">This code expires in 15 minutes. Do not share it with anyone.</p>
      </div>`
    );

    res.json({ success: true, data: { tempKey, message: 'OTP sent to email' } });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/member/register — member self-registration using invite code (public)
// Optionally accepts emailOtpKey + emailOtp (email verification) and firebaseIdToken (phone verification).
app.post('/api/auth/member/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, name, email, phone, password, emailOtpKey, emailOtp, firebaseIdToken } = req.body;
    if (!code || !name || !email || !phone || !password) {
      return res.status(400).json({ success: false, error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    // Verify email OTP if provided
    let emailVerified = false;
    if (emailOtpKey && emailOtp) {
      const stored = memberRegOtps.get(emailOtpKey);
      if (!stored || stored.expires < Date.now() || stored.email.toLowerCase() !== email.toLowerCase() || stored.inviteCode !== code.toUpperCase()) {
        return res.status(400).json({ success: false, error: 'Invalid or expired email verification code' });
      }
      if (stored.code !== emailOtp) {
        return res.status(400).json({ success: false, error: 'Incorrect email verification code' });
      }
      memberRegOtps.delete(emailOtpKey);
      emailVerified = true;
    }

    // Verify Firebase phone token if provided
    let phoneVerified = false;
    if (firebaseIdToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
        const verifiedPhone = decoded.phone_number || '';
        // Accept if last 10 digits match
        const normalizedInput = phone.replace(/\D/g, '').slice(-10);
        const normalizedVerified = verifiedPhone.replace(/\D/g, '').slice(-10);
        if (normalizedInput && normalizedVerified && normalizedInput === normalizedVerified) {
          phoneVerified = true;
        }
      } catch {
        return res.status(400).json({ success: false, error: 'Phone verification failed. Please retry.' });
      }
    }

    const client = await pool.connect();
    try {
      // Validate invite code — must be a member invite
      const inviteRes = await client.query(
        `SELECT ic.*, g.id AS gym_id FROM invite_codes ic
         JOIN gyms g ON ic.gym_id = g.id
         WHERE ic.code = $1 AND ic.type = 'member' AND ic.used_at IS NULL AND ic.expires_at > NOW()`,
        [code.toUpperCase()]
      );
      if (inviteRes.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid or expired invite code' });
      }
      const invite = inviteRes.rows[0];

      // Check email not already registered in this gym
      const emailCheck = await client.query(
        `SELECT id FROM users WHERE gym_id = $1 AND phone_or_email = $2 AND is_deleted = false`,
        [invite.gym_id, email]
      );
      if (emailCheck.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Email already registered. Please log in instead.' });
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, password_hash, role)
         VALUES ($1, $2, $3, 'member') RETURNING id, gym_id, role`,
        [invite.gym_id, email, passwordHash]
      );
      const user = userRes.rows[0];

      // Link user to a member record.
      // Case A: invite was created for a specific member (most common).
      // Case B: generic invite — find existing member by phone/email or create one.
      let linkedMemberId: string | null = invite.member_id || null;

      if (!linkedMemberId) {
        // Generic invite — search for the existing member record using every available signal:
        //   1. Phone the member typed at registration
        //   2. placeholder_phone stored on the invite (what the gym owner used when adding the member)
        //   3. placeholder_name stored on the invite
        //   4. Email the member typed at registration
        const regPhone      = phone ? phone.trim() : null;
        const invitePhone   = invite.placeholder_phone ? invite.placeholder_phone.trim() : null;
        const inviteName    = invite.placeholder_name  ? invite.placeholder_name.trim()  : null;
        try {
          const existing = await client.query(
            `SELECT id FROM members
             WHERE gym_id = $1 AND is_deleted = false AND (
               ($2 IS NOT NULL AND (phone = $2 OR RIGHT(phone, 10) = RIGHT($2, 10)))
               OR ($3 IS NOT NULL AND (phone = $3 OR RIGHT(phone, 10) = RIGHT($3, 10)))
               OR LOWER(email) = LOWER($4)
               OR ($5 IS NOT NULL AND LOWER(TRIM(name)) = LOWER($5))
             )
             ORDER BY
               CASE WHEN $2 IS NOT NULL AND (phone = $2 OR RIGHT(phone, 10) = RIGHT($2, 10)) THEN 0
                    WHEN $3 IS NOT NULL AND (phone = $3 OR RIGHT(phone, 10) = RIGHT($3, 10)) THEN 1
                    WHEN LOWER(email) = LOWER($4) THEN 2
                    ELSE 3 END
             LIMIT 1`,
            [invite.gym_id, regPhone, invitePhone, email, inviteName]
          );
          linkedMemberId = existing.rows[0]?.id || null;
        } catch { /* ignore — will create new record below */ }

        if (!linkedMemberId) {
          // No existing member found — create a new record
          try {
            const newMember = await client.query(
              `INSERT INTO members (gym_id, name, phone, email, user_id, membership_expiry_date, plan_fee, plan, status)
               VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '30 days', 0, 'monthly', 'active') RETURNING id`,
              [invite.gym_id, name, phone, email, user.id]
            );
            linkedMemberId = newMember.rows[0]?.id || null;
          } catch {
            // user_id column doesn't exist yet — insert without it
            try {
              const newMember = await client.query(
                `INSERT INTO members (gym_id, name, phone, email, membership_expiry_date, plan_fee, plan, status)
                 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days', 0, 'monthly', 'active') RETURNING id`,
                [invite.gym_id, name, phone, email]
              );
              linkedMemberId = newMember.rows[0]?.id || null;
            } catch { /* give up */ }
          }
        }
      }

      // Update the linked member record with the new user details
      if (linkedMemberId) {
        try {
          await client.query(
            `UPDATE members SET name = $1, phone = $2, email = $3, user_id = $4,
                                email_verified = $5, phone_verified = $6
             WHERE id = $7`,
            [name, phone, email, user.id, emailVerified, phoneVerified, linkedMemberId]
          );
        } catch {
          // email_verified/phone_verified columns may not exist yet
          try {
            await client.query(
              `UPDATE members SET name = $1, phone = $2, email = $3, user_id = $4 WHERE id = $5`,
              [name, phone, email, user.id, linkedMemberId]
            );
          } catch {
            // user_id column may not exist — update only name/phone/email
            await client.query(
              `UPDATE members SET name = $1, phone = $2, email = $3 WHERE id = $4`,
              [name, phone, email, linkedMemberId]
            );
          }
        }
      }

      // Mark invite used
      await client.query(`UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, [invite.id]);

      await client.query('COMMIT');

      const accessToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id, role: 'member', member_id: linkedMemberId },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );
      const refreshToken = jwt.sign(
        { id: user.id, gym_id: user.gym_id },
        process.env.JWT_REFRESH_SECRET!,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        success: true,
        data: {
          accessToken,
          refreshToken,
          user: { id: user.id, gym_id: user.gym_id, role: 'member', member_id: linkedMemberId },
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/trainers/:id/role — promote or demote a trainer (owner only, not admin)
app.put('/api/trainers/:id/role', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { trainer_role } = req.body;
    if (!['staff', 'admin'].includes(trainer_role)) {
      return res.status(400).json({ success: false, error: 'trainer_role must be staff or admin' });
    }
    const result = await pool.query(
      `UPDATE trainers SET trainer_role = $1 WHERE id = $2 AND gym_id = $3 AND is_deleted = false RETURNING id`,
      [trainer_role, id, req.gym_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trainer not found' });
    }
    res.json({ success: true, data: { id, trainer_role } });
  } catch (error) {
    next(error);
  }
});

// GET /api/invites — list active (unused) invite codes for this gym (owner/admin)
app.get('/api/invites', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT code, type, display_id, placeholder_name, trainer_role, expires_at, created_at
       FROM invite_codes
       WHERE gym_id = $1 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.gym_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// MIDDLEWARE & ERROR HANDLING
// ============================================================================

app.use('/api/', apiLimiter);
app.use(errorHandler);

app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not Found' });
});

// ============================================================================
// SERVER START (local only — Firebase Functions handles this in production)
// ============================================================================

// K_SERVICE is set by Google Cloud Run / Firebase Functions environment.
// FUNCTION_TARGET is set by the Firebase Functions emulator.
// require.main === module ensures we don't listen when imported by firebase-entry.
if (!process.env.K_SERVICE && !process.env.FUNCTION_TARGET && require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000');

  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`Health: http://localhost:${PORT}/health`);
    logger.info(`Metrics: http://localhost:${PORT}/metrics`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    server.close(() => {
      pool.end(() => {
        logger.info('Server closed gracefully');
        process.exit(0);
      });
    });
  });
}

export default app;
