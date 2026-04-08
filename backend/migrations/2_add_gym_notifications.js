/**
 * Migration 002 — Add gym_notifications table
 *
 * Tracks which notification emails have already been sent per gym per day.
 * The UNIQUE constraint on (gym_id, notification_type, sent_date) means:
 *  - A server restart won't re-send the same email on the same day
 *  - The same gym can receive the same notification type in a future cycle
 *    (e.g. a new subscription expiry) on a different date
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS gym_notifications (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      notification_type VARCHAR(100) NOT NULL,
      sent_date DATE NOT NULL DEFAULT CURRENT_DATE,
      sent_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(gym_id, notification_type, sent_date)
    )
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gym_notifications_gym_id ON gym_notifications(gym_id)`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_gym_notifications_type_date ON gym_notifications(notification_type, sent_date)`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS gym_notifications`);
};
