import * as Sentry from '@sentry/node';
import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
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

// Must be registered BEFORE pool creation — pg-pool opens min:2 connections immediately
// in the constructor, and SCRAM auth failures from local pg version throw uncaught exceptions
// before any pool.on('error') or process.on handlers registered after the constructor.
process.on('uncaughtException', (err: Error) => {
  if (err.message?.includes('authenticationOk') || err.message?.includes('Unknown auth')) return;
  // re-throw to existing handler further down in the file
});

// Pool tuned for Supabase transaction pooler (port 6543) + Cloud Run multi-instance.
// Cloud Run can spin up multiple container instances; each gets this pool.
// Supabase transaction pooler allows many connections but short-lived; keep max low.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:                    parseInt(process.env.DATABASE_POOL_SIZE || '10'),
  min:                    0,
  idleTimeoutMillis:      20000,
  connectionTimeoutMillis: process.env.K_SERVICE ? 8000 : 1000,
  // Set a statement timeout so runaway queries never block the pool
  statement_timeout:      parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '30000'),
  query_timeout:          parseInt(process.env.DB_QUERY_TIMEOUT_MS    || '30000'),
  application_name:       `recurva-api-${process.env.K_REVISION || 'local'}`,
});

pool.on('error', (err) => {
  logger.error({ error: err }, 'Database pool error');
});

// pg-protocol throws uncaught exceptions for SCRAM auth mismatches in local dev env.
// This handler prevents those from crashing the process (safe to ignore — production connects fine).
process.on('uncaughtException', (err: Error) => {
  if (err.message?.includes('authenticationOk') || err.message?.includes('Unknown auth')) return;
  logger.error({ err }, 'Uncaught exception');
  process.exit(1);
});

// Pool health metrics
pool.on('connect', () => {
  const size = pool.totalCount;
  if (size > 8) logger.warn({ poolSize: size }, 'DB pool nearly full');
});

// Startup migrations — only run in production (Cloud Run, K_SERVICE set).
// Skipping locally prevents Firebase CLI probe from timing out due to DB auth errors.
// Also skip when FUNCTION_TARGET is set (Firebase CLI local analysis mode).
const _isProductionRun = !!process.env.K_SERVICE && !process.env.FUNCTION_TARGET;
if (_isProductionRun) {
// Add missing columns to users table (idempotent migrations)
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`).catch(() => {});
setImmediate(() => {
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)`).catch(() => {});
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  pool.query(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL AND is_deleted = false`).catch(() => {});
});
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
pool.query(`ALTER TABLE follow_up_tasks ADD COLUMN IF NOT EXISTS issue_type VARCHAR(30)`).catch(() => {});
pool.query(`ALTER TABLE follow_up_tasks ADD COLUMN IF NOT EXISTS custom_issue TEXT`).catch(() => {});
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
pool.query(`ALTER TABLE revenue_records ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30)`).catch(() => {});

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

// ── Task feature enhancements ─────────────────────────────────────────────────
pool.query(`ALTER TABLE follow_up_tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(10) NOT NULL DEFAULT 'medium'`).catch(() => {});
pool.query(`ALTER TABLE follow_up_tasks ADD COLUMN IF NOT EXISTS due_date DATE NOT NULL DEFAULT CURRENT_DATE`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_gym_due ON follow_up_tasks(gym_id, due_date)`).catch(() => {});

// ── Photo URL columns ─────────────────────────────────────────────────────────
pool.query(`ALTER TABLE trainers ADD COLUMN IF NOT EXISTS profile_photo_url TEXT`).catch(() => {});
pool.query(`ALTER TABLE members  ADD COLUMN IF NOT EXISTS profile_photo_url TEXT`).catch(() => {});
pool.query(`ALTER TABLE gyms     ADD COLUMN IF NOT EXISTS owner_photo_url   TEXT`).catch(() => {});

// ── Multi-location: owner_user_id links each gym to its owning user ───────────
pool.query(`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS owner_user_id UUID`).catch(() => {});
pool.query(`
  UPDATE gyms g SET owner_user_id = u.id
  FROM users u
  WHERE u.gym_id = g.id AND u.role = 'owner' AND g.owner_user_id IS NULL
`).catch((e: unknown) => { console.error('owner_user_id backfill error:', e); });
// Allow same owner to reuse their email/phone across multiple gym locations
pool.query(`ALTER TABLE gyms DROP CONSTRAINT IF EXISTS gyms_email_key`).catch(() => {});
pool.query(`ALTER TABLE gyms DROP CONSTRAINT IF EXISTS gyms_phone_key`).catch(() => {});
// All contact fields are optional for branch locations
pool.query(`ALTER TABLE gyms ALTER COLUMN email DROP NOT NULL`).catch(() => {});
pool.query(`ALTER TABLE gyms ALTER COLUMN phone DROP NOT NULL`).catch(() => {});
pool.query(`ALTER TABLE gyms ALTER COLUMN address DROP NOT NULL`).catch(() => {});

// ── Attendance status column (present/absent explicit tracking) ───────────────
pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS status VARCHAR(10) DEFAULT 'present'`).catch(() => {});

// ── Extend id_sequences key column for scoped Option-A UID keys ──────────────
// Keys like "mem__<uuid>" and "stf__<uuid>" are up to 42 chars; old default VARCHAR(20) was too short.
pool.query(`ALTER TABLE id_sequences ALTER COLUMN entity_type TYPE VARCHAR(50)`).catch(() => {});

// ── pg_trgm extension for fast ILIKE '%search%' (makes O(N) → O(log N)) ─────
pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_name_trgm  ON members USING GIN(name  gin_trgm_ops) WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_phone_trgm ON members USING GIN(phone gin_trgm_ops) WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_email_trgm ON members USING GIN(email gin_trgm_ops) WHERE email IS NOT NULL AND is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_trainers_name_trgm ON trainers USING GIN(name  gin_trgm_ops) WHERE is_deleted = false`).catch(() => {});

// ── PERFORMANCE INDEXES (idempotent — safe to run on every cold start) ─────────
// These are critical for query performance at scale (100k+ members).
// Members: most common queries filter by gym_id + status, gym_id + expiry, gym_id + phone
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_gym_status   ON members(gym_id, is_deleted)  WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_gym_expiry   ON members(gym_id, membership_expiry_date) WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_gym_phone    ON members(gym_id, phone)        WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_gym_created  ON members(gym_id, created_at DESC) WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_members_trainer      ON members(assigned_trainer_id)  WHERE assigned_trainer_id IS NOT NULL AND is_deleted = false`).catch(() => {});
// Tasks: filter by gym + status + trainer
pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_gym_status     ON follow_up_tasks(gym_id, status)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_trainer_status ON follow_up_tasks(assigned_trainer_id, status) WHERE assigned_trainer_id IS NOT NULL`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_member         ON follow_up_tasks(member_id)`).catch(() => {});
// Attendance: filter by gym + member + date range
pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_gym_date  ON attendance_logs(gym_id, visit_date DESC)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_member    ON attendance_logs(member_id, visit_date DESC)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_visited   ON attendance_logs(member_id, visited_at DESC) WHERE visited_at IS NOT NULL`).catch(() => {});
// Revenue: filter by gym + tracked_at
pool.query(`CREATE INDEX IF NOT EXISTS idx_revenue_gym_date     ON revenue_records(gym_id, tracked_at DESC)`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_revenue_member       ON revenue_records(member_id, tracked_at DESC)`).catch(() => {});
// Payments (Razorpay): filter by gym + created_at
pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_gym_created ON payments(gym_id, created_at DESC) WHERE status = 'completed'`).catch(() => {});
// Users: login by phone_or_email + role
pool.query(`CREATE INDEX IF NOT EXISTS idx_users_login          ON users(phone_or_email, role) WHERE is_deleted = false`).catch(() => {});
pool.query(`CREATE INDEX IF NOT EXISTS idx_users_gym_role       ON users(gym_id, role)         WHERE is_deleted = false`).catch(() => {});
// Trainers: filter by gym
pool.query(`CREATE INDEX IF NOT EXISTS idx_trainers_gym         ON trainers(gym_id)             WHERE is_deleted = false`).catch(() => {});
// Activity log: filter by gym + created_at
pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_gym_time    ON activity_log(gym_id, created_at DESC)`).catch(() => {}).catch(() => {});
} // end if (process.env.K_SERVICE) startup migrations

// ── Backfill display IDs (production only) ────────────────────────────────────────────────────
if (_isProductionRun) (async () => {
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
  verified?: boolean;
}
export const memberRegOtps = new Map<string, MemberRegOtp>();
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

// ============================================================================
// OPTION-A DISPLAY ID SYSTEM
//
// Format:  {OWNER_HASH}-{GYM_TAG}-{TYPE}{SEQ_BASE36}
//   OWNER_HASH  — 4-char base-36 derived from the owner's user UUID (non-sequential,
//                 non-guessable, deterministic per owner)
//   GYM_TAG     — G + 1-2 char base-36 index of this gym within the owner's portfolio
//   TYPE        — M (member) | S (staff) | G (gym)
//   SEQ_BASE36  — 3-char base-36 sequential counter scoped to owner+gym+type
//                 (supports 46,656 per type; auto-expands to 4 chars after that)
//
// Examples:
//   Owner UUID hash → NDYO
//   Gym #1  → NDYO-G1
//   Gym #2  → NDYO-G2
//   Member #1  in Gym 1 → NDYO-G1-M001
//   Member #47 in Gym 1 → NDYO-G1-M01B   (47 in base-36)
//   Staff  #3  in Gym 1 → NDYO-G1-S003
//   Staff  #1  in Gym 2 → NDYO-G2-S001
// ============================================================================

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toBase36(n: number, minLen = 1): string {
  if (n === 0) return '0'.repeat(minLen);
  let s = '';
  let v = n;
  while (v > 0) { s = B36[v % 36] + s; v = Math.floor(v / 36); }
  return s.padStart(minLen, '0');
}

/** Derives a 4-char base-36 owner tag from the owner's UUID.
 *  Uses first 8 hex chars (32-bit) → mod 36^4.  Deterministic, non-sequential. */
function ownerTag(userId: string): string {
  const hex = userId.replace(/-/g, '').slice(0, 8);
  const num = parseInt(hex, 16);
  return toBase36(num % Math.pow(36, 4), 4);
}

/** Returns the 1-2 char base-36 index of this gym within the owner's portfolio.
 *  Gym created first → 1, second → 2 … up to ZZ (1,295). */
async function gymIndex(gymId: string, ownerUserId: string): Promise<number> {
  const res = await pool.query(
    `SELECT ROW_NUMBER() OVER (ORDER BY created_at ASC) AS idx
     FROM gyms WHERE owner_user_id = $1 AND is_deleted = false
     HAVING id = $2 OR TRUE
     ORDER BY created_at ASC`,
    [ownerUserId, gymId]
  );
  // Simpler approach: rank this gym among owner's gyms by created_at
  const ranked = await pool.query(
    `SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
     FROM gyms WHERE owner_user_id = $1 AND is_deleted = false`,
    [ownerUserId]
  );
  const row = ranked.rows.find((r: any) => r.id === gymId);
  return row ? Number(row.rn) : 1;
}

/** Generates a new display ID for a gym.
 *  Sequence key: gym__{ownerUserId}  (scoped per owner). */
async function generateGymDisplayId(ownerUserId: string): Promise<string> {
  const seqKey = `gym__${ownerUserId}`;
  await pool.query(
    `INSERT INTO id_sequences (entity_type, last_value) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [seqKey]
  );
  const res = await pool.query(
    `UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = $1 RETURNING last_value`,
    [seqKey]
  );
  const n   = Number(res.rows[0].last_value);
  const tag = ownerTag(ownerUserId);
  return `${tag}-G${toBase36(n)}`;
}

/** Generates a new display ID for a member or staff member.
 *  Sequence key: mem__{gymId} or stf__{gymId}  (scoped per gym). */
async function generateEntityDisplayId(
  gymId: string,
  ownerUserId: string,
  type: 'member' | 'staff'
): Promise<string> {
  const prefix  = type === 'member' ? 'mem' : 'stf';
  const typeChar = type === 'member' ? 'M' : 'S';
  const seqKey  = `${prefix}__${gymId}`;

  await pool.query(
    `INSERT INTO id_sequences (entity_type, last_value) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [seqKey]
  );
  const res = await pool.query(
    `UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = $1 RETURNING last_value`,
    [seqKey]
  );
  const n = Number(res.rows[0].last_value);

  // Get gym display_id prefix (owner_hash + gym index)
  const gymRes = await pool.query(
    `SELECT display_id, owner_user_id FROM gyms WHERE id = $1 LIMIT 1`,
    [gymId]
  );
  let gymPrefix = '';
  if (gymRes.rows.length > 0 && gymRes.rows[0].display_id) {
    // Existing gym with new-format display_id e.g. "NDYO-G1"
    gymPrefix = gymRes.rows[0].display_id;
  } else {
    // Gym has old-format display_id — compute prefix on the fly
    const oUserId = ownerUserId || gymRes.rows[0]?.owner_user_id || '';
    const tag     = oUserId ? ownerTag(oUserId) : 'XXXX';
    const gIdx    = oUserId ? await gymIndex(gymId, oUserId) : 1;
    gymPrefix     = `${tag}-G${toBase36(gIdx)}`;
  }

  // 3-char base-36 sequence (auto-expands to 4 after 46,656)
  const seqStr = n < 46656 ? toBase36(n, 3) : toBase36(n, 4);
  return `${gymPrefix}-${typeChar}${seqStr}`;
}

// Legacy function kept for backward compat (startup backfill uses it for old records)
async function generateDisplayId(entityType: 'business' | 'staff' | 'member'): Promise<string> {
  await pool.query(
    `INSERT INTO id_sequences (entity_type, last_value) VALUES ($1, 0) ON CONFLICT DO NOTHING`,
    [entityType]
  );
  const result = await pool.query(
    'UPDATE id_sequences SET last_value = last_value + 1 WHERE entity_type = $1 RETURNING last_value',
    [entityType]
  );
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
  task_type: z.enum(['call', 'renewal', 'renew_plan', 'check_in', 'check_progress', 'remind_to_pay', 'send_message', 'custom']),
  issue_type: z.enum(['attendance', 'renew_plan', 'custom']).optional(),
  custom_issue: z.string().max(500).optional(),
  assigned_trainer_id: z.string().uuid().optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  due_date: z.string().optional(),
  notes: z.string().max(1000).optional()
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

// ── Gzip compression — reduces response payload 60-80% for JSON ───────────────
app.use(compression({
  level: 6,                      // zlib level 6 = good compression/CPU balance
  threshold: 1024,               // only compress responses > 1 KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

app.use(helmet({
  contentSecurityPolicy: false,  // API — no HTML, CSP not needed
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: (process.env.CORS_ORIGIN || '*').split(',').map(o => o.trim()),
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With'],
  maxAge: 86400,                 // preflight cache: 24h
}));

// ── Global request timeout — kill zombie connections at 25s ──────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setTimeout(25000, () => {
    if (!res.headersSent) {
      res.status(200).json({ status: false, data: [], message: 'Request timeout. Please try again.', statusCode: 200 });
    }
  });
  next();
});

// HTTPS enforcement
app.use((req: Request, res: Response, next: NextFunction) => {
  const proto = req.header('x-forwarded-proto') || req.protocol;
  if (proto !== 'https' && process.env.NODE_ENV === 'production') {
   // return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});

// 10mb covers bulk-import (~5000 rows). JSON parse errors auto-return 400.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ============================================================================
// RATE LIMITING
// ============================================================================

// Auth: 10 attempts per 15 min per IP (login, OTP, reset)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Auth rate limit exceeded');
    loginAttempts.inc({ status: 'rate_limited' });
    res.status(200).json({ status: false, data: [], message: 'Too many attempts. Please wait 15 minutes and try again.', statusCode: 200 });
  },
});

// General API: 300 req/min per IP — generous for legitimate app usage
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: (_req, res) => {
    res.status(200).json({ status: false, data: [], message: 'Rate limit exceeded. Please slow down.', statusCode: 200 });
  },
  skip: (req) => req.path === '/health' || req.path === '/api/health',
});

// Bulk-import: 5 req/min per IP (large uploads are slow — prevent abuse)
const bulkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  handler: (_req, res) => {
    res.status(200).json({ status: false, data: [], message: 'Bulk import rate limit exceeded. Max 5 imports per minute.', statusCode: 200 });
  },
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
        const firstError = error.errors[0];
        const fieldMsg = firstError ? `${firstError.path.join('.') || 'field'}: ${firstError.message}` : 'Validation failed';
        return res.status(200).json({
          status: false, data: [], message: fieldMsg, statusCode: 200,
          errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message }))
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
      return res.status(401).json({ status: false, data: [], message: 'Missing token', statusCode: 401 });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    if (!decoded.gym_id) {
      return res.status(401).json({ status: false, data: [], message: 'Invalid token', statusCode: 401 });
    }

    // Immediately reject if gym is blocked (takes effect even with a valid JWT)
    try {
      const gymCheck = await pool.query(
        `SELECT is_blocked FROM gyms WHERE id = $1 AND is_deleted = false LIMIT 1`,
        [decoded.gym_id]
      );
      if (!gymCheck.rows.length) {
        return res.status(401).json({ status: false, data: [], message: 'Gym not found or deleted.', statusCode: 401 });
      }
      if (gymCheck.rows[0].is_blocked) {
        return res.status(403).json({ status: false, data: [], message: 'Your account has been blocked. Please contact support.', statusCode: 403 });
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
    return res.status(401).json({ status: false, data: [], message: 'Invalid token', statusCode: 401 });
  }
};

const authorize = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ status: false, data: [], message: 'Access denied', statusCode: 401 });
    }
    const role = req.user.role;
    // Admin trainers inherit owner-level access for general management operations
    if (role === 'trainer' && req.user.trainer_role === 'admin' && roles.includes('owner')) {
      return next();
    }
    if (!roles.includes(role)) {
      return res.status(403).json({ status: false, data: [], message: 'Access denied', statusCode: 403 });
    }
    next();
  };
};

// Owner-only: blocks admin trainers. Use for subscription, billing, role management.
const authorizeOwnerOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'owner') {
    return res.status(403).json({ status: false, data: [], message: 'This action requires owner access', statusCode: 403 });
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

  return res.status(200).json({
    status: false,
    data: [],
    message: userMessage || 'An unexpected error occurred. Please try again.',
    statusCode: 200,
  });
};

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function ok(
  res: Response,
  data: any[] = [],
  message = 'Success',
  pagination?: { page: number; limit: number; total: number; totalPages: number },
  meta?: Record<string, any>
) {
  const body: any = { status: true, data, message, statusCode: 200 };
  if (pagination) body.pagination = pagination;
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

function fail(res: Response, message: string) {
  return res.status(200).json({ status: false, data: [], message, statusCode: 200 });
}

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
// AUTHENTICATED CHECK AVAILABILITY — on-blur validation for owner add-member/staff forms.
// ============================================================================
app.post('/api/check-availability', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { phone, email } = req.body;
    const errors: Record<string, string> = {};

    if (phone) {
      const phoneCheck = await pool.query(
        `SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (phoneCheck.rows.length > 0) errors.phone = 'This phone number is already registered.';
    }

    if (email) {
      const em = email.trim();
      const emailCheck = await pool.query(
        `SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [em]
      );
      if (emailCheck.rows.length > 0) errors.email = 'This email is already registered.';
    }

    ok(res, [{ errors }], 'Availability checked');
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// CHECK AVAILABILITY — real-time field validation before registration submit.
// Returns all errors found (not just the first) so the UI can show them inline.
// ============================================================================
app.post('/api/gyms/check-availability', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone, businessEmail, ownerEmail } = req.body;
    const errors: Record<string, string> = {};

    if (phone) {
      const phoneCheck = await pool.query(
        `SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (phoneCheck.rows.length > 0) errors.phone = 'This phone number is already registered.';
    }

    // Business and owner email may be identical (same person) — both checked the
    // same way against every account table, case-insensitively.
    for (const [field, raw] of [['businessEmail', businessEmail], ['ownerEmail', ownerEmail]] as const) {
      if (!raw) continue;
      const em = String(raw).trim();
      const hit = await pool.query(
        `SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [em]
      );
      if (hit.rows.length > 0) errors[field] = 'This email is already registered.';
    }

    ok(res, [{ errors }], 'Availability checked');
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// STEP 1 — Initiate registration: validate, store pending, send email OTP.
// No gym or user record is created here.
// ============================================================================
app.post('/api/gyms/register', validate(gymRegisterSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gym_name, owner_name, phone, email, address, owner_password, owner_email } = req.body;

    // Reject if owner OR business email is already used anywhere in the system.
    // Note: an owner MAY reuse the same email for business + owner (that's allowed,
    // they're the same person). We only block reuse by a DIFFERENT account.
    // Case-insensitive comparison so "Foo@x.com" == "foo@x.com".
    for (const [label, value] of [['business', email], ['owner', owner_email]] as const) {
      if (!value) continue;
      const emailHit = await pool.query(
        `SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [value]
      );
      if (emailHit.rows.length > 0) {
        return fail(res, label === 'owner'
          ? 'This owner email is already registered. Please log in or use a different email.'
          : 'This business email is already registered. Please use a different email.');
      }
    }

    // Reject if gym phone is already used by another gym, member, trainer, or user
    const gymPhoneCheck = await pool.query(
      `SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
       UNION ALL
       SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
       UNION ALL
       SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
       UNION ALL
       SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
       LIMIT 1`,
      [phone]
    );
    if (gymPhoneCheck.rows.length > 0) {
      return fail(res, 'This phone number is already registered in the system. Please use a different number.');
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

    ok(res, [{ pendingId, ownerEmail: owner_email, gymPhone: phone }], 'Registration initiated');
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
      return fail(res, 'pending_id and otp_code are required');
    }

    const result = await pool.query(
      `SELECT id, gym_phone, owner_email, email_verified, email_otp_code, email_otp_expires_at, expires_at
       FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );

    if (result.rows.length === 0) {
      return fail(res, 'Registration session not found. Please start over.');
    }

    const pending = result.rows[0];

    if (new Date() > new Date(pending.expires_at)) {
      await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      return fail(res, 'Registration session expired. Please start the registration again.');
    }

    // Idempotent — if already verified, proceed to phone step
    if (pending.email_verified) {
      return ok(res, [{ pendingId: pending_id, gymPhone: pending.gym_phone }], 'Email verified');
    }

    // Check OTP expiry
    if (new Date() > new Date(pending.email_otp_expires_at)) {
      return fail(res, 'Verification code expired. Please request a new one.');
    }

    // Check OTP match (constant-time compare to prevent timing attacks)
    const otpMatch = crypto.timingSafeEqual(
      Buffer.from(String(otp_code).trim()),
      Buffer.from(String(pending.email_otp_code))
    );
    if (!otpMatch) {
      return fail(res, 'Incorrect verification code. Please try again.');
    }

    await pool.query(
      `UPDATE pending_registrations SET email_verified = true WHERE id = $1`,
      [pending_id]
    );

    logger.info({ pending_id }, 'Registration email verified via OTP');
    ok(res, [{ pendingId: pending_id, gymPhone: pending.gym_phone }], 'Email verified');
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
    if (!pending_id) return fail(res, 'pending_id is required');

    const result = await pool.query(
      `SELECT id, owner_email, expires_at FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );
    if (result.rows.length === 0) {
      return fail(res, 'Registration session not found.');
    }
    const pending = result.rows[0];
    if (new Date() > new Date(pending.expires_at)) {
      return fail(res, 'Session expired. Please start registration again.');
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
    ok(res, [], 'A new verification code has been sent to your email.');
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
      return fail(res, 'Firebase not configured on this server');
    }

    const parsed = completeRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 'pending_id and firebase_id_token are required');
    }
    const { pending_id, firebase_id_token } = parsed.data;

    // Verify Firebase token
    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return fail(res, 'Invalid or expired phone verification token');
    }

    const firebasePhone = decodedFirebase.phone_number;
    if (!firebasePhone) {
      return fail(res, 'No phone number found in verification token');
    }

    const result = await pool.query(
      `SELECT * FROM pending_registrations WHERE id = $1`,
      [pending_id]
    );

    if (result.rows.length === 0) {
      return fail(res, 'Registration session not found. Please start over.');
    }

    const pending = result.rows[0];

    if (new Date() > new Date(pending.expires_at)) {
      await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      return fail(res, 'Registration session expired. Please start over.');
    }

    if (!pending.email_verified) {
      return fail(res, 'Email must be verified before phone verification.');
    }

    // Normalise to last 10 digits for comparison (handles +91 prefix variations)
    const last10 = (s: string) => s.replace(/\D/g, '').slice(-10);
    if (last10(firebasePhone) !== last10(pending.gym_phone)) {
      return fail(res, `Phone number does not match the one used during registration. Please verify the number ending in ${last10(pending.gym_phone).slice(-4)}.`);
    }

    // Create gym + user atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Guard against race conditions — re-check email (business + owner) and
      // phone against every account table, case-insensitively, before insert.
      const dupEmail = await client.query(
        `SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE LOWER(phone_or_email) IN (LOWER($1), LOWER($2)) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) IN (LOWER($1), LOWER($2)) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) IN (LOWER($1), LOWER($2)) AND is_deleted = false
         LIMIT 1`,
        [pending.gym_email, pending.owner_email]
      );
      if (dupEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
        return fail(res, 'An account with this email already exists.');
      }

      const dupPhone = await client.query(
        `SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [pending.gym_phone]
      );
      if (dupPhone.rows.length > 0) {
        await client.query('ROLLBACK');
        await pool.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
        return fail(res, 'This phone number is already registered in the system.');
      }

      const trialStart = new Date();
      const trialEnd   = new Date(trialStart.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Create gym first (display_id set after user is created so we have owner_user_id)
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

      // Now generate Option-A gym display_id: OWNER_HASH-G{seq}
      // Back-link gym to its owner so future IDs can be scoped correctly
      await client.query(`UPDATE gyms SET owner_user_id = $1 WHERE id = $2`, [user.id, gymId]);
      const gymDisplayId = await generateGymDisplayId(user.id);
      await client.query(`UPDATE gyms SET display_id = $1 WHERE id = $2`, [gymDisplayId, gymId]);

      await client.query(`DELETE FROM pending_registrations WHERE id = $1`, [pending_id]);
      await client.query('COMMIT');

      // Upload owner profile photo (non-blocking)
      const photoBase64 = req.body.photoBase64 as string | undefined;
      if (photoBase64 && firebaseInitialized) {
        try {
          const photoUrl = await uploadBase64Photo(photoBase64, `profile-photos/owners/${gymId}_${Date.now()}.jpg`);
          await pool.query(`UPDATE gyms SET owner_photo_url = $1 WHERE id = $2`, [photoUrl, gymId]);
        } catch (err) {
          logger.warn({ err }, 'Owner registration photo upload failed — registration succeeded without photo');
        }
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

      // Welcome email
      await sendEmail(pending.owner_email, 'Welcome to Recurva! 🎉', `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#2196F3">You're all set!</h2>
          <p>Your business <strong>${pending.gym_name}</strong> is now registered on Recurva. Your 30-day free trial has started.</p>
          <p>You can log in using your email <strong>${pending.owner_email}</strong> or your registered phone number.</p>
        </div>
      `);

      logger.info({ gymId, userId: user.id }, 'Registration completed — gym and user created');

      ok(res, [{ access_token: accessToken, refresh_token: refreshToken, user: { id: user.id, gym_id: user.gym_id, role: user.role }, subscriptionStatus: 'trial', trialEndsAt: trialEnd }], 'Registration complete');
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
      return fail(res, 'Access denied');
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
        return fail(res, 'Gym not found');
      }
      const gym = result.rows[0];
      const now = new Date();
      let daysRemaining = 0;

      if (gym.subscription_status === 'trial' && gym.trial_ends_at) {
        daysRemaining = Math.max(0, Math.ceil((new Date(gym.trial_ends_at).getTime() - now.getTime()) / 86400000));
      } else if (gym.subscription_status === 'active' && gym.subscription_ends_at) {
        daysRemaining = Math.max(0, Math.ceil((new Date(gym.subscription_ends_at).getTime() - now.getTime()) / 86400000));
      }

      ok(res, [{ status: gym.subscription_status, daysRemaining, trialEndsAt: gym.trial_ends_at, subscriptionEndsAt: gym.subscription_ends_at, plans: Object.entries(PLANS).map(([key, p]) => ({ id: key, label: p.label, amountInPaise: p.amount, amountDisplay: `₹${(p.amount / 100).toLocaleString('en-IN')}`, months: p.months })) }], 'Subscription status');
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
      return fail(res, 'Access denied');
    }
    const { plan } = req.body;
    const planDetails = PLANS[plan];

    const client = await pool.connect();
    try {
      const gymRes = await client.query(`SELECT name FROM gyms WHERE id = $1`, [req.gym_id]);
      if (gymRes.rows.length === 0) return fail(res, 'Gym not found');

      const order = await razorpay!.orders.create({
        amount: planDetails.amount,
        currency: 'INR',
        receipt: `gym_${req.gym_id}_${Date.now()}`,
        notes: { gym_id: req.gym_id!, plan },
      });

      ok(res, [{ orderId: order.id, amount: planDetails.amount, currency: 'INR', keyId: process.env.RAZORPAY_KEY_ID, gymName: gymRes.rows[0].name, planLabel: planDetails.label }], 'Order created');
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
      return fail(res, 'Access denied');
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

    // Verify Razorpay signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      logger.warn({ gymId: req.gym_id }, 'Payment signature verification failed');
      return fail(res, 'Payment verification failed. Please contact support.');
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

      ok(res, [{ status: 'active', subscriptionEndsAt: subscriptionEnd }], `Subscription activated! Valid until ${subscriptionEnd.toLocaleDateString('en-IN')}.`);
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
        LEFT JOIN gyms g ON g.id = u.gym_id AND g.is_deleted = false
        LEFT JOIN trainers t ON t.user_id = u.id AND t.is_deleted = false
        WHERE (
          u.phone_or_email = $1
          OR u.phone = $1
          OR (u.phone IS NOT NULL AND RIGHT(u.phone, 10) = RIGHT($1::text, 10))
          OR RIGHT(g.phone, 10) = RIGHT($1::text, 10)
          OR (t.phone IS NOT NULL AND RIGHT(t.phone, 10) = RIGHT($1::text, 10))
        ) AND u.role = $2 AND u.is_deleted = false
      `;
      const params: any[] = [phone_or_email, role];

      if (gym_id) {
        query += ` AND u.gym_id = $${params.length + 1}`;
        params.push(gym_id);
      }

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        loginAttempts.inc({ status: 'failed' });
        return fail(res, 'Invalid credentials');
      }

      const user = result.rows[0];
      const passwordMatch = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatch) {
        loginAttempts.inc({ status: 'failed' });
        return fail(res, 'Invalid credentials');
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
        return fail(res, 'Your account has been blocked. Please contact support.');
      }
      if (gymCheckRow?.subscription_status === 'suspended') {
        loginAttempts.inc({ status: 'failed' });
        return fail(res, 'Your account has been suspended. Please contact support.');
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

      ok(res, [{ accessToken, refreshToken, user: { id: user.id, gym_id: user.gym_id, role: user.role, ...(trainerRole ? { trainer_role: trainerRole } : {}), ...(memberId ? { member_id: memberId } : {}) } }], 'Login successful');
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
      return fail(res, 'refresh_token is required');
    }

    let decoded: any;
    try {
      decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!);
    } catch {
      return fail(res, 'Invalid or expired refresh token');
    }

    // Fetch current role from DB (refresh token payload excludes role)
    const userRes = await pool.query(
      `SELECT id, gym_id, role FROM users WHERE id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
      [decoded.id, decoded.gym_id]
    );
    if (userRes.rows.length === 0) {
      return fail(res, 'User not found');
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

    ok(res, [{ access_token: newAccessToken, refresh_token: newRefreshToken }], 'Token refreshed');
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
    if (!firebaseInitialized) return fail(res, 'Firebase not configured on server');
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) return fail(res, 'firebase_id_token required');

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return fail(res, 'Invalid or expired OTP token');
    }

    const phone = decoded.phone_number;
    if (!phone) return fail(res, 'No phone number in token');

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
      return fail(res, 'No gym membership found for this number. Please contact your gym.');
    }

    // Multiple gyms — let customer choose
    if (result.rows.length > 1) {
      return ok(res, [{ multiple: true, gyms: result.rows.map(r => ({ member_id: r.id, gym_id: r.gym_id, gym_name: r.gym_name, name: r.name })), firebase_id_token }], 'Multiple gyms found');
    }

    const m = result.rows[0];
    const token = jwt.sign(
      { id: m.id, member_id: m.id, gym_id: m.gym_id, role: 'member' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    ok(res, [{ access_token: token, member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' } }], 'Login successful');
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/customer/select-gym — issued when member belongs to multiple gyms
app.post('/api/auth/customer/select-gym', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return fail(res, 'Firebase not configured');
    const { firebase_id_token, member_id } = req.body;
    if (!firebase_id_token || !member_id) return fail(res, 'firebase_id_token and member_id required');

    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(firebase_id_token); }
    catch { return fail(res, 'Invalid token'); }

    const phone = decoded.phone_number!;
    const result = await pool.query(
      `SELECT m.id, m.gym_id, m.name, g.name AS gym_name
       FROM members m JOIN gyms g ON m.gym_id = g.id
       WHERE m.id = $1 AND (m.phone = $2 OR RIGHT(m.phone, 10) = RIGHT($2, 10)) AND m.is_deleted = false`,
      [member_id, phone]
    );
    if (result.rows.length === 0) return fail(res, 'Not authorized');

    const m = result.rows[0];
    const token = jwt.sign(
      { id: m.id, member_id: m.id, gym_id: m.gym_id, role: 'member' },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );
    ok(res, [{ access_token: token, member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' } }], 'Gym selected');
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/customer/link-invite
// Called when a member logs in with phone OTP but has no gym record yet.
// They enter an invite code generated by the gym owner to link their account.
app.post('/api/auth/customer/link-invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!firebaseInitialized) return fail(res, 'Firebase not configured');
    const { firebase_id_token, code } = req.body;
    if (!firebase_id_token || !code) {
      return fail(res, 'firebase_id_token and code are required');
    }

    let decoded: admin.auth.DecodedIdToken;
    try { decoded = await admin.auth().verifyIdToken(firebase_id_token); }
    catch { return fail(res, 'Invalid or expired OTP token'); }

    const phone = decoded.phone_number;
    if (!phone) return fail(res, 'No phone number in token');

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
        return fail(res, 'Invalid or expired invite code');
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
          return fail(res, 'No matching member record found. Ask your gym to add you first.');
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

      ok(res, [{ access_token: token, member: { id: m.id, name: m.name, gym_id: m.gym_id, gym_name: m.gym_name, role: 'member' } }], 'Account linked');
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
      return fail(res, 'Valid email is required');
    }
    const { email } = parsed.data;

    // Look up user — always return 200 to prevent email enumeration
    const result = await pool.query(
      `SELECT u.id FROM users u WHERE u.phone_or_email = $1 AND u.role IN ('owner','trainer') AND u.is_deleted = false LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      return ok(res, [], 'If that email exists, a code has been sent.');
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
    ok(res, [], 'If that email exists, a code has been sent.');
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/verify-reset-otp — verify 6-digit OTP from forgot-password email, return reset token
app.post('/api/auth/verify-reset-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, otp_code } = req.body;
    if (!email || !otp_code) {
      return fail(res, 'email and otp_code are required');
    }

    const userRes = await pool.query(
      `SELECT u.id FROM users u WHERE u.phone_or_email = $1 AND u.role IN ('owner','trainer') AND u.is_deleted = false LIMIT 1`,
      [email]
    );
    if (userRes.rows.length === 0) {
      return fail(res, 'Incorrect code. Please try again.');
    }

    const userId = userRes.rows[0].id;
    const tokenRes = await pool.query(
      `SELECT id, token, expires_at FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL ORDER BY expires_at DESC LIMIT 1`,
      [userId]
    );

    if (tokenRes.rows.length === 0) {
      return fail(res, 'No reset request found. Please request a new code.');
    }

    const row = tokenRes.rows[0];

    if (new Date() > new Date(row.expires_at)) {
      return fail(res, 'Code expired. Please request a new one.');
    }

    if (!String(row.token).startsWith('otp:')) {
      return fail(res, 'Invalid reset method. Please request a new code.');
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
      return fail(res, 'Incorrect code. Please try again.');
    }

    // OTP correct — replace with a proper reset token for the reset-password step
    const resetToken = crypto.randomBytes(32).toString('hex');
    const newExpiry = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      `UPDATE password_reset_tokens SET token = $1, expires_at = $2 WHERE id = $3`,
      [resetToken, newExpiry, row.id]
    );

    logger.info({ userId }, 'Password reset OTP verified — reset token issued');
    ok(res, [{ reset_token: resetToken }], 'OTP verified');
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid input';
      return fail(res, msg);
    }
    const { token, new_password } = parsed.data;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1`,
        [token]
      );

      if (result.rows.length === 0) {
        return fail(res, 'Invalid or expired reset link.');
      }

      const resetToken = result.rows[0];

      if (resetToken.used_at) {
        return fail(res, 'This reset link has already been used.');
      }

      if (new Date() > new Date(resetToken.expires_at)) {
        await client.query(`DELETE FROM password_reset_tokens WHERE id = $1`, [resetToken.id]);
        return fail(res, 'This reset link has expired. Please request a new one.');
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
      ok(res, [], 'Password updated successfully. You can now log in.');
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
      return fail(res, 'Valid email is required');
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
        return ok(res, [], 'If that email exists, a code has been sent.');
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
      ok(res, [], 'Code sent to your email.');
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
      return fail(res, msg);
    }
    const { email, code } = parsed.data;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, expires_at, used_at FROM otp_codes WHERE email = $1 AND code = $2`,
        [email, code]
      );

      if (result.rows.length === 0) {
        return fail(res, 'Invalid code. Please check and try again.');
      }

      const otp = result.rows[0];

      if (otp.used_at) {
        return fail(res, 'This code has already been used.');
      }

      if (new Date() > new Date(otp.expires_at)) {
        await client.query(`DELETE FROM otp_codes WHERE id = $1`, [otp.id]);
        return fail(res, 'Code expired. Request a new one.');
      }

      // Mark as used
      await client.query(`UPDATE otp_codes SET used_at = NOW() WHERE id = $1`, [otp.id]);

      // Mark the user's email as verified
      await client.query(
        `UPDATE users SET email_verified = true WHERE phone_or_email = $1 AND role = 'owner'`,
        [email]
      );

      logger.info({ email }, 'OTP verified');
      ok(res, [], 'Email verified successfully.');
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
      return fail(res, 'Firebase not configured on this server');
    }

    const { firebase_id_token, role } = req.body;
    if (!firebase_id_token || !role) {
      return fail(res, 'firebase_id_token and role are required');
    }
    if (!['owner', 'trainer'].includes(role)) {
      return fail(res, 'role must be owner or trainer');
    }

    // Verify Firebase ID token
    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return fail(res, 'Invalid or expired Firebase token');
    }

    const phone = decodedFirebase.phone_number;
    if (!phone) {
      return fail(res, 'No phone number in Firebase token');
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
      return fail(res, 'No account found with this phone number for the selected role. Please log in with your email and password.');
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
      return fail(res, 'Your account has been blocked. Please contact support.');
    }
    if (gymRow?.subscription_status === 'suspended') {
      return fail(res, 'Your account has been suspended. Please contact support.');
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

    ok(res, [{ access_token: accessToken, refresh_token: refreshToken, user: { id: user.id, gym_id: user.gym_id, role: user.role } }], 'Login successful');
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
      return fail(res, 'Firebase not configured on this server');
    }

    const { firebase_id_token } = req.body;
    if (!firebase_id_token) {
      return fail(res, 'firebase_id_token is required');
    }

    let decodedFirebase: admin.auth.DecodedIdToken;
    try {
      decodedFirebase = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return fail(res, 'Invalid or expired Firebase token');
    }

    const phone = decodedFirebase.phone_number;
    if (!phone) {
      return fail(res, 'No phone number in Firebase token');
    }

    // Find user by verified phone (E.164 stored in phone column)
    const userRes = await pool.query(
      `SELECT id FROM users WHERE phone = $1 AND role IN ('owner','trainer') AND is_deleted = false LIMIT 1`,
      [phone]
    );

    // Always return success to prevent phone enumeration — token only in success path
    if (userRes.rows.length === 0) {
      return fail(res, 'No account found with this phone number');
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

    ok(res, [{ reset_token: resetToken }], 'OTP verified');
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
      return fail(res, 'fcm_token is required');
    }
    await pool.query(`UPDATE users SET fcm_token = $1 WHERE id = $2`, [fcm_token, req.user?.id]);
    ok(res, [], 'Success');
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

app.post('/api/members/bulk-import', authenticate, authorize(['owner']), bulkLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkMembersSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return fail(res, msg);
    }
    const { trainer_id, members } = parsed.data;

    // Validate trainer only if provided
    if (trainer_id) {
      const trainerCheck = await pool.query(
        'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
        [trainer_id, req.gym_id]
      );
      if (trainerCheck.rows.length === 0) {
        return fail(res, 'Trainer not found in this gym');
      }
    }

    // Pre-fetch gym owner for Option-A ID generation (needed for all rows)
    const bulkGymOwnerRes = await pool.query(
      `SELECT owner_user_id FROM gyms WHERE id = $1 LIMIT 1`, [req.gym_id]
    );
    const bulkGymOwner = bulkGymOwnerRes.rows[0]?.owner_user_id ?? '';

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

      // Option-A display_id — atomic sequence call per row (owner pre-fetched once above)
      const uniqueId = await generateEntityDisplayId(req.gym_id!, bulkGymOwner, 'member');
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
    ok(res, [{ imported, skipped, errors }], 'Import complete');
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

app.post('/api/trainers/bulk-import', authenticate, authorize(['owner']), bulkLimiter, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = bulkTrainersSchema.safeParse(req.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return fail(res, msg);
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
    ok(res, [{ imported, skipped: errors.length, errors, defaultPassword: DEFAULT_PASSWORD }], 'Import complete');
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
        // Use stored status column (updated every 15min by cron) — uses index idx_members_gym_status
        whereClause += ` AND status = $${whereParams.length + 1}`;
        whereParams.push(statusFilter);
      }

      // Run COUNT and paginated SELECT in parallel — halves query time
      const dataParams = [...whereParams, limit, offset];
      const [countRes, membersRes] = await Promise.all([
        client.query(`SELECT COUNT(*) AS total FROM members ${whereClause}`, whereParams),
        client.query(
          `SELECT members.id, members.name, members.phone, members.email,
                  members.last_visit_date, members.membership_expiry_date,
                  members.plan_fee, members.plan, members.created_at,
                  members.assigned_trainer_id, members.display_id,
                  members.user_id IS NOT NULL AS is_registered,
                  (SELECT t.name FROM trainers t WHERE t.id = members.assigned_trainer_id AND t.is_deleted = false LIMIT 1) AS assigned_trainer_name,
                  EXTRACT(EPOCH FROM (NOW() - members.last_visit_date))::INTEGER / 86400 AS days_last_visit,
                  EXTRACT(EPOCH FROM (members.membership_expiry_date - NOW()))::INTEGER / 86400 AS days_to_expiry,
                  (${MEMBER_STATUS_SQL}) AS status,
                  ic.code AS invite_code,
                  ic.expires_at AS invite_expires_at
           FROM members
           LEFT JOIN LATERAL (
             SELECT code, expires_at FROM invite_codes
             WHERE member_id = members.id AND used_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1
           ) ic ON true
           ${whereClause}
           ORDER BY members.created_at DESC
           LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
          dataParams
        ),
      ]);

      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      databaseQueries.observe({ query_type: 'select_members' }, (Date.now() - start) / 1000);

      // Cache-Control: list results can be cached by the client for 30s
      res.setHeader('Cache-Control', 'private, max-age=30');
      ok(res, membersRes.rows, 'Fetched successfully', { page, limit, total, totalPages: pages });
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/members', authenticate, authorize(['owner']), validate(memberSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, assigned_trainer_id, target_gym_id } = req.body;
    const start = Date.now();

    // Resolve target gym — validate ownership if different from JWT gym
    let effectiveGymId = req.gym_id!;
    if (target_gym_id && target_gym_id !== req.gym_id) {
      const gymCheck = await pool.query(
        `SELECT id FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false`,
        [target_gym_id, req.user.id]
      );
      if (!gymCheck.rows.length) return fail(res, 'You do not own this gym location');
      effectiveGymId = target_gym_id;
    }

    const client = await pool.connect();
    try {
      // Global phone check — block if already used anywhere in the system
      const globalPhoneCheck = await client.query(
        `SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (globalPhoneCheck.rows.length > 0) {
        return fail(res, 'This phone number is already registered in the system. Please use a different number.');
      }
      // Free up soft-deleted member's phone slot in this gym (needed for DB unique constraint)
      const deletedPhoneSlot = await client.query(
        'SELECT id FROM members WHERE gym_id = $1 AND phone = $2 AND is_deleted = true LIMIT 1',
        [effectiveGymId, phone]
      );
      if (deletedPhoneSlot.rows.length > 0) {
        await client.query('UPDATE members SET phone = $1 WHERE id = $2',
          [`_rm_${deletedPhoneSlot.rows[0].id.substring(0, 8)}`, deletedPhoneSlot.rows[0].id]);
      }

      // Global email check — block if already used anywhere in the system
      const emailToCheck = email && email.trim() ? email.trim() : null;
      if (emailToCheck) {
        const globalEmailCheck = await client.query(
          `SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
           UNION ALL
           SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
           UNION ALL
           SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
           UNION ALL
           SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
           LIMIT 1`,
          [emailToCheck]
        );
        if (globalEmailCheck.rows.length > 0) {
          return fail(res, 'This email is already registered in the system. Please use a different email or leave the email field empty.');
        }
        // Free up soft-deleted member's email slot in this gym
        const deletedEmailSlot = await client.query(
          'SELECT id FROM members WHERE gym_id = $1 AND email = $2 AND is_deleted = true LIMIT 1',
          [effectiveGymId, emailToCheck]
        );
        if (deletedEmailSlot.rows.length > 0) {
          await client.query('UPDATE members SET email = $1 WHERE id = $2',
            [`_rm_${deletedEmailSlot.rows[0].id.substring(0, 8)}`, deletedEmailSlot.rows[0].id]);
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

      // Option-A member display ID: OWNER_HASH-G{gymIdx}-M{seq}
      const gymOwnerRes = await pool.query(
        `SELECT owner_user_id FROM gyms WHERE id = $1 LIMIT 1`, [effectiveGymId]
      );
      const gymOwnerUserId = gymOwnerRes.rows[0]?.owner_user_id ?? '';
      const displayId = await generateEntityDisplayId(effectiveGymId, gymOwnerUserId, 'member');

      // Validate trainer belongs to this gym (only if provided)
      if (assigned_trainer_id) {
        const trainerCheck = await client.query(
          'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
          [assigned_trainer_id, effectiveGymId]
        );
        if (trainerCheck.rows.length === 0) {
          return fail(res, 'Trainer not found in this gym');
        }
      }

      const result = await client.query(
        `INSERT INTO members (gym_id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, status, display_id, assigned_trainer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, name, phone, email, last_visit_date, membership_expiry_date, plan_fee, plan, status, created_at, assigned_trainer_id, display_id`,
        [effectiveGymId, name, phone, (email && email.trim()) || null, last_visit_date || null, membership_expiry_date, plan_fee, plan || null, status, displayId, assigned_trainer_id]
      );

      // Update trainer's assigned_members_count (only if a trainer was assigned)
      if (assigned_trainer_id) {
        await client.query(
          `UPDATE trainers SET assigned_members_count = (
             SELECT COUNT(*) FROM members WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false
           ) WHERE id = $1 AND gym_id = $2`,
          [assigned_trainer_id, effectiveGymId]
        );
      }

      // Log activity
      await client.query(
        `INSERT INTO activity_log (gym_id, event_type, member_id, description)
         VALUES ($1, 'new_member', $2, $3)`,
        [effectiveGymId, result.rows[0].id, `New member joined: ${name}`]
      ).catch(() => {});

      databaseQueries.observe({ query_type: 'insert_member' }, (Date.now() - start) / 1000);

      ok(res, [result.rows[0]], 'Member created');
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
        return fail(res, 'This phone number is already registered. Please use a different number.');
      }

      const result = await client.query(
        `UPDATE members SET name = $1, phone = $2, email = $3, membership_expiry_date = $4, plan_fee = $5, plan = $6, updated_at = NOW()
         WHERE id = $7 AND gym_id = $8
         RETURNING id, updated_at`,
        [name, phone, (email && email.trim()) || null, membership_expiry_date, plan_fee, plan || null, id, req.gym_id]
      );

      if (result.rows.length === 0) {
        return fail(res, 'Member not found');
      }

      databaseQueries.observe({ query_type: 'update_member' }, (Date.now() - start) / 1000);

      ok(res, [{ id: result.rows[0].id }], 'Updated successfully');
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
      const deleted = await client.query(
        `UPDATE members SET is_deleted = true, deleted_at = NOW()
         WHERE id = $1 AND gym_id = $2
         RETURNING assigned_trainer_id`,
        [id, req.gym_id]
      );

      // Update the assigned trainer's count if this member was assigned
      const trainerId = deleted.rows[0]?.assigned_trainer_id;
      if (trainerId) {
        await client.query(
          `UPDATE trainers SET assigned_members_count = (
             SELECT COUNT(*) FROM members WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false
           ) WHERE id = $1`,
          [trainerId, req.gym_id]
        );
      }

      ok(res, [{ id }], 'Deleted successfully');
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
    const { name, phone, email, password, trainer_role, target_gym_id } = req.body;

    // Resolve target gym — validate ownership if different from JWT gym
    let effectiveGymId = req.gym_id!;
    if (target_gym_id && target_gym_id !== req.gym_id) {
      const gymCheck = await pool.query(
        `SELECT id FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false`,
        [target_gym_id, req.user.id]
      );
      if (!gymCheck.rows.length) return fail(res, 'You do not own this gym location');
      effectiveGymId = target_gym_id;
    }

    const client = await pool.connect();
    try {
      // Global email check — block if already used anywhere in the system (case-insensitive)
      const emailCheck = await client.query(
        `SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [email]
      );
      if (emailCheck.rows.length > 0) {
        return fail(res, 'This email is already registered in the system. Please use a different email.');
      }

      // Global phone check — block if already used anywhere in the system
      const phoneCheck = await client.query(
        `SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (phoneCheck.rows.length > 0) {
        return fail(res, 'This phone number is already registered in the system. Please use a different number.');
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, password_hash, role)
         VALUES ($1, $2, $3, 'trainer') RETURNING id`,
        [effectiveGymId, email, passwordHash]
      );
      if (!userRes.rows[0]) throw new Error('Failed to create trainer user account');
      const userId = userRes.rows[0].id;

      // Option-A staff display ID: OWNER_HASH-G{gymIdx}-S{seq}
      const trainerGymOwnerRes = await pool.query(
        `SELECT owner_user_id FROM gyms WHERE id = $1 LIMIT 1`, [effectiveGymId]
      );
      const trainerGymOwner = trainerGymOwnerRes.rows[0]?.owner_user_id ?? '';
      const displayId = await generateEntityDisplayId(effectiveGymId, trainerGymOwner, 'staff');
      const trainerRes = await client.query(
        `INSERT INTO trainers (gym_id, user_id, name, phone, email, display_id, trainer_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, phone, email, created_at, display_id, trainer_role`,
        [effectiveGymId, userId, name, phone, email, displayId, trainer_role || 'staff']
      );

      await client.query('COMMIT');

      ok(res, [trainerRes.rows[0]], 'Success');
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
      // Include ALL trainers — registered (user_id not null) AND unregistered (pending invite)
      const [countRes, result] = await Promise.all([
        client.query(
          `SELECT COUNT(*) AS total FROM trainers WHERE gym_id = $1 AND is_deleted = false`,
          [req.gym_id]
        ),
        client.query(
          `SELECT t.id, t.name, t.phone, t.email,
                  (SELECT COUNT(*)::int FROM members WHERE assigned_trainer_id = t.id AND gym_id = t.gym_id AND is_deleted = false) AS assigned_members_count,
                  t.is_active, t.created_at,
                  t.trainer_role, t.display_id,
                  t.user_id IS NOT NULL                     AS is_registered,
                  u.phone_or_email                          AS login_email,
                  g.name                                    AS gym_name,
                  g.address                                 AS gym_address,
                  -- Active invite code (unused, not expired)
                  ic.code                                   AS invite_code,
                  ic.expires_at                             AS invite_expires_at
           FROM trainers t
           LEFT JOIN users u  ON t.user_id = u.id
           LEFT JOIN gyms  g  ON g.id = t.gym_id
           LEFT JOIN LATERAL (
             SELECT code, expires_at
             FROM invite_codes
             WHERE trainer_id = t.id
               AND used_at IS NULL
               AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1
           ) ic ON true
           WHERE t.gym_id = $1 AND t.is_deleted = false
           ORDER BY t.trainer_role DESC, t.created_at DESC
           LIMIT $2 OFFSET $3`,
          [req.gym_id, limit, offset]
        ),
      ]);
      const total = parseInt(countRes.rows[0].total);
      const pages = Math.ceil(total / limit) || 1;

      const assignedRes = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE assigned_trainer_id IS NOT NULL)::int AS total_assigned,
           COUNT(*)::int AS total_members
         FROM members WHERE gym_id = $1 AND is_deleted = false`,
        [req.gym_id]
      );
      const totalAssigned   = Number(assignedRes.rows[0]?.total_assigned ?? 0);
      const totalMembers    = Number(assignedRes.rows[0]?.total_members  ?? 0);
      const totalUnassigned = Math.max(0, totalMembers - totalAssigned);
      const teamStats = {
        totalStaff: total,
        totalAssigned,
        totalUnassigned,
      };
      ok(res, result.rows, 'Fetched successfully', { page, limit, total, totalPages: pages }, { teamStats });
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
        `SELECT t.id, t.name, t.phone, t.email, t.profile_photo_url,
                g.name AS gym_name, g.address AS gym_address
         FROM trainers t
         JOIN gyms g ON g.id = t.gym_id AND g.is_deleted = false
         WHERE t.user_id = $1 AND t.gym_id = $2 AND t.is_deleted = false`,
        [req.user.id, req.gym_id]
      );
      if (result.rows.length === 0) {
        return fail(res, 'Trainer profile not found');
      }
      ok(res, [result.rows[0]], 'Success');
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
      return fail(res, 'name and phone are required');
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
        if (trainerUser.rows.length === 0) { await client.query('ROLLBACK'); return fail(res, 'Trainer not found'); }

        const userId = trainerUser.rows[0].id;
        const existing = await client.query(
          'SELECT id FROM users WHERE phone_or_email = $1 AND id != $2 AND is_deleted = false',
          [email.trim(), userId]
        );
        if (existing.rows.length > 0) { await client.query('ROLLBACK'); return fail(res, 'This email is already in use.'); }

        await client.query('UPDATE users SET phone_or_email = $1 WHERE id = $2', [email.trim(), userId]);
      }

      const result = await client.query(
        `UPDATE trainers SET name = $1, phone = $2, ${email ? 'email = $5,' : ''} updated_at = NOW()
         WHERE id = $3 AND gym_id = $4 AND is_deleted = false
         RETURNING id, name, phone, email, assigned_members_count, is_active, created_at`,
        email ? [name, phone, id, req.gym_id, email.trim()] : [name, phone, id, req.gym_id]
      );
      if (result.rows.length === 0) { await client.query('ROLLBACK'); return fail(res, 'Trainer not found'); }

      await client.query('COMMIT');
      ok(res, [result.rows[0]], 'Success');
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
        return fail(res, 'member_ids must be an array',);
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
        return fail(res, 'Trainer not found',);
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
      // ✅ STEP 2: Find displaced trainers BEFORE reassigning
      // ============================================================
      let displacedTrainerIds: string[] = [];
      if (member_ids.length > 0) {
        const displaced = await client.query(
          `SELECT DISTINCT assigned_trainer_id FROM members
           WHERE id = ANY($1::uuid[])
             AND gym_id = $2
             AND is_deleted = false
             AND assigned_trainer_id IS NOT NULL
             AND assigned_trainer_id != $3`,
          [member_ids, req.gym_id, trainerId]
        );
        displacedTrainerIds = displaced.rows.map((r: any) => r.assigned_trainer_id);
      }

      // ============================================================
      // ✅ STEP 3: ASSIGN selected members
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
      // ✅ STEP 4: GET REAL COUNT (IMPORTANT FIX)
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
      // ✅ STEP 5: UPDATE TARGET TRAINER COUNT
      // ============================================================
      await client.query(
        `UPDATE trainers
         SET assigned_members_count = $1
         WHERE id = $2`,
        [assignedCount, trainerId]
      );

      // ============================================================
      // ✅ STEP 6: UPDATE DISPLACED TRAINERS' COUNTS
      // ============================================================
      for (const dtId of displacedTrainerIds) {
        await client.query(
          `UPDATE trainers SET assigned_members_count = (
             SELECT COUNT(*) FROM members WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false
           ) WHERE id = $1`,
          [dtId, req.gym_id]
        );
      }

      // ✅ COMMIT TRANSACTION
      await client.query('COMMIT');

      // ============================================================
      // ✅ RESPONSE
      // ============================================================
      ok(res, [{ trainer_id: trainerId, assigned_count: assignedCount }], 'Trainer assigned');

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
      ok(res, [{ id }], 'Deleted successfully');
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
    const { member_id, task_type, issue_type, custom_issue, assigned_trainer_id, priority = 'medium', due_date, notes } = req.body;

    const client = await pool.connect();
    try {
      // Validate memberId exists and is not deleted in this gym
      const memberCheck = await client.query(
        'SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
        [member_id, req.gym_id]
      );
      if (memberCheck.rows.length === 0) {
        return fail(res, 'Member not found');
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
          return fail(res, `${memberName} has no staff assigned. Please assign a staff member to this customer first.`);
        }
      } else {
        const trainerCheck = await client.query(
          'SELECT id FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false',
          [assigned_trainer_id, req.gym_id]
        );
        if (trainerCheck.rows.length === 0) {
          return fail(res, 'Trainer not found in this gym');
        }
      }

      const resolvedDueDate = due_date || new Date().toISOString().split('T')[0];
      let result;
      try {
        result = await client.query(
          `INSERT INTO follow_up_tasks (gym_id, member_id, assigned_trainer_id, task_type, issue_type, custom_issue, status, priority, due_date, notes)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
           RETURNING id, member_id, task_type, issue_type, custom_issue, assigned_trainer_id, status, priority, due_date, created_at`,
          [req.gym_id, member_id, resolvedTrainerId, task_type, issue_type || null, custom_issue || null, priority, resolvedDueDate, notes || null]
        );
      } catch (colErr: any) {
        if (colErr.code === '42703') {
          // Columns not yet migrated — insert without new columns
          result = await client.query(
            `INSERT INTO follow_up_tasks (gym_id, member_id, assigned_trainer_id, task_type, status, notes)
             VALUES ($1, $2, $3, $4, 'pending', $5)
             RETURNING id, member_id, task_type, assigned_trainer_id, status, created_at`,
            [req.gym_id, member_id, resolvedTrainerId, task_type, notes || null]
          );
        } else {
          throw colErr;
        }
      }

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

      ok(res, [task], 'Task created');
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
    const memberId  = req.query.member_id  as string;
    const search    = req.query.search     as string;
    const page      = Math.max(1, parseInt((req.query.page  as string) || '1'));
    const limit     = Math.min(parseInt((req.query.limit as string) || '50'), 200);
    const offset    = (page - 1) * limit;

    const client = await pool.connect();
    try {
      // Base WHERE — trainers ALWAYS see only their own tasks (auto-filter by role)
      const baseParams: any[] = [req.gym_id];
      let baseClause = `WHERE t.gym_id = $1`;

      if (req.user?.role === 'trainer') {
        // Auto-filter: look up trainer record by user_id
        const trainerRow = await client.query(
          `SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 LIMIT 1`,
          [req.user.id, req.gym_id]
        );
        const autoTrainerId = trainerRow.rows[0]?.id;
        if (autoTrainerId) {
          baseClause += ` AND t.assigned_trainer_id = $${baseParams.length + 1}`;
          baseParams.push(autoTrainerId);
        }
      } else {
        // Owner: allow filtering by specific trainer if requested
        const trainerId = req.query.trainer_id as string;
        if (trainerId) {
          baseClause += ` AND t.assigned_trainer_id = $${baseParams.length + 1}`;
          baseParams.push(trainerId);
        }
      }
      if (memberId) {
        baseClause += ` AND t.member_id = $${baseParams.length + 1}`;
        baseParams.push(memberId);
      }
      if (search) {
        baseClause += ` AND (m.name ILIKE $${baseParams.length + 1} OR tr.name ILIKE $${baseParams.length + 1} OR t.notes ILIKE $${baseParams.length + 1})`;
        baseParams.push(`%${search}%`);
      }

      // Status counts across the base filter (no status filter applied)
      const countsRes = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE t.status = 'pending')     AS pending,
           COUNT(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
           COUNT(*) FILTER (WHERE t.status = 'completed')   AS completed,
           COUNT(*) AS all
         FROM follow_up_tasks t
         LEFT JOIN members  m  ON t.member_id = m.id
         LEFT JOIN trainers tr ON t.assigned_trainer_id = tr.id
         ${baseClause}`,
        baseParams
      );
      const counts = {
        all:         parseInt(countsRes.rows[0].all),
        pending:     parseInt(countsRes.rows[0].pending),
        in_progress: parseInt(countsRes.rows[0].in_progress),
        completed:   parseInt(countsRes.rows[0].completed),
      };

      // Add status filter AFTER computing counts
      const whereParams = [...baseParams];
      let whereClause = baseClause;
      if (status && status !== 'all') {
        whereClause += ` AND t.status = $${whereParams.length + 1}`;
        whereParams.push(status);
      }

      const total = status && status !== 'all'
        ? (counts as any)[status] ?? counts.all
        : counts.all;
      const pages = Math.ceil(total / limit) || 1;

      // Paginated data with due_group — falls back gracefully if priority/due_date columns don't exist yet
      const dataParams = [...whereParams, limit, offset];
      let result;
      try {
        result = await client.query(
          `SELECT t.id, t.member_id, t.task_type, t.status, t.outcome, t.notes,
                  t.priority, t.due_date, t.created_at, t.completed_at,
                  t.assigned_trainer_id,
                  m.name AS member_name, m.phone AS member_phone,
                  m.plan AS member_plan, m.plan_fee,
                  tr.name AS trainer_name, tr.trainer_role,
                  CASE
                    WHEN t.due_date < CURRENT_DATE THEN 'overdue'
                    WHEN t.due_date = CURRENT_DATE THEN 'today'
                    WHEN t.due_date <= CURRENT_DATE + 7 THEN 'this_week'
                    ELSE 'later'
                  END AS due_group
           FROM follow_up_tasks t
           LEFT JOIN members  m  ON t.member_id  = m.id
           LEFT JOIN trainers tr ON t.assigned_trainer_id = tr.id
           ${whereClause}
           ORDER BY
             CASE WHEN t.due_date < CURRENT_DATE THEN 0
                  WHEN t.due_date = CURRENT_DATE THEN 1
                  WHEN t.due_date <= CURRENT_DATE + 7 THEN 2
                  ELSE 3 END,
             CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             t.created_at DESC
           LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
          dataParams
        );
      } catch (colErr: any) {
        if (colErr.code === '42703') {
          // priority/due_date columns not yet migrated — use legacy query with defaults
          result = await client.query(
            `SELECT t.id, t.member_id, t.task_type, t.status, t.outcome, t.notes,
                    'medium' AS priority, CURRENT_DATE AS due_date,
                    t.created_at, t.completed_at, t.assigned_trainer_id,
                    m.name AS member_name, m.phone AS member_phone,
                    m.plan AS member_plan, m.plan_fee,
                    tr.name AS trainer_name, tr.trainer_role,
                    'today' AS due_group
             FROM follow_up_tasks t
             LEFT JOIN members  m  ON t.member_id  = m.id
             LEFT JOIN trainers tr ON t.assigned_trainer_id = tr.id
             ${whereClause}
             ORDER BY t.created_at DESC
             LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
            dataParams
          );
        } else {
          throw colErr;
        }
      }

      ok(res, result.rows, 'Fetched successfully', { page, limit, total, totalPages: pages }, { counts });
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
      return fail(res, 'outcome is required and must be one of: called, not_reachable, coming_tomorrow, renewed, no_action');
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
        return fail(res, 'Task not found');
      }

      const memberId = result.rows[0].member_id;

      if (outcome === 'renewed') {
        const memberRes = await client.query(
          'SELECT plan_fee, name FROM members WHERE id = $1',
          [memberId]
        );

        if (memberRes.rows.length > 0) {
          const { plan_fee, name: memberName } = memberRes.rows[0];
          await client.query(
            `INSERT INTO revenue_records (gym_id, member_id, task_id, action, revenue_recovered)
             VALUES ($1, $2, $3, 'renewal', $4)`,
            [req.gym_id, memberId, id, plan_fee]
          );
          // Log renewal activity and staff performance
          await Promise.all([
            client.query(
              `INSERT INTO activity_log (gym_id, event_type, member_id, staff_id, amount, description)
               VALUES ($1, 'renewal', $2, $3, $4, $5)`,
              [req.gym_id, memberId, req.user?.trainer_id || null, plan_fee, `Renewed: ${memberName}`]
            ),
            client.query(
              `INSERT INTO staff_performance_log (gym_id, staff_id, action_type, member_id)
               VALUES ($1, $2, 'renewal', $3)`,
              [req.gym_id, req.user?.trainer_id || req.gym_id, memberId]
            ),
          ]).catch(() => {});
        }
      }

      // Log task_done activity for all outcomes
      await client.query(
        `INSERT INTO activity_log (gym_id, event_type, member_id, staff_id, description)
         VALUES ($1, 'task_done', $2, $3, $4)`,
        [req.gym_id, memberId, req.user?.trainer_id || null, `Task ${outcome}`]
      ).catch(() => {});

      // Log call in staff_performance_log for call-type outcomes
      if (['called', 'coming_tomorrow', 'not_reachable'].includes(outcome)) {
        await client.query(
          `INSERT INTO staff_performance_log (gym_id, staff_id, action_type, member_id)
           VALUES ($1, $2, 'call', $3)`,
          [req.gym_id, req.user?.trainer_id || req.gym_id, memberId]
        ).catch(() => {});
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

      ok(res, [result.rows[0]], 'Task completed');
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
        return fail(res, 'Attendance already marked for today');
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

      ok(res, [], 'Success');
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
      ok(res, result.rows, 'Fetched successfully');
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
        return fail(res, 'Member not found');
      }

      const member = memberRes.rows[0];

      // Query attendance for month with status
      const attendanceRes = await client.query(
        `SELECT visit_date::text, COALESCE(status, 'present') AS status
         FROM attendance_logs
         WHERE gym_id = $1
           AND member_id = $2
           AND DATE_TRUNC('month', visit_date) = DATE_TRUNC('month', ($3 || '-01')::date)
         ORDER BY visit_date ASC`,
        [req.gym_id, memberId, month]
      );

      const presentDates = attendanceRes.rows.filter((r: any) => r.status !== 'absent').map((r: any) => r.visit_date);
      const absentDates  = attendanceRes.rows.filter((r: any) => r.status === 'absent').map((r: any) => r.visit_date);

      // Today's status
      const todayStr = new Date().toISOString().split('T')[0];
      const todayRow = attendanceRes.rows.find((r: any) => r.visit_date === todayStr);
      const todayStatus = todayRow ? (todayRow.status === 'absent' ? 'absent' : 'present') : null;

      // This-week visits (Mon–today)
      const weekRes = await client.query(
        `SELECT COUNT(*) AS cnt FROM attendance_logs
         WHERE gym_id = $1 AND member_id = $2
           AND visit_date >= DATE_TRUNC('week', CURRENT_DATE)
           AND COALESCE(status, 'present') = 'present'`,
        [req.gym_id, memberId]
      );
      const weekVisits = parseInt(weekRes.rows[0].cnt);

      // This-month percentage
      const daysSoFar = new Date().getDate();
      const monthVisits = presentDates.filter((d: string) => d.startsWith(month!)).length;
      const monthPercentage = daysSoFar > 0 ? Math.round((monthVisits / daysSoFar) * 100) : 0;

      ok(res, [{ member, present_dates: presentDates, absent_dates: absentDates, today_status: todayStatus, week_visits: weekVisits, week_total: 7, month_percentage: monthPercentage, month }], 'Fetched successfully');
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/members/:memberId/attendance/mark — upsert attendance with status
app.post('/api/members/:memberId/attendance/mark', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { memberId } = req.params;
    const { date, status } = req.body as { date: string; status: 'present' | 'absent' };
    if (!date || !status || !['present','absent'].includes(status)) {
      return fail(res, 'date and status (present|absent) required');
    }
    const gymId = req.gym_id!;
    const client = await pool.connect();
    try {
      // Verify member belongs to gym
      const mCheck = await client.query(
        `SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
        [memberId, gymId]
      );
      if (mCheck.rows.length === 0) return fail(res, 'Member not found');

      // Delete any existing entry for that day, then insert fresh
      await client.query(
        `DELETE FROM attendance_logs WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3::date`,
        [gymId, memberId, date]
      );
      await client.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visit_date, status, source, visited_at)
         VALUES ($1, $2, $3::date, $4, 'staff', NOW())`,
        [gymId, memberId, date, status]
      );

      if (status === 'present') {
        await client.query(
          `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND gym_id = $3`,
          [date, memberId, gymId]
        );
      }
      ok(res, [], 'Success');
    } finally { client.release(); }
  } catch (error) { next(error); }
});

// DELETE /api/members/:memberId/attendance/date/:date — remove entry for a day
app.delete('/api/members/:memberId/attendance/date/:date', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { memberId, date } = req.params;
    const gymId = req.gym_id!;
    await pool.query(
      `DELETE FROM attendance_logs WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3::date`,
      [gymId, memberId, date]
    );
    ok(res, [], 'Success');
  } catch (error) { next(error); }
});

// ============================================================================
// MEMBER PROFILE & PAYMENT ENDPOINTS
// ============================================================================

// GET /api/members/:id/profile — member details with stats
app.get('/api/members/:id/profile', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const gymId = req.gym_id!;
    const result = await pool.query(
      `SELECT m.id, m.name, m.phone, m.email, m.last_visit_date, m.membership_expiry_date,
              m.plan_fee, m.plan, m.created_at, m.assigned_trainer_id, m.display_id,
              m.status,
              m.user_id IS NOT NULL                                                         AS is_registered,
              (SELECT t.name FROM trainers t WHERE t.id = m.assigned_trainer_id AND t.is_deleted = false LIMIT 1) AS assigned_trainer_name,
              (SELECT COUNT(*) FROM attendance_logs al WHERE al.member_id = m.id AND COALESCE(al.status,'present') = 'present')::int AS total_visits,
              (SELECT COALESCE(SUM(rr.revenue_recovered),0) FROM revenue_records rr WHERE rr.member_id = m.id)::numeric AS lifetime_revenue,
              g.name AS gym_name, g.address AS gym_address,
              ic.code                                                                       AS invite_code,
              ic.expires_at                                                                 AS invite_expires_at
       FROM members m
       JOIN gyms g ON g.id = m.gym_id
       LEFT JOIN LATERAL (
         SELECT code, expires_at FROM invite_codes
         WHERE member_id = m.id AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1
       ) ic ON true
       WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
      [id, gymId]
    );
    if (result.rows.length === 0) return fail(res, 'Member not found');
    const row = result.rows[0];
    const daysSinceJoin = Math.max(1, Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000));
    row.attendance_pct = Math.min(100, Math.round((Number(row.total_visits) / daysSinceJoin) * 100));
    ok(res, [row], 'Success');
  } catch (error) { next(error); }
});

// POST /api/members/:id/record-payment — manual cash/outside-app payment
app.post('/api/members/:id/record-payment', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { method } = req.body as { method?: string };
    const gymId = req.gym_id!;
    const memberRes = await pool.query(
      `SELECT id, name, plan_fee, plan, membership_expiry_date FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false`,
      [id, gymId]
    );
    if (memberRes.rows.length === 0) return fail(res, 'Member not found');
    const { name, plan_fee, plan, membership_expiry_date } = memberRes.rows[0];

    // Calculate new expiry: extend from today if expired, or from current expiry if still active
    const planDurationMonths: Record<string, number> = {
      annual: 12, biannual: 6, quarterly: 3, monthly: 1,
    };
    const months = planDurationMonths[plan as string] ?? 1;
    const baseDate = membership_expiry_date && new Date(membership_expiry_date) > new Date()
      ? new Date(membership_expiry_date)
      : new Date();
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + months);

    // Ensure column exists (idempotent — runs fast if already present)
    await pool.query(`ALTER TABLE revenue_records ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30)`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO revenue_records (gym_id, member_id, action, revenue_recovered, payment_method) VALUES ($1, $2, 'manual_payment', $3, $4)`,
        [gymId, id, plan_fee, method || 'cash']
      );
      // Extend membership expiry date
      await client.query(
        `UPDATE members SET membership_expiry_date = $1 WHERE id = $2 AND gym_id = $3`,
        [newExpiry.toISOString(), id, gymId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    ok(res, [{ memberId: id, memberName: name, amount: plan_fee, method: method || 'cash', newExpiry: newExpiry.toISOString() }], 'Payment recorded');
  } catch (error) { next(error); }
});

// GET /api/members/:id/payments — payment history for a member
app.get('/api/members/:id/payments', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const gymId = req.gym_id!;
    await pool.query(`ALTER TABLE revenue_records ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30)`);
    const result = await pool.query(
      `SELECT id, action, revenue_recovered, payment_method, tracked_at
       FROM revenue_records WHERE member_id = $1 AND gym_id = $2
       ORDER BY tracked_at DESC LIMIT 100`,
      [id, gymId]
    );
    ok(res, result.rows, 'Fetched successfully');
  } catch (error) { next(error); }
});

// DELETE /api/members/:id/payments/:paymentId — delete a manually recorded payment (owner only)
app.delete('/api/members/:id/payments/:paymentId', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id, paymentId } = req.params;
    const gymId = req.gym_id!;
    // Only allow deletion of manual_payment records; reject automated ones
    const check = await pool.query(
      `SELECT id, action FROM revenue_records WHERE id = $1 AND member_id = $2 AND gym_id = $3`,
      [paymentId, id, gymId]
    );
    if (check.rows.length === 0) return fail(res, 'Payment not found');
    if (check.rows[0].action !== 'manual_payment') {
      return fail(res, 'Only manual payments can be deleted');
    }
    await pool.query(`DELETE FROM revenue_records WHERE id = $1`, [paymentId]);
    ok(res, [], 'Success');
  } catch (error) { next(error); }
});

// POST /api/members/:id/invite — generate or retrieve active invite code for a member
// Use case: member hasn't registered yet; owner needs to (re)share the code.
app.post('/api/members/:id/invite', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const gymId = req.gym_id!;
    const memberRes = await pool.query(
      `SELECT name, phone FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false`, [id, gymId]
    );
    if (!memberRes.rows.length) return fail(res, 'Member not found');
    const { name, phone } = memberRes.rows[0];

    // Expire old unused codes for this member so there's only one active at a time
    await pool.query(
      `UPDATE invite_codes SET expires_at = NOW() WHERE member_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [id]
    );

    // Generate new 8-char invite code
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO invite_codes (gym_id, code, type, member_id, placeholder_name, placeholder_phone, expires_at)
       VALUES ($1, $2, 'member', $3, $4, $5, NOW() + INTERVAL '30 days')`,
      [gymId, code, id, name, phone]
    );
    ok(res, [{ code, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }], 'Invite code generated');
  } catch (error) { next(error); }
});

// POST /api/trainers/:id/invite — generate or retrieve active invite code for a trainer
app.post('/api/trainers/:id/invite', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const gymId = req.gym_id!;
    const trainerRes = await pool.query(
      `SELECT name, phone, trainer_role FROM trainers WHERE id = $1 AND gym_id = $2 AND is_deleted = false AND user_id IS NULL`,
      [id, gymId]
    );
    if (!trainerRes.rows.length) return fail(res, 'Unregistered trainer not found');
    const { name, phone, trainer_role } = trainerRes.rows[0];

    await pool.query(
      `UPDATE invite_codes SET expires_at = NOW() WHERE trainer_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
      [id]
    );

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO invite_codes (gym_id, code, type, trainer_id, placeholder_name, placeholder_phone, trainer_role, expires_at)
       VALUES ($1, $2, 'staff', $3, $4, $5, $6, NOW() + INTERVAL '30 days')`,
      [gymId, code, id, name, phone, trainer_role]
    );
    ok(res, [{ code, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }], 'Invite code generated');
  } catch (error) { next(error); }
});

// PUT /api/members/:id/assign-trainer — assign or unassign staff to a member
app.put('/api/members/:id/assign-trainer', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { trainer_id } = req.body as { trainer_id?: string | null };
    const gymId = req.gym_id!;
    await pool.query(
      `UPDATE members SET assigned_trainer_id = $1 WHERE id = $2 AND gym_id = $3`,
      [trainer_id || null, id, gymId]
    );
    ok(res, [{ memberId: id, trainerId: trainer_id || null }], 'Trainer assigned');
  } catch (error) { next(error); }
});

// GET /api/staff/customers — list customers assigned to the trainer with today's attendance status
app.get('/api/staff/customers', authenticate, authorize(['trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const gymId  = req.gym_id!;
    const userId = req.user!.id;
    const { filter = 'all', search = '' } = req.query as { filter?: string; search?: string };

    const trainerRes = await pool.query(
      `SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
      [userId, gymId]
    );
    if (trainerRes.rows.length === 0) return fail(res, 'Trainer not found');
    const trainerId = trainerRes.rows[0].id;

    const conditions: string[] = ['m.gym_id = $1', 'm.assigned_trainer_id = $2', 'm.is_deleted = false'];
    const params: any[] = [gymId, trainerId];

    if (filter === 'high_risk') {
      conditions.push(`m.status = 'high_risk'`);
    } else if (filter === 'active') {
      conditions.push(`m.status = 'active'`);
    } else if (filter === 'at_risk') {
      conditions.push(`m.status IN ('at_risk','high_risk')`);
    }

    if (search && (search as string).trim()) {
      params.push(`%${(search as string).trim()}%`);
      conditions.push(`(m.name ILIKE $${params.length} OR m.phone ILIKE $${params.length})`);
    }

    const whereClause = conditions.join(' AND ');

    const result = await pool.query(
      `SELECT m.id, m.name, m.phone, m.email, m.plan_fee, m.plan, m.display_id,
              m.membership_expiry_date::text, m.last_visit_date::text, m.created_at::text,
              (${MEMBER_STATUS_SQL}) AS status,
              (SELECT COALESCE(al.status, 'present')
               FROM attendance_logs al
               WHERE al.member_id = m.id AND al.gym_id = m.gym_id AND al.visit_date = CURRENT_DATE
               LIMIT 1) AS today_attendance
       FROM members m
       WHERE ${whereClause}
       ORDER BY CASE (${MEMBER_STATUS_SQL}) WHEN 'high_risk' THEN 1 WHEN 'at_risk' THEN 2 ELSE 3 END, m.name ASC`,
      params
    );

    ok(res, result.rows, 'Fetched successfully');
  } catch (error) { next(error); }
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
  photoBase64: z.string().optional(),
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
                  LEFT(g.razorpay_key_id, 8) AS gym_razorpay_key_hint,
                  COALESCE(g.owner_photo_url, '') AS profile_photo_url
           FROM users u
           JOIN gyms g ON g.id = u.gym_id
           WHERE u.id = $1 AND u.is_deleted = false`,
          [req.user.id]
        );
        if (result.rows.length === 0) return fail(res, 'Profile not found');
        const row = result.rows[0];
        ok(res, [{ id: row.id, name: row.name, email: row.phone_or_email, phone: row.phone || '', phoneVerified: row.phone_verified ?? true, profilePhotoUrl: row.profile_photo_url || null, role: 'owner', gym: { id: row.gym_id, name: row.gym_name, address: row.gym_address || '', phone: row.gym_phone || '', email: row.gym_email || '', razorpay_configured: row.gym_razorpay_configured ?? false, razorpay_key_hint: row.gym_razorpay_key_hint || null } }], 'Profile fetched');
      } else {
        const result = await client.query(
          `SELECT u.id, u.phone_or_email, u.phone_verified, t.name, t.phone, t.email, t.id as trainer_id,
                  COALESCE(t.profile_photo_url, '') AS profile_photo_url,
                  t.created_at, g.name AS gym_name
           FROM users u
           JOIN trainers t ON t.user_id = u.id
           JOIN gyms g ON g.id = t.gym_id
           WHERE u.id = $1 AND t.is_deleted = false
           LIMIT 1`,
          [req.user.id]
        );
        if (result.rows.length === 0) return fail(res, 'Profile not found');
        const row = result.rows[0];
        ok(res, [{ id: row.id, name: row.name, email: row.email, phone: row.phone || '', phoneVerified: row.phone_verified ?? false, profilePhotoUrl: row.profile_photo_url || null, role: 'trainer', gymName: row.gym_name || null, joinedAt: row.created_at || null }], 'Profile fetched');
      }
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// PUT /api/profile — update name, phone, optional password, optional photo
app.put('/api/profile', authenticate, validate(updateProfileSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, phone, email, currentPassword, newPassword, photoBase64 } = req.body;
    const client = await pool.connect();
    try {
      // Optional password change
      if (newPassword) {
        if (!currentPassword) return fail(res, 'Current password is required to set a new password');
        const userRes = await client.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
        if (!valid) return fail(res, 'Current password is incorrect');
        const hash = await bcrypt.hash(newPassword, 10);
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
      }

      if (req.user.role === 'owner') {
        await client.query('UPDATE gyms SET owner_name = $1 WHERE id = $2', [name, req.gym_id]);
        if (phone) await client.query('UPDATE users SET phone = $1, phone_verified = false WHERE id = $2', [phone, req.user.id]);
        if (email && email.trim()) {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_or_email = $1 AND id != $2 AND is_deleted = false',
            [email.trim(), req.user.id]
          );
          if (existing.rows.length > 0) return fail(res, 'This email is already in use by another account.');
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
          if (existing.rows.length > 0) return fail(res, 'This email is already in use by another account.');
          await client.query('UPDATE users SET phone_or_email = $1 WHERE id = $2', [email.trim(), req.user.id]);
          await client.query('UPDATE trainers SET email = $1 WHERE user_id = $2 AND gym_id = $3', [email.trim(), req.user.id, req.gym_id]);
        }
      }

      // Save profile photo as data URL — compressed by client to ~300×300 PNG so it's small enough for DB storage
      let savedPhotoUrl: string | null = null;
      if (photoBase64 && typeof photoBase64 === 'string' && photoBase64.length > 0) {
        if (photoBase64.length > 2_000_000) {
          return fail(res, 'Photo too large. Please choose a smaller image.');
        }
        const mime = photoBase64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
        savedPhotoUrl = `data:${mime};base64,${photoBase64}`;
        if (req.user.role === 'owner') {
          await client.query(`UPDATE gyms SET owner_photo_url = $1 WHERE id = $2`, [savedPhotoUrl, req.gym_id]);
        } else {
          await client.query(`UPDATE trainers SET profile_photo_url = $1 WHERE user_id = $2 AND gym_id = $3`, [savedPhotoUrl, req.user.id, req.gym_id]);
        }
      }

      ok(res, [{ profilePhotoUrl: savedPhotoUrl }], 'Profile updated successfully');
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
    if (!firebaseInitialized) return fail(res, 'Firebase not configured');
    const { firebase_id_token } = req.body;
    if (!firebase_id_token) return fail(res, 'firebase_id_token is required');

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(firebase_id_token);
    } catch {
      return fail(res, 'Invalid or expired verification token');
    }

    const verifiedPhone = decoded.phone_number;
    if (!verifiedPhone) return fail(res, 'No phone number in token');

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

    ok(res, [{ phone: verifiedPhone }], 'Phone verified successfully');
  } catch (error) {
    next(error);
  }
});

// PUT /api/gyms/me — owner updates gym name, address, phone
// GET /api/gyms/mine — list all gym locations owned by the authenticated owner
app.get('/api/gyms/mine', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.address, g.phone, g.email, g.display_id, g.created_at,
              (SELECT COUNT(*) FROM members m WHERE m.gym_id = g.id AND m.is_deleted = false) AS member_count
       FROM gyms g
       WHERE g.owner_user_id = $1 AND g.is_deleted = false
       ORDER BY g.created_at ASC`,
      [req.user.id]
    );
    // Fall back to the primary gym if owner_user_id not populated yet
    if (result.rows.length === 0) {
      const fallback = await pool.query(
        `SELECT g.id, g.name, g.address, g.phone, g.email, g.display_id, g.created_at,
                (SELECT COUNT(*) FROM members m WHERE m.gym_id = g.id AND m.is_deleted = false) AS member_count
         FROM gyms g WHERE g.id = $1 AND g.is_deleted = false`,
        [req.gym_id]
      );
      return ok(res, fallback.rows, 'Fetched successfully');
    }
    ok(res, result.rows, 'Fetched successfully');
  } catch (error) { next(error); }
});

// POST /api/gyms/switch — switch active gym context (owner only, no password needed)
// Returns a new JWT pair with the requested gym_id embedded, so all subsequent
// API calls automatically use the new gym context.
app.post('/api/gyms/switch', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gym_id } = req.body;
    if (!gym_id) return fail(res, 'gym_id is required');

    // Verify the owner actually owns the target gym
    const gymRes = await pool.query(
      `SELECT id, name FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false LIMIT 1`,
      [gym_id, req.user.id]
    );
    if (gymRes.rows.length === 0) return fail(res, 'Gym not found or you do not own it');

    // Issue new JWT pair for the selected gym
    const newAccessToken = jwt.sign(
      { id: req.user.id, gym_id, role: 'owner' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const newRefreshToken = jwt.sign(
      { id: req.user.id, gym_id },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' }
    );

    logger.info({ userId: req.user.id, fromGym: req.gym_id, toGym: gym_id }, 'Owner switched gym context');
    ok(res, [{ accessToken: newAccessToken, refreshToken: newRefreshToken, gym_id, gymName: gymRes.rows[0].name }], 'Gym switched successfully');
  } catch (error) { next(error); }
});

// DELETE /api/gyms/:gymId — soft-delete a non-primary gym location
app.delete('/api/gyms/:gymId', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gymId } = req.params;
    if (gymId === req.gym_id) {
      return fail(res, 'Cannot remove your primary location');
    }
    const owned = await pool.query(
      `SELECT id FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false`,
      [gymId, req.user.id]
    );
    if (!owned.rows.length) return fail(res, 'Location not found');
    await pool.query(`UPDATE gyms SET is_deleted = true WHERE id = $1`, [gymId]);
    ok(res, [], 'Success');
  } catch (error) { next(error); }
});

// POST /api/gyms/mine — create a new gym location for the owner
app.post('/api/gyms/mine', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gymName, address, phone, email } = req.body;
    if (!gymName || String(gymName).trim().length < 2) {
      return fail(res, 'Business name must be at least 2 characters');
    }
    // Fetch all primary gym fields to use as defaults for the new location
    const ownerGym = await pool.query(
      `SELECT g.owner_name, g.phone, g.email, g.address,
              g.subscription_status, g.trial_started_at, g.trial_ends_at, g.subscription_ends_at
       FROM gyms g WHERE g.id = $1`,
      [req.gym_id]
    );
    if (!ownerGym.rows.length) return fail(res, 'Owner gym not found');
    const og = ownerGym.rows[0];

    // Option-A gym display ID
    const displayId = await generateGymDisplayId(req.user.id);

    // For NOT NULL columns: use provided value or a safe default.
    const newPhone   = (phone && String(phone).trim())   ? String(phone).trim()   : og.phone;
    const newEmail   = (email && String(email).trim())   ? String(email).trim()
                     : `branch.${displayId.toLowerCase().replace(/-/g, '.')}@noreply.invalid`;
    const newAddress = (address && String(address).trim()) ? String(address).trim() : (og.address || '');

    const result = await pool.query(
      `INSERT INTO gyms (owner_name, name, address, phone, email, display_id, owner_user_id,
                         subscription_status, trial_started_at, trial_ends_at, subscription_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, name, address, phone, email, display_id, created_at`,
      [og.owner_name, gymName.trim(), newAddress, newPhone, newEmail,
       displayId, req.user.id, og.subscription_status,
       og.trial_started_at, og.trial_ends_at, og.subscription_ends_at]
    );
    ok(res, [result.rows[0]], 'Success');
  } catch (error) { next(error); }
});

// PUT /api/gyms/:gymId/details — update any gym owned by this owner
app.put('/api/gyms/:gymId/details', authenticate, authorizeOwnerOnly, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { gymId } = req.params;
    const { gymName, address, phone, email } = req.body;
    // Verify ownership
    const check = await pool.query(
      `SELECT id FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false`,
      [gymId, req.user.id]
    );
    if (!check.rows.length) return fail(res, 'Gym not found or access denied');
    const emailVal = email && String(email).trim() ? String(email).trim() : null;
    await pool.query(
      `UPDATE gyms SET name = COALESCE($1, name), address = COALESCE($2, address),
        phone = COALESCE(NULLIF($3,''), phone),
        email = COALESCE($4::text, email)
       WHERE id = $5`,
      [gymName || null, address || null, phone || null, emailVal, gymId]
    );
    ok(res, [], 'Location updated');
  } catch (error) { next(error); }
});

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
      ok(res, [], 'Gym details updated successfully');
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
    if (!serial_number) return fail(res, 'serial_number required');
    const result = await pool.query(
      `INSERT INTO biometric_devices (gym_id, serial_number, device_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (gym_id, serial_number) DO UPDATE
         SET device_name = EXCLUDED.device_name, is_active = TRUE
       RETURNING id, serial_number, device_name, last_seen_at, is_active, created_at`,
      [req.gym_id, serial_number.trim().toUpperCase(), device_name?.trim() || null]
    );
    ok(res, [result.rows[0]], 'Success');
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
    ok(res, result.rows, 'Fetched successfully');
  } catch (error) { next(error); }
});

// Delete a device
app.delete('/api/biometric/devices/:id', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await pool.query(`DELETE FROM biometric_devices WHERE id = $1 AND gym_id = $2`, [req.params.id, req.gym_id]);
    ok(res, [], 'Success');
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
    ok(res, result.rows, 'Fetched successfully');
  } catch (error) { next(error); }
});

// Map a device user ID to a member (or clear the mapping)
app.put('/api/biometric/mappings', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { serial_number, device_user_id, member_id } = req.body;
    if (!serial_number || !device_user_id) return fail(res, 'serial_number and device_user_id required');
    const result = await pool.query(
      `INSERT INTO biometric_mappings (gym_id, serial_number, device_user_id, member_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (gym_id, serial_number, device_user_id) DO UPDATE SET member_id = EXCLUDED.member_id
       RETURNING *`,
      [req.gym_id, serial_number.trim().toUpperCase(), device_user_id.trim(), member_id || null]
    );
    ok(res, [result.rows[0]], 'Success');
  } catch (error) { next(error); }
});

// QR code attendance — staff scans member's QR
app.post('/api/attendance/qr', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { member_id } = req.body;
    if (!member_id) return fail(res, 'member_id required');
    const memberRes = await pool.query(
      `SELECT id, name FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = FALSE`,
      [member_id, req.gym_id]
    );
    if (memberRes.rows.length === 0) return fail(res, 'Member not found');
    const today = new Date().toISOString().split('T')[0];
    const member_name = memberRes.rows[0].name;

    // Check if already marked today to avoid duplicate-constraint error
    const existCheck = await pool.query(
      `SELECT id FROM attendance_logs WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3::date LIMIT 1`,
      [req.gym_id, member_id, today]
    );
    if (existCheck.rows.length === 0) {
      await pool.query(
        `INSERT INTO attendance_logs (gym_id, member_id, visit_date, visited_at, status, source)
         VALUES ($1, $2, $3::date, NOW(), 'present', 'qr')`,
        [req.gym_id, member_id, today]
      );
      await pool.query(
        `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND (last_visit_date IS NULL OR last_visit_date < $1)`,
        [today, member_id]
      );
    }
    ok(res, [{ member_name, already_marked: existCheck.rows.length > 0 }], `Attendance marked for ${member_name}`);
  } catch (error) { next(error); }
});

// Self check-in — member marks their own attendance via mobile app
app.post('/api/attendance/checkin', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // IST (UTC+5:30) — ensures midnight IST doesn't bleed into previous UTC day
    const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Member profile not found');

    // Check if already marked today — try visited_at first, fall back to visit_date
    let existing: any = { rows: [] };
    try {
      existing = await pool.query(
        `SELECT id, source FROM attendance_logs
         WHERE gym_id = $1 AND member_id = $2 AND visit_date = $3::date`,
        [req.gym_id, memberIdParam, today]
      );
    } catch (colErr: any) {
      if (colErr?.message?.includes('visit_date')) {
        existing = await pool.query(
          `SELECT id, source FROM attendance_logs
           WHERE gym_id = $1 AND member_id = $2 AND DATE(visited_at) = $3`,
          [req.gym_id, memberIdParam, today]
        );
      } else { throw colErr; }
    }
    if (existing.rows.length > 0) {
      return ok(res, [{ already_marked: true, source: existing.rows[0].source }], 'Already marked today');
    }

    // Insert attendance — progressive fallback: drop unavailable columns one by one
    let inserted = false;
    const insertAttempts: Array<[string, any[]]> = [
      [`INSERT INTO attendance_logs (gym_id, member_id, visited_at, visit_date, status, source) VALUES ($1, $2, NOW(), $3::date, 'present', 'mobile') ON CONFLICT ON CONSTRAINT idx_attendance_member_day DO NOTHING`, [req.gym_id, memberIdParam, today]],
      [`INSERT INTO attendance_logs (gym_id, member_id, visit_date, status, source) VALUES ($1, $2, $3, 'present', 'mobile') ON CONFLICT DO NOTHING`, [req.gym_id, memberIdParam, today]],
      [`INSERT INTO attendance_logs (gym_id, member_id, visited_at, visit_date, source) VALUES ($1, $2, NOW(), $3::date, 'mobile') ON CONFLICT DO NOTHING`, [req.gym_id, memberIdParam, today]],
      [`INSERT INTO attendance_logs (gym_id, member_id, visit_date, source) VALUES ($1, $2, $3, 'mobile') ON CONFLICT DO NOTHING`, [req.gym_id, memberIdParam, today]],
    ];
    for (const [sql, params] of insertAttempts) {
      try { await pool.query(sql, params); inserted = true; break; } catch { /* try next variant */ }
    }
    if (!inserted) throw new Error('Failed to record attendance — database schema error');
    await pool.query(
      `UPDATE members SET last_visit_date = $1 WHERE id = $2 AND (last_visit_date IS NULL OR last_visit_date < $1)`,
      [today, memberIdParam]
    );
    ok(res, [{ already_marked: false, source: 'mobile' }], 'Attendance marked!');
  } catch (error) { next(error); }
});

// ============================================================================
// CUSTOMER LINK-ACCOUNT  (self-service repair for broken member links)
// ============================================================================

app.post('/api/customer/link-account', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { phone } = req.body;
    if (!phone || String(phone).trim().length < 5) {
      return fail(res, 'Phone number is required');
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
      return fail(res, 'No member found with that phone number in your gym. Please check with your gym owner.');
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
        return fail(res, 'This member record is already linked to another account. Please contact your gym owner.');
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

    ok(res, [{ member_id: member.id, access_token: newAccessToken }], `Account linked to member "${member.name}" successfully!`);
  } catch (error) { next(error); }
});

// ============================================================================
// CUSTOMER PORTAL ENDPOINTS  (role: member)
// ============================================================================

app.get('/api/customer/profile', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Profile not found');

    // Try full query first; fall back gracefully when optional columns don't exist yet.
    // Each catch narrows the column set until we have a working query.
    let result: any;
    try {
      result = await pool.query(
        `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                m.membership_expiry_date, m.plan_fee, m.plan, m.created_at,
                COALESCE(m.email_verified, FALSE) AS email_verified,
                COALESCE(m.phone_verified, FALSE) AS phone_verified,
                COALESCE(m.profile_photo_url, '') AS profile_photo_url,
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
                  '' AS profile_photo_url,
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
                  '' AS profile_photo_url,
                  g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                  FALSE AS payment_enabled
           FROM members m
           JOIN gyms g ON m.gym_id = g.id
           WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
          [memberIdParam, req.gym_id]
        );
      }
    }
    if (result.rows.length === 0) return fail(res, 'Profile not found');
    const mRow = result.rows[0];
    ok(res, [{ ...mRow, profilePhotoUrl: mRow.profile_photo_url || '' }], 'Profile fetched');
  } catch (error) { next(error); }
});

// GET /api/customer/home — single-call data for member home screen
app.get('/api/customer/home', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Profile not found');

    // Member profile + gym
    let profileResult: any;
    try {
      profileResult = await pool.query(
        `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                m.membership_expiry_date, m.plan_fee, m.plan, m.created_at,
                m.display_id,
                COALESCE(m.email_verified, FALSE) AS email_verified,
                COALESCE(m.phone_verified, FALSE) AS phone_verified,
                COALESCE(m.profile_photo_url, '') AS profile_photo_url,
                g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                (COALESCE(g.razorpay_key_id, '') != '') AS payment_enabled
         FROM members m JOIN gyms g ON m.gym_id = g.id
         WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
        [memberIdParam, req.gym_id]
      );
    } catch {
      profileResult = await pool.query(
        `SELECT m.id, m.name, m.phone, m.email, m.status, m.last_visit_date,
                m.membership_expiry_date, m.plan_fee, m.plan, m.created_at,
                NULL AS display_id,
                FALSE AS email_verified, FALSE AS phone_verified,
                '' AS profile_photo_url,
                g.name AS gym_name, g.address AS gym_address, g.phone AS gym_phone,
                FALSE AS payment_enabled
         FROM members m JOIN gyms g ON m.gym_id = g.id
         WHERE m.id = $1 AND m.gym_id = $2 AND m.is_deleted = false`,
        [memberIdParam, req.gym_id]
      );
    }
    if (profileResult.rows.length === 0) return fail(res, 'Profile not found');
    const mRow = profileResult.rows[0];

    // Last 35 days of attendance — use IST for date boundary
    const cutoff = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    cutoff.setUTCDate(cutoff.getUTCDate() - 35);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    let attResult: any;
    try {
      attResult = await pool.query(
        `SELECT visit_date::text AS day, source, visited_at
         FROM attendance_logs
         WHERE gym_id = $1 AND member_id = $2 AND visit_date >= $3::date
           AND COALESCE(status, 'present') = 'present'
         ORDER BY visit_date DESC`,
        [req.gym_id, memberIdParam, cutoffStr]
      );
    } catch {
      attResult = await pool.query(
        `SELECT visit_date::text AS day, source, NULL AS visited_at
         FROM attendance_logs
         WHERE gym_id = $1 AND member_id = $2 AND visit_date >= $3
         ORDER BY day DESC`,
        [req.gym_id, memberIdParam, cutoffStr]
      );
    }

    const presentMap = new Map<string, { source: string; visitedAt: string | null }>();
    for (const r of attResult.rows) {
      const ds = String(r.day).substring(0, 10);
      if (!presentMap.has(ds)) presentMap.set(ds, { source: r.source || 'mobile', visitedAt: r.visited_at ? new Date(r.visited_at).toISOString() : null });
    }

    // Use IST (UTC+5:30) for all date calculations — gym app serves Indian users
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const istDateStr = (d: Date) => new Date(d.getTime() + istOffset).toISOString().split('T')[0];
    const today = istNow.toISOString().split('T')[0];
    const todayData = presentMap.get(today);
    const todayMarked = !!todayData;

    // Streak: consecutive days ending today (or yesterday) — in IST
    let streak = 0;
    const cd = new Date(istNow);
    if (!todayMarked) cd.setUTCDate(cd.getUTCDate() - 1);
    for (let i = 0; i < 35; i++) {
      if (!presentMap.has(cd.toISOString().split('T')[0])) break;
      streak++;
      cd.setUTCDate(cd.getUTCDate() - 1);
    }

    // This week (Mon–today) in IST
    const dow = istNow.getUTCDay();
    const mondayOff = dow === 0 ? 6 : dow - 1;
    const monday = new Date(istNow); monday.setUTCDate(istNow.getUTCDate() - mondayOff);
    const thisWeekDays = mondayOff + 1;
    let thisWeekPresent = 0;
    for (let i = 0; i < thisWeekDays; i++) {
      const d = new Date(monday); d.setUTCDate(monday.getUTCDate() + i);
      if (presentMap.has(d.toISOString().split('T')[0])) thisWeekPresent++;
    }

    // This month in IST
    const thisMonthDays = istNow.getUTCDate();
    let thisMonthPresent = 0;
    for (let i = 1; i <= thisMonthDays; i++) {
      const d = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), i));
      if (presentMap.has(d.toISOString().split('T')[0])) thisMonthPresent++;
    }

    // Recent 7 days for calendar strip — in IST
    const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const recentDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(istNow); d.setUTCDate(istNow.getUTCDate() - i);
      const ds = d.toISOString().split('T')[0];
      recentDays.push({ date: ds, dayLabel: i === 0 ? 'TODAY' : dayNames[d.getUTCDay()], present: presentMap.has(ds), isToday: i === 0 });
    }

    ok(res, [{ profile: { ...mRow, profilePhotoUrl: mRow.profile_photo_url || '' }, todayStatus: { marked: todayMarked, source: todayData?.source || null, checkedInAt: todayData?.visitedAt || null }, streak, thisWeekPresent, thisWeekDays, thisMonthPresent, thisMonthDays, recentDays }], 'Home data fetched');

  } catch (error) { next(error); }
});

app.put('/api/customer/profile', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, email, phone, photoBase64 } = req.body;
    if (!name || name.trim().length < 2) return fail(res, 'Name must be at least 2 characters');
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Profile not found');
    const newPhone = phone?.trim() || null;
    const newEmail = email?.trim() || null;
    try {
      // With phone column update
      await pool.query(
        `UPDATE members SET name = $1, email = $2, phone = COALESCE(NULLIF($3, ''), phone) WHERE id = $4 AND gym_id = $5 AND is_deleted = false`,
        [name.trim(), newEmail, newPhone, memberIdParam, req.gym_id]
      );
    } catch {
      // Fallback: without phone (column may not exist or other issue)
      await pool.query(
        `UPDATE members SET name = $1, email = $2 WHERE id = $3 AND gym_id = $4 AND is_deleted = false`,
        [name.trim(), newEmail, memberIdParam, req.gym_id]
      );
    }
    ok(res, [], 'Profile updated');
    if (photoBase64 && typeof photoBase64 === 'string' && photoBase64.length > 0) {
      try {
        const url = await uploadBase64Photo(photoBase64, `members/${memberIdParam}/profile.jpg`);
        await pool.query(`UPDATE members SET profile_photo_url = $1 WHERE id = $2`, [url, memberIdParam]);
      } catch (photoErr) { console.error('Member photo upload failed:', photoErr); }
    }
  } catch (error) { next(error); }
});

// In-memory OTP store for profile field verification (email/phone)
const profileVerifyOtpStore = new Map<string, { code: string; expires: Date; userId: string; type: 'email' | 'phone'; value: string }>();

app.post('/api/customer/send-verify-otp', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { type } = req.body as { type?: string };
    if (type !== 'email' && type !== 'phone') return fail(res, 'type must be email or phone');
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Member not found');
    const profile = await pool.query(`SELECT email, phone FROM members WHERE id = $1 AND gym_id = $2`, [memberIdParam, req.gym_id]);
    if (!profile.rows[0]) return fail(res, 'Member not found');
    const target: string | null = type === 'email' ? profile.rows[0].email : profile.rows[0].phone;
    if (!target) return fail(res, `No ${type} set on your profile`);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const key = crypto.randomBytes(16).toString('hex');
    profileVerifyOtpStore.set(key, { code: otp, expires: new Date(Date.now() + 10 * 60 * 1000), userId: req.user.id, type: type as 'email' | 'phone', value: target });
    if (type === 'email') {
      await sendEmail(target, 'Verify your Recurva email',
        `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
          <h2 style="color:#2196F3">Verify Your Email</h2>
          <p style="color:#444">Enter this code in the app to verify your email address:</p>
          <div style="background:#fff;border:2px solid #2196F3;border-radius:10px;padding:20px;text-align:center;margin:24px 0">
            <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#1a1a1a;font-family:monospace">${otp}</span>
          </div>
          <p style="color:#888;font-size:12px">This code expires in 10 minutes.</p>
        </div>`
      );
      const masked = target.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 4)) + c);
      ok(res, [{ key, masked, via: 'email' }], 'OTP sent');
    } else {
      // Phone OTP: send code to member's email address (SMS not configured)
      const emailResult = await pool.query(`SELECT email FROM members WHERE id = (SELECT id FROM members WHERE gym_id = $1 AND is_deleted = false AND (phone = $2 OR RIGHT(phone,10) = RIGHT($2,10)) LIMIT 1)`, [req.gym_id, target]).catch(() => ({ rows: [] as any[] }));
      const memberEmail: string | null = emailResult.rows[0]?.email || null;
      if (!memberEmail) return fail(res, 'No email address on file. Please add an email first to receive the OTP.');
      await sendEmail(memberEmail, 'Verify your phone number — Recurva',
        `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
          <h2 style="color:#4CAF50">Verify Your Phone Number</h2>
          <p style="color:#444">Enter this code in the app to verify your phone number <strong>${target}</strong>:</p>
          <div style="background:#fff;border:2px solid #4CAF50;border-radius:10px;padding:20px;text-align:center;margin:24px 0">
            <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#1a1a1a;font-family:monospace">${otp}</span>
          </div>
          <p style="color:#888;font-size:12px">This code expires in 10 minutes.</p>
        </div>`
      );
      const maskedEmail = memberEmail.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => a + '*'.repeat(Math.min(b.length, 4)) + c);
      ok(res, [{ key, masked: maskedEmail, via: 'email' }], 'OTP sent');
    }
  } catch (error) { next(error); }
});

app.post('/api/customer/confirm-verify-otp', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { key, code } = req.body as { key?: string; code?: string };
    if (!key || !code) return fail(res, 'key and code are required');
    const stored = profileVerifyOtpStore.get(key);
    if (!stored || stored.userId !== req.user.id) return fail(res, 'Invalid verification session');
    if (new Date() > stored.expires) { profileVerifyOtpStore.delete(key); return fail(res, 'OTP expired — please request a new one'); }
    if (stored.code !== String(code).trim()) return fail(res, 'Incorrect code. Please try again.');
    profileVerifyOtpStore.delete(key);
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Member not found');
    const col = stored.type === 'email' ? 'email_verified' : 'phone_verified';
    const valCol = stored.type === 'email' ? 'email' : 'phone';
    try {
      await pool.query(`UPDATE members SET ${col} = true WHERE id = $1 AND ${valCol} = $2 AND gym_id = $3`, [memberIdParam, stored.value, req.gym_id]);
    } catch { /* column may not exist yet — best effort */ }
    ok(res, [], `${stored.type === 'email' ? 'Email' : 'Phone'} verified successfully!`);
  } catch (error) { next(error); }
});

// Firebase phone verification — client verified phone via Firebase SMS, now mark it on our DB
app.post('/api/customer/firebase-verify-phone', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { firebaseIdToken } = req.body as { firebaseIdToken?: string };
    if (!firebaseIdToken) return fail(res, 'firebaseIdToken is required');

    // Verify the Firebase token
    let decodedToken: any;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseIdToken);
    } catch {
      return fail(res, 'Invalid or expired Firebase token');
    }

    const firebasePhone: string | undefined = decodedToken.phone_number;
    if (!firebasePhone) return fail(res, 'Firebase token does not contain a phone number');

    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Member not found');

    // Verify phone matches member's stored phone (last 10 digits)
    const memberRes = await pool.query(`SELECT phone FROM members WHERE id = $1 AND gym_id = $2`, [memberIdParam, req.gym_id]);
    const memberPhone: string = memberRes.rows[0]?.phone || '';
    const normalize = (p: string) => p.replace(/\D/g, '').slice(-10);
    if (!memberPhone || normalize(firebasePhone) !== normalize(memberPhone)) {
      return fail(res, 'Verified phone does not match your profile phone number');
    }

    try {
      await pool.query(`UPDATE members SET phone_verified = true WHERE id = $1 AND gym_id = $2`, [memberIdParam, req.gym_id]);
    } catch { /* phone_verified column may not exist yet — best effort */ }

    // Sign out the temporary Firebase session so it doesn't interfere with the member's auth
    try { await admin.auth().revokeRefreshTokens(decodedToken.uid); } catch { /* best effort */ }

    ok(res, [], 'Phone verified successfully!');
  } catch (error) { next(error); }
});

app.get('/api/customer/attendance', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const year  = parseInt((req.query.year  as string) || `${new Date().getFullYear()}`);
    const month = parseInt((req.query.month as string) || `${new Date().getMonth() + 1}`);
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return fail(res, 'Member profile not found. Please contact your gym.');
    // Use visit_date (stored as IST date string) for consistent timezone-safe queries
    let attResult: any;
    try {
      attResult = await pool.query(
        `SELECT visit_date::text AS date, 'present' AS status, COALESCE(source, 'staff') AS source
         FROM attendance_logs
         WHERE member_id = $1 AND gym_id = $2
           AND visit_date IS NOT NULL
           AND COALESCE(status, 'present') = 'present'
           AND EXTRACT(YEAR  FROM visit_date) = $3
           AND EXTRACT(MONTH FROM visit_date) = $4
         ORDER BY date`,
        [memberIdParam, req.gym_id, year, month]
      );
    } catch {
      // Fallback for older schemas without status column
      attResult = await pool.query(
        `SELECT visit_date::text AS date, 'present' AS status
         FROM attendance_logs
         WHERE member_id = $1 AND gym_id = $2
           AND visit_date IS NOT NULL
           AND EXTRACT(YEAR  FROM visit_date) = $3
           AND EXTRACT(MONTH FROM visit_date) = $4
         ORDER BY date`,
        [memberIdParam, req.gym_id, year, month]
      );
    }
    ok(res, attResult.rows, 'Fetched successfully');
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
    if (!amount || Number(amount) < 1) return fail(res, 'Amount must be at least ₹1');
    const amountPaise = Math.round(Number(amount) * 100);
    const { data: order, keyId } = await razorpayRequest(req.gym_id!, '/orders', 'POST', {
      amount: amountPaise, currency: 'INR', receipt: `rcpt_${Date.now()}`,
    });
    await pool.query(
      `INSERT INTO payments (gym_id, member_id, razorpay_order_id, amount, status, description)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [req.gym_id, req.user.member_id, order.id, amountPaise, description || null]
    );
    ok(res, [{ order_id: order.id, amount: amountPaise, currency: 'INR', key_id: keyId }], 'Order created');
  } catch (error) { next(error); }
});

// Member verifies payment after Razorpay checkout completes
app.post('/api/payments/verify', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return fail(res, 'Missing payment fields');

    const gymRes = await pool.query(`SELECT razorpay_key_secret FROM gyms WHERE id = $1`, [req.gym_id]);
    const secret = gymRes.rows[0]?.razorpay_key_secret;
    if (!secret) return fail(res, 'Payment not configured');

    const expectedSig = crypto.createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature)
      return fail(res, 'Payment verification failed. Please contact support.');

    const result = await pool.query(
      `UPDATE payments SET status = 'completed', razorpay_payment_id = $1
       WHERE razorpay_order_id = $2 AND gym_id = $3 AND member_id = $4
       RETURNING id`,
      [razorpay_payment_id, razorpay_order_id, req.gym_id, req.user.member_id]
    );
    if (result.rows.length === 0) return fail(res, 'Payment record not found');
    ok(res, [{ payment_id: result.rows[0].id }], 'Payment successful!');
  } catch (error) { next(error); }
});

// Member views their own payment history
app.get('/api/customer/payments', authenticate, authorize(['member']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt((req.query.page as string) || '1'));
    const limit = Math.min(parseInt((req.query.limit as string) || '20'), 50);
    const offset = (page - 1) * limit;
    let memberIdParam = req.user.member_id ?? await resolveMemberId(req.user.id, req.gym_id!);
    if (!memberIdParam) return ok(res, [], 'Fetched successfully', { page: 1, limit: 20, total: 0, totalPages: 0 });
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
    ok(res, rows.rows, 'Fetched successfully', { page, limit, total: parseInt(cnt.rows[0].count), totalPages: Math.ceil(parseInt(cnt.rows[0].count) / limit) || 1 });
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
    const ownerTotal = parseInt(cnt.rows[0].total);
    ok(res, rows.rows, 'Fetched successfully',
      { page, limit, total: ownerTotal, totalPages: Math.ceil(ownerTotal / limit) || 1 },
      { total_amount: parseInt(cnt.rows[0].total_amount) });
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
// A member is "recovered" when a follow-up task is completed and they subsequently
// attended OR renewed their subscription. Used in both /api/dashboard/kpis and
// /api/revenue so both pages always reflect the same definition.
const TASK_RECOVERY_WHERE = `
  ft.status = 'completed' AND ft.completed_at IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM attendance_logs al
      WHERE al.member_id = ft.member_id
        AND al.visit_date > ft.completed_at::date
        AND COALESCE(al.status, 'present') = 'present'
    )
    OR EXISTS (
      SELECT 1 FROM revenue_records rr
      WHERE rr.member_id = ft.member_id
        AND rr.tracked_at > ft.completed_at
    )
  )
`.trim();

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
      // Shared recovery condition used in all recovery-related sub-queries
      const RECOVERY_CONDITION = `
        ft.status = 'completed' AND ft.completed_at IS NOT NULL
        AND (
          -- Attendance-based: member attended after task completed
          (ft.task_type IN ('call','check_in','check_progress','custom','send_message')
           AND EXISTS (
             SELECT 1 FROM attendance_logs al
             WHERE al.member_id = ft.member_id
               AND al.visit_date > ft.completed_at::date
               AND COALESCE(al.status,'present') = 'present'
           ))
          OR
          -- Payment-based: revenue record created after task completed
          (ft.task_type IN ('renewal','renew_plan','remind_to_pay')
           AND EXISTS (
             SELECT 1 FROM revenue_records rr
             WHERE rr.member_id = ft.member_id
               AND rr.tracked_at > ft.completed_at
           ))
        )
      `.trim();

      const [membersRes, tasksRes, recoveredRes, riskRes] = await Promise.all([
        client.query(
          `SELECT
            COUNT(*) as total_members,
            COUNT(CASE WHEN status = 'active'    THEN 1 END) as active_members,
            COUNT(CASE WHEN status = 'at_risk'   THEN 1 END) as at_risk_members,
            COUNT(CASE WHEN status = 'high_risk' THEN 1 END) as high_risk_members,
            COUNT(CASE WHEN membership_expiry_date > NOW() THEN 1 END) as active_subscriptions,
            COUNT(CASE WHEN membership_expiry_date > NOW()
                            AND last_visit_date >= NOW() - INTERVAL '30 days' THEN 1 END) as engaged_members,
            COUNT(CASE WHEN created_at >= DATE_TRUNC('month', NOW()) THEN 1 END) as new_this_month
           FROM members WHERE gym_id = $1 AND is_deleted = false`,
          [req.gym_id]
        ),
        client.query(
          `SELECT COUNT(*) as pending_count FROM follow_up_tasks WHERE gym_id = $1 AND status = 'pending'`,
          [req.gym_id]
        ),
        // Revenue recovered — uses shared TASK_RECOVERY_WHERE constant (same as /api/revenue).
        // DISTINCT ON (member_id) ensures each member is counted once using their most
        // recent completed task, so plan_fee is never double-counted across months.
        client.query(
          `WITH recovered AS (
             SELECT DISTINCT ON (ft.member_id)
               ft.member_id,
               CASE
                 WHEN ft.completed_at >= DATE_TRUNC('month', NOW()) THEN 'this'
                 WHEN ft.completed_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
                      AND ft.completed_at <  DATE_TRUNC('month', NOW()) THEN 'last'
                 ELSE 'old'
               END AS period
             FROM follow_up_tasks ft
             WHERE ft.gym_id = $1 AND ${TASK_RECOVERY_WHERE}
             ORDER BY ft.member_id, ft.completed_at DESC
           )
           SELECT
             COUNT(DISTINCT r.member_id)                                               AS total_recovered,
             COUNT(DISTINCT CASE WHEN r.period = 'this' THEN r.member_id END)         AS recovered_this_month,
             COALESCE(SUM(m.plan_fee), 0)                                              AS revenue_recovered_total,
             COALESCE(SUM(CASE WHEN r.period = 'this' THEN m.plan_fee ELSE 0 END), 0) AS revenue_recovered_this_month,
             COALESCE(SUM(CASE WHEN r.period = 'last' THEN m.plan_fee ELSE 0 END), 0) AS revenue_recovered_last_month
           FROM recovered r
           JOIN members m ON m.id = r.member_id`,
          [req.gym_id]
        ),
        // Revenue at risk = plan fees of at-risk / high-risk members
        client.query(
          `SELECT COALESCE(SUM(plan_fee), 0) as revenue_at_risk
           FROM members
           WHERE gym_id = $1 AND is_deleted = false
             AND (${MEMBER_STATUS_SQL}) IN ('at_risk','high_risk')`,
          [req.gym_id]
        ),
      ]);

      const kpis              = membersRes.rows[0];
      const recovered         = recoveredRes.rows[0];

      const total               = parseInt(kpis.total_members) || 0;
      const activeSubscriptions = parseInt(kpis.active_subscriptions) || 0;
      const engagedMembers      = parseInt(kpis.engaged_members) || 0;
      const engagementRate      = activeSubscriptions > 0 ? Math.round((engagedMembers / activeSubscriptions) * 100) : 0;

      const revTotal      = parseFloat(recovered.revenue_recovered_total) || 0;
      const revThisMonth  = parseFloat(recovered.revenue_recovered_this_month) || 0;
      const revLastMonth  = parseFloat(recovered.revenue_recovered_last_month) || 0;
      const revDeltaPct   = revLastMonth > 0 ? Math.round(((revThisMonth - revLastMonth) / revLastMonth) * 100) : 0;

      // KPIs are expensive to compute — cache for 60s on client
      res.setHeader('Cache-Control', 'private, max-age=60');
      ok(res, [{ totalMembers: total, totalMembersDelta: parseInt(kpis.new_this_month)||0, activeMembers: parseInt(kpis.active_members)||0, activeSubscriptions, engagementRate, atRiskMembers: parseInt(kpis.at_risk_members)||0, highRiskMembers: parseInt(kpis.high_risk_members)||0, revenueRecovered: revTotal, revenueRecoveredThisMonth: revThisMonth, revenueRecoveredDelta: revDeltaPct, pendingTasksCount: parseInt(tasksRes.rows[0].pending_count)||0, customersRecovered: parseInt(recovered.total_recovered)||0, customersRecoveredDelta: parseInt(recovered.recovered_this_month)||0, revenueAtRisk: parseFloat(riskRes.rows[0].revenue_at_risk)||0 }], 'KPIs loaded');

    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Recent activity feed
app.get('/api/activity/recent', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || '10'), 50);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT al.id, al.event_type, al.description, al.amount, al.created_at,
                m.name as member_name, t.name as staff_name
         FROM activity_log al
         LEFT JOIN members  m ON al.member_id = m.id
         LEFT JOIN trainers t ON al.staff_id  = t.id
         WHERE al.gym_id = $1
         ORDER BY al.created_at DESC
         LIMIT $2`,
        [req.gym_id, limit]
      );
      ok(res, result.rows, 'Fetched successfully');
    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

// Revenue chart data — supports period=month|quarter|half_year|year
app.get('/api/revenue/daily', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const period = (req.query.period as string) || 'month';
    const month  = (req.query.month  as string) || new Date().toISOString().slice(0, 7);
    const gymId  = req.gym_id;
    const client = await pool.connect();
    try {
      let dataSQL: string;
      let dataValues: any[];
      let currentSQL: string;
      let currentValues: any[];
      let prevSQL: string;
      let prevValues: any[];

      switch (period) {
        case 'quarter':
          dataSQL = `SELECT DATE_TRUNC('week', tracked_at)::date as day,
                            COALESCE(SUM(revenue_recovered), 0) as total
                     FROM revenue_records
                     WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '3 months'
                     GROUP BY day ORDER BY day`;
          dataValues    = [gymId];
          currentSQL    = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '3 months'`;
          currentValues = [gymId];
          prevSQL       = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1
                             AND tracked_at >= NOW() - INTERVAL '6 months'
                             AND tracked_at <  NOW() - INTERVAL '3 months'`;
          prevValues    = [gymId];
          break;
        case 'half_year':
          dataSQL = `SELECT DATE_TRUNC('month', tracked_at)::date as day,
                            COALESCE(SUM(revenue_recovered), 0) as total
                     FROM revenue_records
                     WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '6 months'
                     GROUP BY day ORDER BY day`;
          dataValues    = [gymId];
          currentSQL    = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '6 months'`;
          currentValues = [gymId];
          prevSQL       = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1
                             AND tracked_at >= NOW() - INTERVAL '12 months'
                             AND tracked_at <  NOW() - INTERVAL '6 months'`;
          prevValues    = [gymId];
          break;
        case 'year':
          dataSQL = `SELECT DATE_TRUNC('month', tracked_at)::date as day,
                            COALESCE(SUM(revenue_recovered), 0) as total
                     FROM revenue_records
                     WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '12 months'
                     GROUP BY day ORDER BY day`;
          dataValues    = [gymId];
          currentSQL    = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1 AND tracked_at >= NOW() - INTERVAL '12 months'`;
          currentValues = [gymId];
          prevSQL       = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1
                             AND tracked_at >= NOW() - INTERVAL '24 months'
                             AND tracked_at <  NOW() - INTERVAL '12 months'`;
          prevValues    = [gymId];
          break;
        default: // month — daily breakdown
          dataSQL = `SELECT DATE(tracked_at) as day, COALESCE(SUM(revenue_recovered), 0) as total
                     FROM revenue_records
                     WHERE gym_id = $1 AND TO_CHAR(tracked_at, 'YYYY-MM') = $2
                     GROUP BY day ORDER BY day`;
          dataValues    = [gymId, month];
          currentSQL    = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1 AND TO_CHAR(tracked_at, 'YYYY-MM') = $2`;
          currentValues = [gymId, month];
          prevSQL       = `SELECT COALESCE(SUM(revenue_recovered), 0) as total
                           FROM revenue_records WHERE gym_id = $1
                             AND TO_CHAR(tracked_at, 'YYYY-MM') = TO_CHAR((TO_DATE($2, 'YYYY-MM') - INTERVAL '1 month'), 'YYYY-MM')`;
          prevValues    = [gymId, month];
      }

      const [dataRes, currentRes, prevRes] = await Promise.all([
        client.query(dataSQL, dataValues),
        client.query(currentSQL, currentValues),
        client.query(prevSQL, prevValues),
      ]);

      const currentTotal = parseFloat(currentRes.rows[0].total) || 0;
      const prevTotal    = parseFloat(prevRes.rows[0].total) || 0;
      const deltaPct     = prevTotal > 0 ? Math.round(((currentTotal - prevTotal) / prevTotal) * 100) : 0;

      ok(res, [{ days: dataRes.rows.map(r => ({ day: r.day, total: parseFloat(r.total) })), monthTotal: currentTotal, monthDeltaPct: deltaPct, period }], 'Revenue data');

    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

// Retention alerts — members needing attention
// Owner: all gym members | Trainer: only their assigned members
app.get('/api/retention/alerts', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || '10'), 50);
    const isTrainer = req.user?.role === 'trainer';
    const client = await pool.connect();
    try {
      let trainerCondition = '';
      const params: any[] = [req.gym_id, limit];

      if (isTrainer) {
        const trainerRow = await client.query(
          `SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
          [req.user!.id, req.gym_id]
        );
        const trainerId = trainerRow.rows[0]?.id;
        if (!trainerId) {
          return ok(res, [], 'Fetched successfully');
        }
        params.push(trainerId);
        trainerCondition = 'AND assigned_trainer_id = $3';
      }

      const result = await client.query(
        `SELECT id, name, tier, alert_type, alert_date, amount,
                CASE
                  WHEN alert_type = 'expiring_soon' THEN EXTRACT(DAY FROM (alert_date - NOW()))::int
                  WHEN alert_type = 'inactive'      THEN EXTRACT(DAY FROM (NOW() - alert_date))::int
                  WHEN alert_type = 'payment_pending' THEN NULL
                  ELSE NULL
                END as days_value
         FROM (
           SELECT id, name, COALESCE(tier,'basic') as tier,
                  'expiring_soon' as alert_type, membership_expiry_date as alert_date,
                  NULL::numeric as amount, 1 as priority
           FROM members
           WHERE gym_id = $1 AND is_deleted = false ${trainerCondition}
             AND membership_expiry_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'

           UNION ALL

           SELECT id, name, COALESCE(tier,'basic') as tier,
                  'inactive' as alert_type, COALESCE(last_visit_date, created_at) as alert_date,
                  NULL::numeric as amount, 2 as priority
           FROM members
           WHERE gym_id = $1 AND is_deleted = false ${trainerCondition}
             AND COALESCE(last_visit_date, created_at) < NOW() - INTERVAL '7 days'
             AND membership_expiry_date > NOW() + INTERVAL '7 days'

           UNION ALL

           SELECT id, name, COALESCE(tier,'basic') as tier,
                  'payment_pending' as alert_type, NULL as alert_date,
                  pending_payment_amount as amount, 3 as priority
           FROM members
           WHERE gym_id = $1 AND is_deleted = false ${trainerCondition}
             AND pending_payment_amount > 0
         ) sub
         ORDER BY priority, alert_date ASC NULLS LAST
         LIMIT $2`,
        params
      );
      ok(res, result.rows, 'Fetched successfully');
    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

// GET /api/staff/home — staff dashboard overview (tasks pending/today/done, customers, at-risk, up-next tasks)
app.get('/api/staff/home', authenticate, authorize(['trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const gymId  = req.gym_id!;
    const userId = req.user!.id;

    // Resolve trainer record
    const trainerRes = await pool.query(
      `SELECT id, name, profile_photo_url FROM trainers WHERE user_id = $1 AND gym_id = $2 AND is_deleted = false LIMIT 1`,
      [userId, gymId]
    );
    if (trainerRes.rows.length === 0) {
      return fail(res, 'Trainer profile not found');
    }
    const { id: trainerId, name: trainerName, profile_photo_url: trainerPhotoUrl } = trainerRes.rows[0];
    const firstName = (trainerName as string).split(' ')[0];

    // Task counts
    const taskCountRes = await pool.query(
      `SELECT
         COUNT(CASE WHEN status = 'pending' THEN 1 END)                                              AS pending_count,
         COUNT(CASE WHEN status = 'pending' AND due_date = CURRENT_DATE THEN 1 END)                  AS today_count,
         COUNT(CASE WHEN status = 'completed' AND completed_at >= NOW() - INTERVAL '7 days' THEN 1 END) AS done_count
       FROM follow_up_tasks
       WHERE assigned_trainer_id = $1 AND gym_id = $2`,
      [trainerId, gymId]
    );
    const { pending_count, today_count, done_count } = taskCountRes.rows[0];

    // Customer counts
    const memberCountRes = await pool.query(
      `SELECT
         COUNT(*)                                                          AS total_count,
         COUNT(CASE WHEN status IN ('at_risk','high_risk') THEN 1 END)    AS at_risk_count
       FROM members
       WHERE assigned_trainer_id = $1 AND gym_id = $2 AND is_deleted = false`,
      [trainerId, gymId]
    );
    const { total_count, at_risk_count } = memberCountRes.rows[0];

    // Up-next tasks: overdue + today, pending, limit 5
    const upNextRes = await pool.query(
      `SELECT t.id, t.task_type, t.due_date,
              m.name AS customer_name, m.phone AS customer_phone
       FROM follow_up_tasks t
       LEFT JOIN members m ON t.member_id = m.id
       WHERE t.assigned_trainer_id = $1 AND t.gym_id = $2
         AND t.status = 'pending'
         AND t.due_date <= CURRENT_DATE
       ORDER BY t.due_date ASC, t.created_at ASC
       LIMIT 5`,
      [trainerId, gymId]
    );

    // At-risk / high-risk members assigned to this trainer
    const atRiskRes = await pool.query(
      `SELECT m.id, m.name, m.status,
              EXTRACT(EPOCH FROM (m.membership_expiry_date - NOW()))::INTEGER / 86400 AS days_to_expiry,
              EXTRACT(EPOCH FROM (NOW() - m.last_visit_date))::INTEGER  / 86400        AS days_last_visit
       FROM members m
       WHERE m.assigned_trainer_id = $1 AND m.gym_id = $2 AND m.is_deleted = false
         AND m.status IN ('at_risk', 'high_risk')
       ORDER BY m.membership_expiry_date ASC NULLS LAST
       LIMIT 10`,
      [trainerId, gymId]
    );

    ok(res, [{ staffName: firstName, profilePhotoUrl: trainerPhotoUrl||null, tasksPending: Number(pending_count), tasksToday: Number(today_count), tasksDone: Number(done_count), customersCount: Number(total_count), atRiskCount: Number(at_risk_count), upNextTasks: upNextRes.rows.map(r=>({id:r.id,taskType:r.task_type,customerName:r.customer_name??'Customer',customerPhone:r.customer_phone??null})), atRiskMembers: atRiskRes.rows.map(r=>({memberId:r.id,memberName:r.name,riskLevel:r.status,daysUntilExpiry:r.days_to_expiry!=null?Math.round(Number(r.days_to_expiry)):null,lastVisitDaysAgo:r.days_last_visit!=null?Math.round(Number(r.days_last_visit)):null})) }], 'Staff home');

  } catch (error) { next(error); }
});

// Top staff performers
app.get('/api/staff/top-performers', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const period = req.query.period === 'month' ? '1 month' : '1 week';
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT t.id, t.name, t.trainer_role,
                COUNT(CASE WHEN spl.action_type = 'call'    THEN 1 END)::int as calls_count,
                COUNT(CASE WHEN spl.action_type = 'renewal' THEN 1 END)::int as renewals_count
         FROM trainers t
         LEFT JOIN staff_performance_log spl
           ON spl.staff_id = t.id AND spl.created_at >= NOW() - $2::interval
         WHERE t.gym_id = $1 AND t.is_deleted = false
         GROUP BY t.id, t.name, t.trainer_role
         ORDER BY renewals_count DESC, calls_count DESC
         LIMIT 5`,
        [req.gym_id, period]
      );
      const staff = result.rows.map((r, i) => ({ ...r, rank: i + 1 }));
      ok(res, staff, 'Fetched successfully');
    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

// Live search — members, staff, tasks
app.get('/api/search', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.gym_id) {
      return fail(res, 'gym_id missing from token');
    }
    const q    = ((req.query.q as string) || '').trim();
    const type = (req.query.type as string) || 'all'; // member|staff|task|all
    if (q.length < 1) return ok(res, [], 'No results');

    const search = `%${q}%`;
    const client = await pool.connect();
    try {
      // Run each search query independently so one failure doesn't block others
      const runQuery = async (sql: string, params: any[]) => {
        try {
          const r = await client.query(sql, params);
          return r.rows;
        } catch (err: any) {
          logger.warn({ err: err?.message, sql: sql.slice(0, 60) }, 'search sub-query failed');
          return [];
        }
      };

      const [members, staff, tasks] = await Promise.all([
        (type === 'all' || type === 'member') ? runQuery(
          `SELECT id, name, COALESCE(phone,'') as phone, COALESCE(email,'') as email,
                  status, COALESCE(tier,'basic') as tier,
                  TO_CHAR(membership_expiry_date, 'YYYY-MM-DD') as expiry
           FROM members
           WHERE gym_id = $1 AND is_deleted = false
             AND (name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2)
           ORDER BY name LIMIT 8`,
          [req.gym_id, search]
        ) : Promise.resolve([]),
        (type === 'all' || type === 'staff') ? runQuery(
          `SELECT id, name, COALESCE(phone,'') as phone, COALESCE(email,'') as email,
                  trainer_role
           FROM trainers
           WHERE gym_id = $1 AND is_deleted = false
             AND (name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2)
           ORDER BY name LIMIT 8`,
          [req.gym_id, search]
        ) : Promise.resolve([]),
        (type === 'all' || type === 'task') ? runQuery(
          `SELECT t.id, t.task_type, t.status, t.notes, t.created_at,
                  m.name as member_name, tr.name as staff_name
           FROM follow_up_tasks t
           LEFT JOIN members  m  ON t.member_id = m.id
           LEFT JOIN trainers tr ON t.assigned_trainer_id = tr.id
           WHERE t.gym_id = $1
             AND (t.task_type ILIKE $2 OR t.notes ILIKE $2
                  OR m.name ILIKE $2 OR tr.name ILIKE $2)
           ORDER BY t.created_at DESC LIMIT 8`,
          [req.gym_id, search]
        ) : Promise.resolve([]),
      ]);

      ok(res, [{ members, staff, tasks }], 'Search results');
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({ error, gym_id: req.gym_id }, 'GET /api/search error');
    next(error);
  }
});

// Notifications — sourced from activity_log
// Owner: all gym notifications | Trainer: only their own + assigned-member notifications
app.get('/api/notifications', authenticate, authorize(['owner', 'trainer']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!req.gym_id) return fail(res, 'gym_id missing from token');
    const limit  = Math.min(parseInt(req.query.limit  as string || '50') || 50, 100);
    const offset = parseInt(req.query.offset as string || '0') || 0;
    const isTrainer = req.user?.role === 'trainer';
    const client = await pool.connect();
    try {
      const tableCheck = await client.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public' AND table_name='activity_log') as exists`
      );
      if (!tableCheck.rows[0].exists) {
        return ok(res, [], 'No notifications', { page: 1, limit: 10, total: 0, totalPages: 0 });
      }

      let whereClause = 'WHERE al.gym_id = $1';
      const params: any[] = [req.gym_id];

      if (isTrainer) {
        // Get trainer record from user_id
        const trainerRow = await client.query(
          `SELECT id FROM trainers WHERE user_id = $1 AND gym_id = $2 LIMIT 1`,
          [req.user!.id, req.gym_id]
        );
        const trainerId = trainerRow.rows[0]?.id;
        if (trainerId) {
          params.push(trainerId);
          whereClause += ` AND (
            al.staff_id = $2
            OR al.member_id IN (SELECT id FROM members WHERE assigned_trainer_id = $2 AND gym_id = $1)
          )`;
        }
      }

      const [countRes, itemsRes] = await Promise.all([
        client.query(`SELECT COUNT(*) as total FROM activity_log al ${whereClause}`, params),
        client.query(
          `SELECT al.id, al.event_type, al.description, al.amount,
                  al.created_at, al.member_id, al.staff_id,
                  m.name as member_name, t.name as staff_name
           FROM activity_log al
           LEFT JOIN members  m ON al.member_id = m.id
           LEFT JOIN trainers t ON al.staff_id  = t.id
           ${whereClause}
           ORDER BY al.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
      ]);

      ok(res, itemsRes.rows, 'Fetched successfully', undefined, { total: parseInt(countRes.rows[0].total)||0 });
    } finally { client.release(); }
  } catch (error) {
    logger.error({ error, gym_id: req.gym_id }, 'GET /api/notifications error');
    next(error);
  }
});

app.get('/api/revenue', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const client = await pool.connect();
    try {
      const [metricsRes, recoveredRes, recordsRes, monthlyRes, lastMonthRes, dailyRes, methodRes, pendingRes] = await Promise.all([
        client.query(
          `SELECT
             COALESCE(SUM(r.revenue_recovered), 0) as total_revenue,
             COALESCE(SUM(CASE WHEN DATE_TRUNC('month', r.tracked_at) = DATE_TRUNC('month', NOW()) THEN r.revenue_recovered ELSE 0 END), 0) as revenue_this_month,
             COALESCE(SUM(CASE WHEN DATE_TRUNC('year', r.tracked_at) = DATE_TRUNC('year', NOW()) THEN r.revenue_recovered ELSE 0 END), 0) as revenue_this_year
           FROM revenue_records r WHERE r.gym_id = $1`, [req.gym_id]),
        client.query(
          `WITH recovered AS (SELECT DISTINCT ft.member_id FROM follow_up_tasks ft WHERE ft.gym_id = $1 AND ${TASK_RECOVERY_WHERE})
           SELECT COUNT(DISTINCT r.member_id) AS recovered_count, COALESCE(SUM(m.plan_fee), 0) AS recovered_revenue
           FROM recovered r JOIN members m ON m.id = r.member_id`, [req.gym_id]),
        client.query(
          `SELECT r.id, r.member_id,
                  m.name as member_name, m.phone, m.email, m.plan,
                  t.name as staff_name,
                  g.name as gym_name,
                  r.action,
                  r.revenue_recovered, COALESCE(r.payment_method, 'cash') as payment_method, r.tracked_at
           FROM revenue_records r
           LEFT JOIN members  m ON r.member_id = m.id
           LEFT JOIN trainers t ON m.assigned_trainer_id = t.id
           LEFT JOIN gyms     g ON r.gym_id = g.id
           WHERE r.gym_id = $1 ORDER BY r.tracked_at DESC LIMIT 500`, [req.gym_id]),
        client.query(
          `SELECT DATE_TRUNC('month', tracked_at) as month,
                  SUM(revenue_recovered) as total_revenue, COUNT(*) as recovery_count
           FROM revenue_records WHERE gym_id = $1
           GROUP BY DATE_TRUNC('month', tracked_at) ORDER BY month DESC LIMIT 12`, [req.gym_id]),
        // Last month total for delta %
        client.query(
          `SELECT COALESCE(SUM(revenue_recovered), 0) as total
           FROM revenue_records WHERE gym_id = $1
             AND DATE_TRUNC('month', tracked_at) = DATE_TRUNC('month', NOW() - INTERVAL '1 month')`, [req.gym_id]),
        // Daily trend: generate every day of the current month up to today, left-join revenue
        client.query(
          `SELECT d.day::date AS day, COALESCE(SUM(rr.revenue_recovered), 0) AS total
           FROM generate_series(
             DATE_TRUNC('month', NOW()),
             LEAST(NOW()::date, DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'),
             INTERVAL '1 day'
           ) d(day)
           LEFT JOIN revenue_records rr
             ON DATE(rr.tracked_at) = d.day::date AND rr.gym_id = $1
           GROUP BY d.day ORDER BY d.day ASC`, [req.gym_id]),
        // Payment method split for current month
        client.query(
          `SELECT COALESCE(payment_method, 'cash') as method,
                  SUM(revenue_recovered) as total, COUNT(*) as count
           FROM revenue_records WHERE gym_id = $1
             AND DATE_TRUNC('month', tracked_at) = DATE_TRUNC('month', NOW())
           GROUP BY method`, [req.gym_id]),
        // Pending = members expiring within 7 days or already expired, not deleted
        client.query(
          `SELECT COUNT(*) as count, COALESCE(SUM(plan_fee), 0) as amount
           FROM members WHERE gym_id = $1 AND is_deleted = false
             AND membership_expiry_date <= NOW() + INTERVAL '7 days'`, [req.gym_id]),
      ]);

      const m = metricsRes.rows[0];
      const rec = recoveredRes.rows[0];
      const lastMonthTotal = parseFloat(lastMonthRes.rows[0]?.total || '0');
      const thisMonthTotal = parseFloat(m.revenue_this_month);
      const deltaVsLastMonth = lastMonthTotal > 0
        ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100) : 0;

      // Build online vs cash split
      let onlineTotal = 0, cashTotal = 0, onlineCount = 0, cashCount = 0;
      for (const r of methodRes.rows) {
        const isOnline = r.method === 'online' || r.method === 'razorpay' || r.method === 'gpay' || r.method === 'upi';
        if (isOnline) { onlineTotal += parseFloat(r.total); onlineCount += parseInt(r.count); }
        else { cashTotal += parseFloat(r.total); cashCount += parseInt(r.count); }
      }
      const methodGrandTotal = onlineTotal + cashTotal;
      const onlinePct = methodGrandTotal > 0 ? Math.round((onlineTotal / methodGrandTotal) * 100) : 0;

      ok(res, [{ metrics: { totalRevenueRecovered: parseFloat(m.total_revenue), revenueThisMonth: thisMonthTotal, revenueThisYear: parseFloat(m.revenue_this_year), lastMonthRevenue: lastMonthTotal, deltaVsLastMonth, revenueRecoveredByTasks: parseFloat(rec.recovered_revenue)||0, customersRecoveredByTasks: parseInt(rec.recovered_count)||0, pendingCount: parseInt(pendingRes.rows[0]?.count||'0'), pendingAmount: parseFloat(pendingRes.rows[0]?.amount||'0') }, paymentMethodSplit: { online: onlineTotal, cash: cashTotal, onlineCount, cashCount, onlinePct, cashPct: 100-onlinePct }, dailyTrend: dailyRes.rows.map(r=>({day:r.day,total:parseFloat(r.total)})), revenueRecords: recordsRes.rows, revenue: monthlyRes.rows.map(row=>({month:row.month,total:parseFloat(row.total_revenue),count:parseInt(row.recovery_count)})) }], 'Revenue overview');

    } finally { client.release(); }
  } catch (error) { next(error); }
});

// Recovery history — members who renewed/paid, with inactivity info
// Supports: ?all=true (all-time), ?month=YYYY-MM (specific month), default = current month
app.get('/api/revenue/recovery-history', authenticate, authorize(['owner']), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const allTime = req.query.all === 'true';
    const month   = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const params: any[]   = [req.gym_id];
    const monthClause = allTime ? '' : `AND TO_CHAR(rr.tracked_at, 'YYYY-MM') = $2`;
    if (!allTime) params.push(month);

    const rows = await pool.query(
      `WITH task_recovered AS (
         SELECT DISTINCT ft.member_id,
                ft.task_type, ft.issue_type, ft.custom_issue,
                t2.name as staff_name,
                ft.completed_at
         FROM follow_up_tasks ft
         LEFT JOIN trainers t2 ON ft.assigned_trainer_id = t2.id
         WHERE ft.gym_id = $1
           AND ${TASK_RECOVERY_WHERE}
       )
       SELECT DISTINCT ON (rr.member_id)
         rr.id, rr.revenue_recovered, COALESCE(rr.payment_method, 'cash') as payment_method, rr.tracked_at,
         m.name as member_name, m.phone, m.email, m.plan, m.last_visit_date,
         GREATEST(0, EXTRACT(DAY FROM (rr.tracked_at - COALESCE(m.last_visit_date, rr.tracked_at - INTERVAL '1 day')))::int) as inactive_days,
         tr.task_type, tr.issue_type, tr.custom_issue, tr.staff_name, tr.completed_at
       FROM revenue_records rr
       JOIN members m ON rr.member_id = m.id
       JOIN task_recovered tr ON tr.member_id = m.id
       WHERE rr.gym_id = $1 ${monthClause}
       ORDER BY rr.member_id, rr.tracked_at DESC`,
      params
    );
    const total       = rows.rows.reduce((s: number, r: any) => s + parseFloat(r.revenue_recovered), 0);
    const memberCount = rows.rowCount ?? rows.rows.length;
    ok(res, rows.rows, 'Fetched successfully', undefined, { monthTotal: total, memberCount });
  } catch (error) { next(error); }
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
cron.schedule('*/15 * * * *', async () => {
  logger.info('Running 15-min member status recalculation');
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


// ============================================================================
// ADMIN PANEL ENDPOINTS
// ============================================================================

// Simple token-based admin auth (no gym JWT needed — separate secret)
const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_SECRET) {
    return fail(res, 'Unauthorized');
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
    ok(res, result.rows, 'Fetched successfully');
  } catch (err: any) {
    // Fallback: migration_gym_block.sql not yet run — return without block columns
    if (err?.message?.includes('column') && err?.message?.includes('does not exist')) {
      try {
        const result = await pool.query(baseSelect);
        const rows = result.rows.map((r: any) => ({ ...r, is_blocked: false, blocked_at: null, blocked_reason: null }));
        ok(res, rows, 'Fetched successfully', undefined, { _migration_needed: 'Run database/migration_gym_block.sql in Supabase SQL editor to enable block/unblock feature' });
        return;
      } catch (fallbackErr: any) {
        logger.error({ fallbackErr }, 'Admin: fallback list gyms also failed');
      }
    }
    logger.error({ err }, 'Admin: failed to list gyms');
    fail(res, 'Failed to fetch gyms');
  }
});

const _uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/gyms/:id/suspend — set subscription_status = 'suspended'
app.post('/api/admin/gyms/:id/suspend', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return fail(res, 'Gym not found');
    const result = await pool.query(
      `UPDATE gyms SET subscription_status = 'suspended' WHERE id = $1 AND is_deleted = false RETURNING name`, [id]
    );
    if (result.rows.length === 0) return fail(res, 'Gym not found');
    logger.info({ gymId: id }, 'Admin: gym suspended');
    ok(res, [], `"${result.rows[0].name}" suspended`);
  } catch (err: any) {
    fail(res, 'Failed to suspend gym');
  }
});

// POST /api/admin/gyms/:id/reactivate — restore trial or active status
app.post('/api/admin/gyms/:id/reactivate', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return fail(res, 'Gym not found');
    const result = await pool.query(
      `SELECT name, subscription_ends_at FROM gyms WHERE id = $1 AND is_deleted = false`, [id]
    );
    if (result.rows.length === 0) return fail(res, 'Gym not found');
    const gym = result.rows[0];
    const newStatus = gym.subscription_ends_at && new Date(gym.subscription_ends_at) > new Date()
      ? 'active' : 'trial';
    await pool.query(`UPDATE gyms SET subscription_status = $1 WHERE id = $2`, [newStatus, id]);
    logger.info({ gymId: id, newStatus }, 'Admin: gym reactivated');
    ok(res, [], `"${gym.name}" reactivated as ${newStatus}`);
  } catch (err: any) {
    fail(res, 'Failed to reactivate gym');
  }
});

// POST /api/admin/gyms/:id/block — block gym access (logins and API requests rejected immediately)
app.post('/api/admin/gyms/:id/block', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return fail(res, 'Gym not found');
    const { reason } = req.body;
    const result = await pool.query(
      `UPDATE gyms SET is_blocked = true, blocked_at = NOW(), blocked_reason = $1 WHERE id = $2 AND is_deleted = false RETURNING name`,
      [reason ?? null, id]
    );
    if (result.rows.length === 0) return fail(res, 'Gym not found');
    logger.info({ gymId: id, reason }, 'Admin: gym blocked');
    ok(res, [], `"${result.rows[0].name}" has been blocked. All logins and API access are denied immediately.`);
  } catch (err: any) {
    logger.error(err, 'Admin block gym failed');
    fail(res, 'Failed to block gym');
  }
});

// POST /api/admin/gyms/:id/unblock — restore gym access
app.post('/api/admin/gyms/:id/unblock', adminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return fail(res, 'Gym not found');
    const result = await pool.query(
      `UPDATE gyms SET is_blocked = false, blocked_at = NULL, blocked_reason = NULL WHERE id = $1 AND is_deleted = false RETURNING name`,
      [id]
    );
    if (result.rows.length === 0) return fail(res, 'Gym not found');
    logger.info({ gymId: id }, 'Admin: gym unblocked');
    ok(res, [], `"${result.rows[0].name}" has been unblocked. Access restored.`);
  } catch (err: any) {
    logger.error(err, 'Admin unblock gym failed');
    fail(res, 'Failed to unblock gym');
  }
});

// POST /api/admin/gyms/:id/convert — convert trial → paid (extend by N months)
const convertGymSchema = z.object({
  months: z.number().int().min(1).max(12),
});

app.post('/api/admin/gyms/:id/convert', adminAuth, validate(convertGymSchema), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!_uuidRe.test(id)) return fail(res, 'Gym not found');
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
    if (result.rows.length === 0) return fail(res, 'Gym not found');
    logger.info({ gymId: id, months }, 'Admin: gym converted to paid');
    ok(res, [{ ends_at: endsAt }], `Subscription activated for ${months} month(s)`);
  } catch (err: any) {
    fail(res, 'Failed to convert gym');
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
      return fail(res, 'Gym not found');
    }

    await client.query('BEGIN');
    const gymRes = await client.query(`SELECT name FROM gyms WHERE id = $1 FOR UPDATE`, [id]);
    if (gymRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 'Gym not found');
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

    ok(res, [{ deleted: { members: memberDel.rowCount, trainers: trainerDel.rowCount, tasks: taskDel.rowCount, attendance: attendDel.rowCount, revenue: revDel.rowCount } }], `"${gymName}" and all its data have been permanently deleted`);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(err, 'Admin delete gym failed');
    fail(res, 'Failed to delete gym');
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
    const { type, name, phone, trainer_role, member_id: directMemberId, target_gym_id } = req.body;

    // Resolve target gym for multi-location support
    let inviteGymId = req.gym_id!;
    if (target_gym_id && target_gym_id !== req.gym_id) {
      const gymCheck = await pool.query(
        `SELECT id FROM gyms WHERE id = $1 AND owner_user_id = $2 AND is_deleted = false`,
        [target_gym_id, req.user.id]
      );
      if (!gymCheck.rows.length) return fail(res, 'You do not own this gym location');
      inviteGymId = target_gym_id;
    }
    if (!type || !['staff', 'member'].includes(type)) {
      return fail(res, 'type must be staff or member');
    }
    if (type === 'member' && !name) {
      return fail(res, 'name is required for member invites');
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
          [inviteGymId, name || '', displayId, role || 'staff']
        );
        trainerId = trainerRes.rows[0].id;
      } else {
        // For member invites: link to the actual member record.
        // Priority 1: direct member_id passed by the client (most accurate).
        if (directMemberId) {
          const check = await client.query(
            `SELECT id FROM members WHERE id = $1 AND gym_id = $2 AND is_deleted = false`,
            [directMemberId, inviteGymId]
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
            [inviteGymId, phone.trim()]
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
            [inviteGymId, name]
          );
          memberId = byName.rows[0]?.id;
        }
      }

      await client.query(
        `INSERT INTO invite_codes (gym_id, code, type, display_id, placeholder_name, placeholder_phone, trainer_role, trainer_id, member_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '7 days')`,
        [inviteGymId, code, type, displayId, name || null, phone || null, role || null, trainerId || null, memberId || null]
      );
    } finally {
      client.release();
    }

    ok(res, [{ code, display_id: displayId, type, trainer_role: role, expires_in_days: 7, placeholder_name: name || null }], 'Invite created');
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
      return fail(res, 'Invalid or expired invite code');
    }
    const invite = result.rows[0];
    ok(res, [{ code: invite.code, type: invite.type, display_id: invite.display_id, trainer_role: invite.trainer_role, gym_name: invite.gym_name, placeholder_name: invite.placeholder_name }], 'Invite found');
  } catch (error) {
    next(error);
  }
});

// Helper: upload base64 image to Firebase Storage, return public URL
async function uploadBase64Photo(base64: string, path: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const bucket = admin.storage().bucket('recurva-app.firebasestorage.app');
  const file = bucket.file(path);
  await file.save(buffer, { contentType: 'image/jpeg', public: true });
  return `https://storage.googleapis.com/recurva-app.firebasestorage.app/${path}`;
}

// POST /api/auth/staff/register — staff self-registration using invite code (public)
app.post('/api/auth/staff/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, name, email, phone, password, emailOtpKey, firebaseIdToken, photoBase64 } = req.body;
    if (!code || !name || !email || !phone || !password) {
      return fail(res, 'All fields are required');
    }
    if (password.length < 8) {
      return fail(res, 'Password must be at least 8 characters');
    }

    // Email OTP is required — must be pre-verified via /verify-email-otp
    if (!emailOtpKey) {
      return fail(res, 'Email verification is required. Please complete the OTP steps.');
    }
    const storedEmailOtp = memberRegOtps.get(emailOtpKey);
    if (!storedEmailOtp || storedEmailOtp.expires < Date.now() || storedEmailOtp.email.toLowerCase() !== email.toLowerCase() || storedEmailOtp.inviteCode !== code.toUpperCase()) {
      return fail(res, 'Invalid or expired email verification session');
    }
    if (!storedEmailOtp.verified) {
      return fail(res, 'Email has not been verified. Please complete email verification.');
    }
    memberRegOtps.delete(emailOtpKey);

    // Phone OTP via Firebase is required
    if (!firebaseIdToken) {
      return fail(res, 'Phone verification is required. Please complete the OTP steps.');
    }
    let firebaseVerifiedPhone = '';
    try {
      const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
      firebaseVerifiedPhone = decoded.phone_number || '';
      const normalizedInput = phone.replace(/\D/g, '').slice(-10);
      const normalizedVerified = firebaseVerifiedPhone.replace(/\D/g, '').slice(-10);
      if (!normalizedInput || !normalizedVerified || normalizedInput !== normalizedVerified) {
        return fail(res, 'Phone number does not match verified number');
      }
    } catch {
      return fail(res, 'Phone verification failed. Please retry.');
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
        return fail(res, 'Invalid or expired invite code');
      }
      const invite = inviteRes.rows[0];

      // Check email not already registered anywhere in the system (case-insensitive)
      const emailCheck = await client.query(
        `SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [email]
      );
      if (emailCheck.rows.length > 0) {
        return fail(res, 'This email is already registered in the system. Please use a different email.');
      }

      // Check phone not already registered anywhere in the system
      const phoneCheck = await client.query(
        `SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (phoneCheck.rows.length > 0) {
        return fail(res, 'This phone number is already registered in the system. Please use a different number.');
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, phone, password_hash, role, phone_verified)
         VALUES ($1, $2, $3, $4, 'trainer', TRUE) RETURNING id, gym_id, role`,
        [invite.gym_id, email, firebaseVerifiedPhone, passwordHash]
      );
      const user = userRes.rows[0];

      let linkedTrainerId: string | null = null;

      if (invite.trainer_id) {
        // Activate the pending trainer slot
        await client.query(
          `UPDATE trainers SET user_id = $1, name = $2, phone = $3, email = $4, is_active = true WHERE id = $5`,
          [user.id, name, phone, email, invite.trainer_id]
        );
        linkedTrainerId = invite.trainer_id;
      } else {
        // Create trainer from scratch (fallback)
        const displayId = invite.display_id || await generateDisplayId('staff');
        const newTrainer = await client.query(
          `INSERT INTO trainers (gym_id, user_id, name, phone, email, display_id, trainer_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [invite.gym_id, user.id, name, phone, email, displayId, invite.trainer_role || 'staff']
        );
        linkedTrainerId = newTrainer.rows[0]?.id || null;
      }

      // Mark invite used
      await client.query(`UPDATE invite_codes SET used_at = NOW() WHERE id = $1`, [invite.id]);

      await client.query('COMMIT');

      // Upload and save profile photo after successful commit (non-blocking)
      if (photoBase64 && linkedTrainerId && firebaseInitialized) {
        try {
          const photoUrl = await uploadBase64Photo(photoBase64, `profile-photos/staff/${invite.gym_id}_${Date.now()}.jpg`);
          await client.query(`UPDATE trainers SET profile_photo_url = $1 WHERE id = $2`, [photoUrl, linkedTrainerId]);
        } catch (err) {
          logger.warn({ err }, 'Staff photo upload failed — registration succeeded without photo');
        }
      }

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

      ok(res, [{ accessToken, refreshToken, user: { id: user.id, gym_id: user.gym_id, role: 'trainer', trainer_role: trainerRole } }], 'Registration complete');
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
    if (!code || !email) return fail(res, 'code and email are required');

    // Validate invite code — accept both member and staff types
    const inviteRes = await pool.query(
      `SELECT code FROM invite_codes WHERE code = $1 AND type IN ('member', 'staff') AND used_at IS NULL AND expires_at > NOW()`,
      [code.toUpperCase()]
    );
    if (inviteRes.rows.length === 0) {
      return fail(res, 'Invalid or expired invite code');
    }

    // Reject if email is already registered anywhere in the system
    const globalEmailCheck = await pool.query(
      `SELECT 1 FROM users WHERE phone_or_email = $1 AND is_deleted = false
       UNION ALL
       SELECT 1 FROM gyms WHERE email = $1 AND is_deleted = false
       UNION ALL
       SELECT 1 FROM members WHERE email = $1 AND is_deleted = false
       LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (globalEmailCheck.rows.length > 0) {
      return fail(res, 'This email is already registered. Please log in instead.');
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

    ok(res, [{ tempKey }], 'OTP sent to email');
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/member/verify-email-otp — pre-validate email OTP, marks it verified without registering (public)
app.post('/api/auth/member/verify-email-otp', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { tempKey, otp, email } = req.body;
    if (!tempKey || !otp || !email) {
      return fail(res, 'tempKey, otp, and email are required');
    }
    const stored = memberRegOtps.get(tempKey);
    if (!stored || stored.expires < Date.now() || stored.email.toLowerCase() !== email.toLowerCase()) {
      return fail(res, 'Verification session expired. Please resend the code.');
    }
    if (stored.code !== otp) {
      return fail(res, 'Incorrect verification code. Please check and try again.');
    }
    // Mark verified — keep entry so registration can confirm without re-checking the code
    memberRegOtps.set(tempKey, { ...stored, verified: true });
    ok(res, [], 'Email verified successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/member/register — member self-registration using invite code (public)
// Accepts emailOtpKey (pre-verified via /verify-email-otp) plus optional firebaseIdToken for phone.
app.post('/api/auth/member/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, name, email, phone, password, emailOtpKey, emailOtp, firebaseIdToken, photoBase64 } = req.body;
    if (!code || !name || !email || !phone || !password) {
      return fail(res, 'All fields are required');
    }
    if (password.length < 8) {
      return fail(res, 'Password must be at least 8 characters');
    }

    // Email OTP is required — must be pre-verified via /verify-email-otp
    if (!emailOtpKey) {
      return fail(res, 'Email verification is required. Please complete the OTP steps.');
    }
    let emailVerified = false;
    {
      const stored = memberRegOtps.get(emailOtpKey);
      if (!stored || stored.expires < Date.now() || stored.email.toLowerCase() !== email.toLowerCase() || stored.inviteCode !== code.toUpperCase()) {
        return fail(res, 'Invalid or expired email verification session');
      }
      if (stored.verified) {
        emailVerified = true;
      } else if (emailOtp && stored.code === emailOtp) {
        emailVerified = true;
      } else if (emailOtp) {
        return fail(res, 'Incorrect email verification code');
      }
      memberRegOtps.delete(emailOtpKey);
    }
    if (!emailVerified) {
      return fail(res, 'Email has not been verified. Please complete email verification.');
    }

    // Phone OTP via Firebase is required
    if (!firebaseIdToken) {
      return fail(res, 'Phone verification is required. Please complete the OTP steps.');
    }
    let phoneVerified = false;
    let firebaseVerifiedMemberPhone = '';
    try {
      const decoded = await admin.auth().verifyIdToken(firebaseIdToken);
      firebaseVerifiedMemberPhone = decoded.phone_number || '';
      const normalizedInput = phone.replace(/\D/g, '').slice(-10);
      const normalizedVerified = firebaseVerifiedMemberPhone.replace(/\D/g, '').slice(-10);
      if (normalizedInput && normalizedVerified && normalizedInput === normalizedVerified) {
        phoneVerified = true;
      }
    } catch {
      return fail(res, 'Phone verification failed. Please retry.');
    }
    if (!phoneVerified) {
      return fail(res, 'Phone number does not match the verified number');
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
        return fail(res, 'Invalid or expired invite code');
      }
      const invite = inviteRes.rows[0];

      // Check email not already registered anywhere in the system (case-insensitive)
      const emailCheck = await client.query(
        `SELECT 1 FROM users    WHERE LOWER(phone_or_email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM members  WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE LOWER(email) = LOWER($1) AND is_deleted = false
         LIMIT 1`,
        [email]
      );
      if (emailCheck.rows.length > 0) {
        return fail(res, 'This email is already registered. Please log in instead.');
      }

      // Check phone not already registered anywhere in the system
      const phoneCheck = await client.query(
        `SELECT 1 FROM members  WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM trainers WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM gyms     WHERE RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         UNION ALL
         SELECT 1 FROM users    WHERE phone IS NOT NULL AND RIGHT(phone, 10) = RIGHT($1, 10) AND is_deleted = false
         LIMIT 1`,
        [phone]
      );
      if (phoneCheck.rows.length > 0) {
        return fail(res, 'This phone number is already registered in the system. Please use a different number.');
      }

      await client.query('BEGIN');

      const passwordHash = await bcrypt.hash(password, 10);
      const userRes = await client.query(
        `INSERT INTO users (gym_id, phone_or_email, phone, password_hash, role, phone_verified)
         VALUES ($1, $2, $3, $4, 'member', TRUE) RETURNING id, gym_id, role`,
        [invite.gym_id, email, firebaseVerifiedMemberPhone, passwordHash]
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

      // Upload and save profile photo (non-blocking; failure does not roll back registration)
      if (photoBase64 && linkedMemberId && firebaseInitialized) {
        try {
          const photoUrl = await uploadBase64Photo(photoBase64, `profile-photos/members/${invite.gym_id}_${Date.now()}.jpg`);
          await client.query(`UPDATE members SET profile_photo_url = $1 WHERE id = $2`, [photoUrl, linkedMemberId]);
        } catch (err) {
          logger.warn({ err }, 'Member photo upload failed — registration succeeded without photo');
        }
      }

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

      ok(res, [{ accessToken, refreshToken, user: { id: user.id, gym_id: user.gym_id, role: 'member', member_id: linkedMemberId } }], 'Registration complete');
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
      return fail(res, 'trainer_role must be staff or admin');
    }
    const result = await pool.query(
      `UPDATE trainers SET trainer_role = $1 WHERE id = $2 AND gym_id = $3 AND is_deleted = false RETURNING id`,
      [trainer_role, id, req.gym_id]
    );
    if (result.rows.length === 0) {
      return fail(res, 'Trainer not found');
    }
    ok(res, [{ id, trainer_role }], 'Role updated');
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
    ok(res, result.rows, 'Fetched successfully');
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
  fail(res, 'Not Found');
});

// ── Process-level safeguards — prevent cold crash on unhandled rejections ─────
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection — not crashing');
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  // In Cloud Run, let the process die — the platform restarts it immediately.
  // Without this, an uncaught exception leaves the process in a broken state.
  if (process.env.K_SERVICE) process.exit(1);
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
