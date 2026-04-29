-- ============================================================================
-- GYM RETENTION - PRODUCTION DATABASE SCHEMA
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- GYMS TABLE (Multi-gym support)
-- ============================================================================
CREATE TABLE IF NOT EXISTS gyms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  owner_name VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  address TEXT,
  subscription_status VARCHAR(50) NOT NULL DEFAULT 'trial', -- trial, active, expired, cancelled
  trial_started_at TIMESTAMP DEFAULT NOW(),
  trial_ends_at TIMESTAMP,
  subscription_started_at TIMESTAMP,
  subscription_ends_at TIMESTAMP,
  member_count INTEGER DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_gyms_subscription_status ON gyms(subscription_status);
CREATE INDEX idx_gyms_trial_ends_at ON gyms(trial_ends_at);
CREATE INDEX idx_gyms_email ON gyms(email);

-- ============================================================================
-- USERS TABLE (Owner, Trainer, Member)
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  phone_or_email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- owner, trainer, member
  linked_trainer_id UUID,
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(gym_id, phone_or_email)
);

CREATE INDEX idx_users_gym_id ON users(gym_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_phone_email ON users(phone_or_email);

-- ============================================================================
-- TRAINERS TABLE
-- ============================================================================
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
);

CREATE INDEX idx_trainers_gym_id ON trainers(gym_id);
CREATE INDEX idx_trainers_user_id ON trainers(user_id);

-- ============================================================================
-- MEMBERS TABLE (Core data)
-- ============================================================================
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
  status VARCHAR(50) DEFAULT 'active', -- active, at_risk, high_risk, expiring
  unique_id VARCHAR(50) UNIQUE,
  onboarding_status VARCHAR(50) DEFAULT 'pending', -- pending, in_progress, completed
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(gym_id, phone),
  UNIQUE(gym_id, email)
);

CREATE INDEX idx_members_gym_id ON members(gym_id);
CREATE INDEX idx_members_status ON members(status);
CREATE INDEX idx_members_expiry ON members(membership_expiry_date);
CREATE INDEX idx_members_last_visit ON members(last_visit_date);
CREATE INDEX idx_members_unique_id ON members(unique_id);

-- ============================================================================
-- FOLLOW-UP TASKS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  assigned_trainer_id UUID REFERENCES trainers(id),
  task_type VARCHAR(50) NOT NULL, -- call, renewal, check_in
  status VARCHAR(50) DEFAULT 'pending', -- pending, in_progress, completed
  outcome VARCHAR(50), -- called, not_reachable, coming_tomorrow, renewed, no_action
  notes TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_tasks_gym_id ON follow_up_tasks(gym_id);
CREATE INDEX idx_tasks_member_id ON follow_up_tasks(member_id);
CREATE INDEX idx_tasks_status ON follow_up_tasks(status);
CREATE INDEX idx_tasks_created_at ON follow_up_tasks(created_at);

-- ============================================================================
-- ATTENDANCE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS attendance_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  check_in_time TIME,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_attendance_gym_id ON attendance_logs(gym_id);
CREATE INDEX idx_attendance_member_id ON attendance_logs(member_id);
CREATE INDEX idx_attendance_visit_date ON attendance_logs(visit_date);

-- ============================================================================
-- REVENUE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS revenue_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  task_id UUID REFERENCES follow_up_tasks(id),
  action VARCHAR(50) NOT NULL, -- renewal, new_member, upgrade
  revenue_recovered NUMERIC(10, 2) NOT NULL,
  tracked_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_revenue_gym_id ON revenue_records(gym_id);
CREATE INDEX idx_revenue_tracked_at ON revenue_records(tracked_at);

-- ============================================================================
-- AUDIT LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL, -- create, update, delete
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_gym_id ON audit_logs(gym_id);
CREATE INDEX idx_audit_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_created_at ON audit_logs(created_at);

-- ============================================================================
-- SUBSCRIPTION BILLING TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscription_billing (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  subscription_fee NUMERIC(10, 2) NOT NULL,
  member_count_at_billing INTEGER,
  payment_status VARCHAR(50) DEFAULT 'pending', -- pending, completed, failed
  payment_method VARCHAR(50),
  payment_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_billing_gym_id ON subscription_billing(gym_id);
CREATE INDEX idx_billing_period ON subscription_billing(billing_period_start, billing_period_end);

-- ============================================================================
-- PASSWORD RESET TOKENS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX idx_reset_tokens_user_id ON password_reset_tokens(user_id);

-- ============================================================================
-- GYM NOTIFICATIONS TABLE
-- Tracks sent emails to prevent duplicates across server restarts
-- ============================================================================
CREATE TABLE IF NOT EXISTS gym_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  notification_type VARCHAR(100) NOT NULL,   -- e.g. trial_expiry_7day, trial_expiry_3day
  sent_date DATE NOT NULL DEFAULT CURRENT_DATE,
  sent_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(gym_id, notification_type, sent_date)
);

CREATE INDEX idx_gym_notifications_gym_id ON gym_notifications(gym_id);
CREATE INDEX idx_gym_notifications_type_date ON gym_notifications(notification_type, sent_date);

-- ============================================================================
-- TRIAL CONVERSION LOG TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS trial_conversion_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  trial_started_at TIMESTAMP NOT NULL,
  trial_ended_at TIMESTAMP NOT NULL,
  conversion_date TIMESTAMP,
  conversion_status VARCHAR(50), -- converted, expired
  subscription_months_purchased INTEGER,
  total_members_during_trial INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_conversion_gym_id ON trial_conversion_log(gym_id);
CREATE INDEX idx_conversion_status ON trial_conversion_log(conversion_status);

-- ============================================================================
-- OTP CODES TABLE
-- Stores single-use 6-digit codes for email verification after registration
-- ============================================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_otp_codes_email ON otp_codes(email);
CREATE INDEX idx_otp_codes_expires_at ON otp_codes(expires_at);

-- email_verified column on users (true by default for existing rows)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;

-- ============================================================================
-- VIEWS FOR ANALYTICS
-- ============================================================================

-- Active gyms view
CREATE OR REPLACE VIEW active_gyms AS
SELECT * FROM gyms
WHERE is_deleted = FALSE
  AND subscription_status IN ('trial', 'active');

-- Trials expiring soon view
CREATE OR REPLACE VIEW trials_expiring_soon AS
SELECT * FROM gyms
WHERE subscription_status = 'trial'
  AND trial_ends_at IS NOT NULL
  AND trial_ends_at <= NOW() + INTERVAL '7 days'
  AND is_deleted = FALSE;

-- Expired subscriptions view
CREATE OR REPLACE VIEW expired_subscriptions AS
SELECT * FROM gyms
WHERE subscription_status = 'expired'
  AND subscription_ends_at IS NOT NULL
  AND subscription_ends_at <= NOW()
  AND is_deleted = FALSE;

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_gyms_updated_at BEFORE UPDATE ON gyms
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_follow_up_tasks_updated_at BEFORE UPDATE ON follow_up_tasks
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trainers_updated_at BEFORE UPDATE ON trainers
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_attendance_logs_updated_at BEFORE UPDATE ON attendance_logs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_revenue_records_updated_at BEFORE UPDATE ON revenue_records
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_audit_logs_updated_at BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscription_billing_updated_at BEFORE UPDATE ON subscription_billing
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trial_conversion_log_updated_at BEFORE UPDATE ON trial_conversion_log
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- INITIAL DATA (Optional - For testing)
-- ============================================================================

-- Insert a test gym
-- INSERT INTO gyms (name, owner_name, phone, email, address)
-- VALUES ('Test Gym', 'Test Owner', '9876543210', 'test@gym.com', '123 Main St');

-- ============================================================================
-- PERMISSIONS
-- ============================================================================

-- Create app user (non-root)
DO $$
BEGIN
  CREATE USER gym_user WITH PASSWORD 'change_me_in_production';
EXCEPTION
  WHEN DUPLICATE_OBJECT THEN
    ALTER USER gym_user WITH PASSWORD 'change_me_in_production';
END
$$;

-- Grant permissions
GRANT CONNECT ON DATABASE gym_retention TO gym_user;
GRANT USAGE ON SCHEMA public TO gym_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO gym_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO gym_user;

-- ============================================================================
-- PHONE COLUMN ON USERS (for phone-based login & Firebase OTP)
-- Stores the verified E.164 phone number set during registration.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- phone_verified: true once the user has completed Firebase Phone OTP verification
-- Owners verified during registration; staff start as false (unverified) until they verify.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;
-- Existing owners who completed registration already verified their phone
UPDATE users SET phone_verified = true WHERE role = 'owner' AND phone IS NOT NULL AND phone != '';

-- ============================================================================
-- PENDING REGISTRATIONS TABLE
-- Holds unverified registration data until both email AND phone are confirmed.
-- Rows are deleted on successful completion or when expires_at is reached.
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_registrations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gym_name        VARCHAR(255) NOT NULL,
  owner_name      VARCHAR(255) NOT NULL,
  gym_phone       VARCHAR(20)  NOT NULL,
  gym_email       VARCHAR(255) NOT NULL,
  address         TEXT,
  owner_email     VARCHAR(255) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  email_otp_code      VARCHAR(6),
  email_otp_expires_at TIMESTAMP,
  email_verified  BOOLEAN  DEFAULT FALSE,
  expires_at      TIMESTAMP NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE(owner_email)
);

CREATE INDEX IF NOT EXISTS idx_pending_reg_owner_email ON pending_registrations(owner_email);
CREATE INDEX IF NOT EXISTS idx_pending_reg_expires_at  ON pending_registrations(expires_at);

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
