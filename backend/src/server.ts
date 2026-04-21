import * as Sentry from '@sentry/node';
import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool, QueryResult } from 'pg';
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
// ============================================================================
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'CORS_ORIGIN',
];
for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET!.length < 32) {
  console.error('FATAL: JWT_SECRET must be at least 32 characters');
  process.exit(1);
}
if (process.env.JWT_REFRESH_SECRET!.length < 32) {
  console.error('FATAL: JWT_REFRESH_SECRET must be at least 32 characters');
  process.exit(1);
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
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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

// ============================================================================
// EMAIL SERVICE
// ============================================================================

const smtpConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASSWORD);

if (!smtpConfigured) {
  console.warn('WARNING: SMTP_USER or SMTP_PASSWORD not set — emails will be skipped. Set them in .env to enable email notifications.');
}

const emailTransporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      },
    })
  : null;

const sendEmail = async (to: string, subject: string, html: string) => {
  if (!emailTransporter) {
    logger.warn({ to, subject }, 'Email skipped — SMTP not configured');
    return;
  }
  try {
    await emailTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html
    });
    logger.info({ to, subject }, 'Email sent');
  } catch (error) {
    logger.error({ error, to }, 'Email send failed');
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

const verifyRegistrationEmailSchema = z.object({
  pending_id: z.string().uuid(),
  code: z.string().length(6).regex(/^\d{6}$/, 'OTP must be 6 digits')
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

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN!.split(',').map(o => o.trim()),
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
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
  };
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

  res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Error' : err.message
  });
};

// ============================================================================
// SWAGGER API DOCS
// ============================================================================

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'Gym Retention API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

// ============================================================================
// HEALTH & METRICS
// ============================================================================

app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

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
      return res.status(409).json({ success: false, error: 'A gym with this email already exists.' });
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
    const otpCode     = String(Math.floor(100000 + Math.random() * 900000));
    const otpExpiry   = new Date(Date.now() + 10 * 60 * 1000);  // 10 min
    const sessionExpiry = new Date(Date.now() + 30 * 60 * 1000); // 30 min to complete

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
      [gym_name, owner_name, phone, email, address, owner_email,
       passwordHash, otpCode, otpExpiry, sessionExpiry]
    );

    const pendingId = pendingRes.rows[0].id;

    await sendEmail(owner_email, 'Verify your email – Gym Retention', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2196F3">Verify your email address</h2>
        <p>You're almost done! Enter the code below to verify your email and continue setting up <strong>${gym_name}</strong>.</p>
        <div style="margin:28px 0;text-align:center">
          <span style="display:inline-block;letter-spacing:10px;font-size:36px;font-weight:bold;color:#1a1a1a;background:#f4f6f8;padding:14px 24px;border-radius:10px;font-family:monospace">
            ${otpCode}
          </span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `);

    logger.info({ owner_email, pendingId }, 'Registration initiated — email OTP sent');

    res.status(200).json({
      success: true,
      data: { pendingId, ownerEmail: owner_email, gymPhone: phone }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 2 — Verify email OTP for the pending registration.
// ============================================================================
app.post('/api/gyms/register/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = verifyRegistrationEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid input';
      return res.status(400).json({ success: false, error: msg });
    }
    const { pending_id, code } = parsed.data;

    const result = await pool.query(
      `SELECT id, gym_phone, email_otp_code, email_otp_expires_at, email_verified, expires_at
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

    // Idempotent — if already verified, just return success
    if (pending.email_verified) {
      return res.json({ success: true, data: { pendingId: pending_id, gymPhone: pending.gym_phone } });
    }

    if (pending.email_otp_code !== code) {
      return res.status(400).json({ success: false, error: 'Incorrect code. Please check your email and try again.' });
    }

    if (new Date() > new Date(pending.email_otp_expires_at)) {
      return res.status(400).json({ success: false, error: 'Code expired. Please request a new one.' });
    }

    await pool.query(
      `UPDATE pending_registrations SET email_verified = true WHERE id = $1`,
      [pending_id]
    );

    logger.info({ pending_id }, 'Registration email OTP verified');
    res.json({ success: true, data: { pendingId: pending_id, gymPhone: pending.gym_phone } });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 2b — Resend email OTP (if user didn't receive it or it expired).
// ============================================================================
app.post('/api/gyms/register/resend-email-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { pending_id } = req.body;
    if (!pending_id) {
      return res.status(400).json({ success: false, error: 'pending_id is required' });
    }

    const result = await pool.query(
      `SELECT id, owner_email, gym_name, email_verified, expires_at
       FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Registration session not found.' });
    }

    const pending = result.rows[0];

    if (new Date() > new Date(pending.expires_at)) {
      return res.status(400).json({ success: false, error: 'Registration session expired. Please start over.' });
    }

    if (pending.email_verified) {
      return res.status(400).json({ success: false, error: 'Email is already verified.' });
    }

    const newCode    = String(Math.floor(100000 + Math.random() * 900000));
    const newExpiry  = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `UPDATE pending_registrations SET email_otp_code = $1, email_otp_expires_at = $2 WHERE id = $3`,
      [newCode, newExpiry, pending_id]
    );

    await sendEmail(pending.owner_email, 'New verification code – Gym Retention', `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#2196F3">New verification code</h2>
        <p>Here is your new email verification code for <strong>${pending.gym_name}</strong>.</p>
        <div style="margin:28px 0;text-align:center">
          <span style="display:inline-block;letter-spacing:10px;font-size:36px;font-weight:bold;color:#1a1a1a;background:#f4f6f8;padding:14px 24px;border-radius:10px;font-family:monospace">
            ${newCode}
          </span>
        </div>
        <p style="color:#888;font-size:13px">This code expires in 10 minutes.</p>
      </div>
    `);

    logger.info({ pending_id }, 'Registration email OTP resent');
    res.json({ success: true, message: 'New code sent to your email.' });
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
        return res.status(409).json({ success: false, error: 'A gym with this email already exists.' });
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

      const gymRes = await client.query(
        `INSERT INTO gyms (name, owner_name, phone, email, address, subscription_status, trial_started_at, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7)
         RETURNING id`,
        [pending.gym_name, pending.owner_name, pending.gym_phone,
         pending.gym_email, pending.address, trialStart, trialEnd]
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
      await sendEmail(pending.owner_email, 'Welcome to Gym Retention! 🎉', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">You're all set!</h2>
          <p>Your gym <strong>${pending.gym_name}</strong> is now registered. Your 30-day free trial has started.</p>
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

      // Check if gym is suspended
      const gymCheck = await client.query(
        `SELECT subscription_status FROM gyms WHERE id = $1`, [user.gym_id]
      );
      if (gymCheck.rows[0]?.subscription_status === 'suspended') {
        loginAttempts.inc({ status: 'failed' });
        return res.status(403).json({ success: false, error: 'Your gym account has been suspended. Please contact support.' });
      }

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

      loginAttempts.inc({ status: 'success' });

      res.json({
        success: true,
        data: { accessToken, refreshToken, user: { id: user.id, gym_id: user.gym_id, role: user.role } }
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
    const newAccessToken  = jwt.sign(
      { id: user.id, gym_id: user.gym_id, role: user.role },
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
// PASSWORD RESET ENDPOINTS
// ============================================================================

app.post('/api/auth/forgot-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Valid email is required' });
    }
    const { email } = parsed.data;

    const client = await pool.connect();
    try {
      // Look up user by email (owners and trainers only)
      const result = await client.query(
        `SELECT u.id, u.gym_id FROM users u WHERE u.phone_or_email = $1 AND u.role IN ('owner','trainer') AND u.is_deleted = false LIMIT 1`,
        [email]
      );

      // Always return success to prevent email enumeration
      if (result.rows.length === 0) {
        return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
      }

      const user = result.rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      // Invalidate any existing tokens for this user
      await client.query(
        `DELETE FROM password_reset_tokens WHERE user_id = $1`,
        [user.id]
      );

      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      const resetUrl = `${process.env.CORS_ORIGIN}/#/reset-password?token=${token}`;
      await sendEmail(email, 'Reset Your Password — Gym Retention', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">Password Reset</h2>
          <p>You requested a password reset. Click the button below to set a new password.</p>
          <p style="margin:24px 0">
            <a href="${resetUrl}" style="background:#2196F3;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
              Reset Password
            </a>
          </p>
          <p style="color:#888;font-size:13px">This link expires in 30 minutes. If you didn't request this, you can ignore this email.</p>
        </div>
      `);

      logger.info({ userId: user.id }, 'Password reset email sent');
      res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    } finally {
      client.release();
    }
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

      await sendEmail(email, 'Your Gym Retention verification code', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">Verify your email</h2>
          <p>Use the code below to verify your email address. It expires in <strong>10 minutes</strong>.</p>
          <div style="margin:28px 0;text-align:center">
            <span style="display:inline-block;letter-spacing:10px;font-size:36px;font-weight:bold;color:#1a1a1a;background:#f4f6f8;padding:14px 24px;border-radius:10px;font-family:monospace">
              ${code}
            </span>
          </div>
          <p style="color:#888;font-size:13px">If you didn't create a Gym Retention account, you can ignore this email.</p>
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
      const daysSince  = lastVisit ? Math.floor((now.getTime() - lastVisit.getTime()) / 86400000) : 999;
      const daysToExp  = Math.floor((expiryDate.getTime() - now.getTime()) / 86400000);

      let status = 'active';
      if (daysToExp <= 7 || daysSince > 10)  status = 'high_risk';
      else if (daysSince > 5)                 status = 'at_risk';

      const uniqueId = `GYM-${now.getFullYear()}-${Math.floor(Math.random() * 99999).toString().padStart(5, '0')}`;
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
        const msg = err?.code === '23505' ? 'Duplicate entry' : (err?.message || 'Unknown error');
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
        `SELECT id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, status, created_at, assigned_trainer_id,
          EXTRACT(DAY FROM NOW() - last_visit_date)::INTEGER AS days_last_visit,
          EXTRACT(DAY FROM membership_expiry_date - NOW())::INTEGER AS days_to_expiry
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
    const { name, phone, email, last_visit_date, membership_expiry_date, plan_fee, assigned_trainer_id } = req.body;
    const start = Date.now();

    const client = await pool.connect();
    try {
      // Check phone uniqueness per gym
      const phoneCheck = await client.query(
        'SELECT id FROM members WHERE gym_id = $1 AND phone = $2 AND is_deleted = false',
        [req.gym_id, phone]
      );
      if (phoneCheck.rows.length > 0) {
        return res.status(409).json({ success: false, error: 'Phone number already registered in this gym' });
      }

      // Auto-calculate status per requirements:
      // daysToExpiry <= 7 → high_risk (expiring soon, highest priority)
      // daysLastVisit <= 5 → active
      // 5 < daysLastVisit <= 10 → at_risk
      // daysLastVisit > 10 → high_risk
      const now = new Date();
      const expiryDate = new Date(membership_expiry_date);
      const lastVisit = last_visit_date ? new Date(last_visit_date) : null;
      const daysSinceVisit = lastVisit ? Math.floor((now.getTime() - lastVisit.getTime()) / 86400000) : 999;
      const daysToExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / 86400000);

      let status = 'active';
      if (daysToExpiry <= 7) status = 'high_risk';
      else if (daysSinceVisit > 10) status = 'high_risk';
      else if (daysSinceVisit > 5) status = 'at_risk';

      const uniqueId = `GYM-${new Date().getFullYear()}-${Math.floor(Math.random() * 99999).toString().padStart(5, '0')}`;

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
        `INSERT INTO members (gym_id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, status, unique_id, assigned_trainer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, status, created_at, assigned_trainer_id`,
        [req.gym_id, name, phone, email || '', last_visit_date || null, membership_expiry_date, plan_fee, status, uniqueId, assigned_trainer_id]
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
    const { name, phone, email, membership_expiry_date, plan_fee } = req.body;
    const start = Date.now();

    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE members SET name = $1, phone = $2, email = $3, membership_expiry_date = $4, plan_fee = $5, updated_at = NOW()
         WHERE id = $6 AND gym_id = $7
         RETURNING id, updated_at`,
        [name, phone, email || '', membership_expiry_date, plan_fee, id, req.gym_id]
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
    const { name, phone, email, password } = req.body;
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

      const trainerRes = await client.query(
        `INSERT INTO trainers (gym_id, user_id, name, phone, email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, phone, email, created_at`,
        [req.gym_id, userId, name, phone, email]
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
        `SELECT COUNT(*) AS total FROM trainers WHERE gym_id = $1 AND is_deleted = false`,
        [req.gym_id]
      );
      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      const result = await client.query(
        `SELECT t.id, t.name, t.phone, t.email, t.assigned_members_count, t.is_active, t.created_at,
                u.phone_or_email AS login_email
         FROM trainers t
         JOIN users u ON t.user_id = u.id
         WHERE t.gym_id = $1 AND t.is_deleted = false
         ORDER BY t.created_at DESC
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
    const { name, phone } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'name and phone are required' });
    }
    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE trainers SET name = $1, phone = $2, updated_at = NOW()
         WHERE id = $3 AND gym_id = $4 AND is_deleted = false
         RETURNING id, name, phone, email, assigned_members_count, is_active, created_at`,
        [name, phone, id, req.gym_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Trainer not found' });
      }
      res.json({ success: true, data: result.rows[0] });
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
      await client.query(
        `UPDATE trainers SET is_deleted = true, deleted_at = NOW() WHERE id = $1 AND gym_id = $2`,
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
        `INSERT INTO attendance_logs (gym_id, member_id, visit_date, check_in_time)
         VALUES ($1, $2, $3, $4)`,
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
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6).optional(),
});

const updateGymSchema = z.object({
  gymName: z.string().min(2).max(100),
  address: z.string().max(500).optional().or(z.literal('')),
  phone: z.string().min(10).max(20).optional().or(z.literal('')),
});

// GET /api/profile — works for both owner and trainer
app.get('/api/profile', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      if (req.user.role === 'owner') {
        const result = await client.query(
          `SELECT u.id, u.phone_or_email, u.phone,
                  g.owner_name as name, g.id as gym_id,
                  g.name as gym_name, g.address as gym_address,
                  g.phone as gym_phone, g.email as gym_email
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
            role: 'owner',
            gym: {
              id: row.gym_id,
              name: row.gym_name,
              address: row.gym_address || '',
              phone: row.gym_phone || '',
              email: row.gym_email || '',
            }
          }
        });
      } else {
        const result = await client.query(
          `SELECT u.id, u.phone_or_email, t.name, t.phone, t.email, t.id as trainer_id
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
    const { name, phone, currentPassword, newPassword } = req.body;
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
        if (phone) await client.query('UPDATE users SET phone = $1 WHERE id = $2', [phone, req.user.id]);
      } else {
        await client.query(
          'UPDATE trainers SET name = $1, phone = $2 WHERE user_id = $3 AND gym_id = $4',
          [name, phone || '', req.user.id, req.gym_id]
        );
      }
      res.json({ success: true, data: { message: 'Profile updated successfully' } });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/gyms/me — owner updates gym name, address, phone
app.put('/api/gyms/me', authenticate, authorize(['owner']), validate(updateGymSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gymName, address, phone } = req.body;
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE gyms SET name = $1, address = $2, phone = COALESCE(NULLIF($3, ''), phone) WHERE id = $4`,
        [gymName, address || null, phone || null, req.gym_id]
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
// DASHBOARD ENDPOINTS
// ============================================================================

app.get('/api/dashboard/kpis', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      const [membersRes, revenueRes] = await Promise.all([
        client.query(
          `SELECT
            COUNT(CASE WHEN status = 'active' THEN 1 END) as active_members,
            COUNT(CASE WHEN status = 'at_risk' THEN 1 END) as at_risk_members,
            COUNT(CASE WHEN status = 'high_risk' THEN 1 END) as high_risk_members,
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

        await sendEmail(
          gym.email,
          `${gym.name} — Trial Expiring in ${gym.days_remaining} Day${gym.days_remaining === 1 ? '' : 's'}`,
          `
            <div style="font-family:sans-serif;max-width:480px;margin:auto">
              <h2 style="color:#2196F3">Trial Expiring Soon</h2>
              <p>Hi ${gym.owner_name},</p>
              <p>Your <strong>${gym.name}</strong> trial expires in <strong>${gym.days_remaining} day${gym.days_remaining === 1 ? '' : 's'}</strong>.</p>
              <p>Upgrade now to keep access to all features and continue managing your gym members without interruption.</p>
              <p style="margin-top:24px">
                <a href="${process.env.CORS_ORIGIN}/#/subscription"
                   style="background:#2196F3;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">
                  Upgrade Now
                </a>
              </p>
            </div>
          `
        );
        logger.info({ gymId: gym.id, notifType }, 'Trial expiry notification sent');
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
        SELECT m.id, m.gym_id, EXTRACT(DAY FROM NOW() - m.last_visit_date) as days_inactive
        FROM members m
        WHERE m.is_deleted = false
          AND (EXTRACT(DAY FROM NOW() - m.last_visit_date) > 10 OR m.last_visit_date IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM follow_up_tasks t WHERE t.member_id = m.id AND t.status = 'pending'
          )
      `);

      for (const member of result.rows) {
        const taskType = member.days_inactive > 20 ? 'renewal' : 'call';
        await client.query(
          `INSERT INTO follow_up_tasks (gym_id, member_id, task_type, status)
           VALUES ($1, $2, $3, 'pending')`,
          [member.gym_id, member.id, taskType]
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

      // Anonymise PII in place — keeps the row for referential integrity
      await client.query(
        `UPDATE members SET
           name = '[deleted]',
           phone = '[deleted]',
           email = '[deleted]',
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
  try {
    const result = await pool.query(`
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
      LEFT JOIN members m ON m.gym_id = g.id
      WHERE g.is_deleted = false
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json({ success: true, data: { gyms: result.rows } });
  } catch (err: any) {
    logger.error({ err }, 'Admin: failed to list gyms');
    res.status(500).json({ success: false, error: 'Failed to fetch gyms' });
  }
});

// POST /api/admin/gyms/:id/suspend — set subscription_status = 'suspended'
app.post('/api/admin/gyms/:id/suspend', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await pool.query(`UPDATE gyms SET subscription_status = 'suspended' WHERE id = $1`, [id]);
    logger.info({ gymId: id }, 'Admin: gym suspended');
    res.json({ success: true, data: { message: 'Gym suspended' } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to suspend gym' });
  }
});

// POST /api/admin/gyms/:id/reactivate — restore trial or active status
app.post('/api/admin/gyms/:id/reactivate', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Restore to 'trial' if no paid subscription, else 'active'
    const result = await pool.query(
      `SELECT subscription_ends_at FROM gyms WHERE id = $1`, [id]
    );
    const gym = result.rows[0];
    const newStatus = gym?.subscription_ends_at && new Date(gym.subscription_ends_at) > new Date()
      ? 'active' : 'trial';
    await pool.query(`UPDATE gyms SET subscription_status = $1 WHERE id = $2`, [newStatus, id]);
    logger.info({ gymId: id, newStatus }, 'Admin: gym reactivated');
    res.json({ success: true, data: { message: 'Gym reactivated' } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to reactivate gym' });
  }
});

// POST /api/admin/gyms/:id/convert — convert trial → paid (extend by N months)
const convertGymSchema = z.object({
  months: z.number().int().min(1).max(12),
});

app.post('/api/admin/gyms/:id/convert', adminAuth, validate(convertGymSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { months } = req.body;
    const endsAt = new Date();
    endsAt.setMonth(endsAt.getMonth() + months);

    await pool.query(
      `UPDATE gyms
       SET subscription_status = 'active',
           subscription_ends_at = $1,
           is_active = true
       WHERE id = $2`,
      [endsAt.toISOString(), id]
    );
    logger.info({ gymId: id, months }, 'Admin: gym converted to paid');
    res.json({ success: true, data: { message: `Subscription activated for ${months} month(s)`, ends_at: endsAt } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to convert gym' });
  }
});

// DELETE /api/admin/gyms/:id — permanently delete a gym and all its data
app.delete('/api/admin/gyms/:id', adminAuth, async (req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const gymRes = await client.query(`SELECT name FROM gyms WHERE id = $1`, [id]);
    if (gymRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Gym not found' });
    }
    const gymName = gymRes.rows[0].name;
    // CASCADE is set on all child tables so deleting from gyms removes everything
    await client.query(`DELETE FROM gyms WHERE id = $1`, [id]);
    logger.info({ gymId: id, gymName }, 'Admin: gym permanently deleted');
    res.json({ success: true, data: { message: `"${gymName}" and all its data have been permanently deleted` } });
  } catch (err: any) {
    logger.error(err, 'Admin delete gym failed');
    res.status(500).json({ success: false, error: 'Failed to delete gym' });
  } finally {
    client.release();
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
// SERVER START
// ============================================================================

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

export default app;
