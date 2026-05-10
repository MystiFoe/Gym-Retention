-- ============================================================================
-- MIGRATION: Add gym blocking support
-- Run this once in Supabase SQL Editor
-- ============================================================================

ALTER TABLE gyms ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMP;
ALTER TABLE gyms ADD COLUMN IF NOT EXISTS blocked_reason TEXT;

-- Optional index for fast filtered queries
CREATE INDEX IF NOT EXISTS idx_gyms_is_blocked ON gyms(is_blocked) WHERE is_blocked = TRUE;
