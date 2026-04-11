/**
 * Migration 3: OTP codes table + email_verified column on users
 *
 * otp_codes  — stores single-use 6-digit codes for email verification
 * users      — gets email_verified flag (false by default for new rows;
 *              existing rows marked true so they don't get locked out)
 */
exports.up = (pgm) => {
  pgm.createTable(
    'otp_codes',
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        default: pgm.func('uuid_generate_v4()'),
      },
      email: { type: 'varchar(255)', notNull: true },
      code: { type: 'varchar(6)', notNull: true },
      expires_at: { type: 'timestamp', notNull: true },
      used_at: { type: 'timestamp' },
      created_at: { type: 'timestamp', default: pgm.func('NOW()') },
    },
    { ifNotExists: true }
  );

  // One active OTP per email at a time
  pgm.addConstraint('otp_codes', 'otp_codes_email_unique', 'UNIQUE(email)');

  pgm.createIndex('otp_codes', 'email', { ifNotExists: true });
  pgm.createIndex('otp_codes', 'expires_at', { ifNotExists: true });

  // Add email_verified to users — default true for all existing rows so
  // current gym owners aren't blocked from logging in.
  pgm.addColumns('users', {
    email_verified: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable('otp_codes', { ifExists: true });
  pgm.dropColumns('users', ['email_verified'], { ifExists: true });
};
