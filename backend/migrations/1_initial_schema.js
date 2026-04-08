/**
 * Migration 001 — Initial Schema
 *
 * Wraps the existing schema.sql as a migration baseline.
 * Uses IF NOT EXISTS throughout so it is safe to run against a DB
 * that was bootstrapped directly from schema.sql.
 */

/* eslint-disable camelcase */
/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS gyms (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL,
      owner_name VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      address TEXT,
      subscription_status VARCHAR(50) NOT NULL DEFAULT 'trial',
      trial_started_at TIMESTAMP DEFAULT NOW(),
      trial_ends_at TIMESTAMP,
      subscription_started_at TIMESTAMP,
      subscription_ends_at TIMESTAMP,
      member_count INTEGER DEFAULT 0,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      phone_or_email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      linked_trainer_id UUID,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(gym_id, phone_or_email)
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS trainers (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(255) NOT NULL,
      assigned_members_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS members (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      email VARCHAR(255) NOT NULL,
      last_visit_date TIMESTAMP,
      membership_expiry_date TIMESTAMP NOT NULL,
      plan_fee NUMERIC(10, 2) NOT NULL,
      assigned_trainer_id UUID REFERENCES trainers(id),
      status VARCHAR(50) DEFAULT 'active',
      unique_id VARCHAR(50) UNIQUE,
      onboarding_status VARCHAR(50) DEFAULT 'pending',
      is_deleted BOOLEAN DEFAULT FALSE,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(gym_id, phone),
      UNIQUE(gym_id, email)
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS follow_up_tasks (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      assigned_trainer_id UUID REFERENCES trainers(id),
      task_type VARCHAR(50) NOT NULL,
      status VARCHAR(50) DEFAULT 'pending',
      outcome VARCHAR(50),
      notes TEXT,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      visit_date DATE NOT NULL,
      check_in_time TIME,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS revenue_records (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      task_id UUID REFERENCES follow_up_tasks(id),
      action VARCHAR(50) NOT NULL,
      revenue_recovered NUMERIC(10, 2) NOT NULL,
      tracked_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id),
      entity_type VARCHAR(50) NOT NULL,
      entity_id UUID NOT NULL,
      action VARCHAR(50) NOT NULL,
      old_values JSONB,
      new_values JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS subscription_billing (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      billing_period_start DATE NOT NULL,
      billing_period_end DATE NOT NULL,
      subscription_fee NUMERIC(10, 2) NOT NULL,
      member_count_at_billing INTEGER,
      payment_status VARCHAR(50) DEFAULT 'pending',
      payment_method VARCHAR(50),
      payment_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS trial_conversion_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      trial_started_at TIMESTAMP NOT NULL,
      trial_ended_at TIMESTAMP NOT NULL,
      conversion_date TIMESTAMP,
      conversion_status VARCHAR(50),
      subscription_months_purchased INTEGER,
      total_members_during_trial INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Indexes (IF NOT EXISTS available in PG 9.5+)
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gyms_subscription_status ON gyms(subscription_status)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gyms_trial_ends_at ON gyms(trial_ends_at)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gyms_email ON gyms(email)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_users_gym_id ON users(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_users_phone_email ON users(phone_or_email)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_trainers_gym_id ON trainers(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_trainers_user_id ON trainers(user_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_members_gym_id ON members(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_members_status ON members(status)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_members_expiry ON members(membership_expiry_date)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_members_last_visit ON members(last_visit_date)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_tasks_gym_id ON follow_up_tasks(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_tasks_member_id ON follow_up_tasks(member_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON follow_up_tasks(status)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_attendance_gym_id ON attendance_logs(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_attendance_member_id ON attendance_logs(member_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_attendance_visit_date ON attendance_logs(visit_date)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_revenue_gym_id ON revenue_records(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_revenue_tracked_at ON revenue_records(tracked_at)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_audit_gym_id ON audit_logs(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reset_tokens_user_id ON password_reset_tokens(user_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_billing_gym_id ON subscription_billing(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_conversion_gym_id ON trial_conversion_log(gym_id)`);

  // updated_at trigger function
  pgm.sql(`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  const triggerTables = [
    'gyms', 'users', 'members', 'follow_up_tasks', 'trainers',
    'attendance_logs', 'revenue_records', 'audit_logs',
    'subscription_billing', 'trial_conversion_log',
  ];
  for (const table of triggerTables) {
    pgm.sql(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'update_${table}_updated_at'
        ) THEN
          CREATE TRIGGER update_${table}_updated_at
            BEFORE UPDATE ON ${table}
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$
    `);
  }
};

exports.down = (pgm) => {
  // Drop in reverse dependency order
  const tables = [
    'trial_conversion_log', 'subscription_billing', 'audit_logs',
    'password_reset_tokens', 'revenue_records', 'attendance_logs',
    'follow_up_tasks', 'members', 'trainers', 'users', 'gyms',
  ];
  for (const table of tables) {
    pgm.sql(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
};
