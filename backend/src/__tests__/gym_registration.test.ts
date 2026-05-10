/**
 * Gym Registration Flow API Tests
 * POST /api/gyms/register              — Step 1: initiate, send email OTP
 * POST /api/gyms/register/verify-email — Step 2: verify email OTP
 * POST /api/gyms/register/resend-email-otp — Step 2b: resend OTP
 * POST /api/gyms/register/verify-phone — Step 3: Firebase verify (returns 503 in test)
 * GET  /api/health                     — health check
 */

process.env.DATABASE_URL       = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET         = 'test_jwt_secret_must_be_at_least_32_chars_ok';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_must_be_32_chars_ok!!';
process.env.CORS_ORIGIN        = '*';
process.env.NODE_ENV           = 'test';
process.env.PORT               = '0';

jest.mock('@sentry/node', () => ({
  init: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn(),
}));

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
    query:   mockQuery,
    end:     jest.fn(),
    on:      jest.fn(),
  })),
}));

jest.mock('bcrypt', () => ({
  hash:    jest.fn().mockResolvedValue('$hashed'),
  compare: jest.fn().mockResolvedValue(true),
}));
jest.mock('node-cron',  () => ({ schedule: jest.fn() }));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: jest.fn().mockResolvedValue({}) }),
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({})));
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  auth: jest.fn().mockReturnValue({ verifyIdToken: jest.fn() }),
  messaging: jest.fn().mockReturnValue({ send: jest.fn().mockResolvedValue('') }),
}));
jest.mock('prom-client', () => ({
  collectDefaultMetrics: jest.fn(),
  register: { contentType: 'text/plain', metrics: jest.fn().mockResolvedValue(''), registerMetric: jest.fn(), clear: jest.fn() },
  Registry:  jest.fn().mockImplementation(() => ({ registerMetric: jest.fn(), contentType: 'text/plain', metrics: jest.fn().mockResolvedValue(''), clear: jest.fn() })),
  Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
  Counter:   jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
  Gauge:     jest.fn().mockImplementation(() => ({ set: jest.fn(), inc: jest.fn() })),
}));

import request from 'supertest';

const PENDING_ID = 'pending-id-00000001';

// Future timestamps for OTP/session expiry
const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

let app: any;

beforeAll(() => { app = require('../server').default; });

afterEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function q(...rowSets: Array<any[] | { rows: any[]; rowCount?: number }>) {
  for (const item of rowSets) {
    const rows     = Array.isArray(item) ? item : item.rows;
    const rowCount = Array.isArray(item) ? item.length : (item.rowCount ?? item.rows.length);
    mockQuery.mockResolvedValueOnce({ rows, rowCount });
  }
}

const VALID_REGISTER_BODY = {
  gym_name:       'Test Fitness Club',
  owner_name:     'Test Owner',
  phone:          '9876543210',
  email:          'gymtest@example.com',
  address:        '123 Test Street',
  owner_password: 'SecurePass@123',
  owner_email:    'owner@gymtest.com',
};

// ══════════════════════════════════════════════════════════════════════
// GET /api/health
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/health', () => {

  it('200: returns health status', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('3.0.0');
    expect(res.body.timestamp).toBeDefined();
    expect(typeof res.body.uptime).toBe('number');
  });

  it('200: /health also works (non-api path)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/gyms/register — Step 1
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/gyms/register', () => {

  it('200: initiates registration and returns pendingId', async () => {
    q(
      [],                         // gym email check → not taken
      [],                         // owner email check → not taken
      [{ id: PENDING_ID }],       // INSERT pending_registrations
    );

    const res = await request(app)
      .post('/api/gyms/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pendingId).toBe(PENDING_ID);
    expect(res.body.data.ownerEmail).toBe('owner@gymtest.com');
  });

  it('409: gym email already registered returns 409', async () => {
    q(
      [{ id: 'existing-gym' }],  // gym email check → taken
    );

    const res = await request(app)
      .post('/api/gyms/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('409: owner email already registered returns 409', async () => {
    q(
      [],                        // gym email check → not taken
      [{ id: 'existing-user' }], // owner email check → taken
    );

    const res = await request(app)
      .post('/api/gyms/register')
      .send(VALID_REGISTER_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('400: missing required fields returns 400', async () => {
    const res = await request(app)
      .post('/api/gyms/register')
      .send({ gym_name: 'Test Gym' });

    expect(res.status).toBe(400);
  });

  it('400: invalid owner_email format returns 400', async () => {
    const res = await request(app)
      .post('/api/gyms/register')
      .send({ ...VALID_REGISTER_BODY, owner_email: 'not-an-email' });

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/gyms/register/verify-email — Step 2
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/gyms/register/verify-email', () => {

  it('200: verifies correct OTP and returns pendingId', async () => {
    q(
      [{
        id: PENDING_ID,
        gym_phone: '9876543210',
        owner_email: 'owner@gymtest.com',
        email_verified: false,
        email_otp_code: '123456',
        email_otp_expires_at: FUTURE,
        expires_at: FUTURE,
      }],
      // UPDATE email_verified (default)
    );

    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ pending_id: PENDING_ID, otp_code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.pendingId).toBe(PENDING_ID);
    expect(res.body.data.gymPhone).toBe('9876543210');
  });

  it('200: idempotent — already-verified session returns 200', async () => {
    q(
      [{
        id: PENDING_ID,
        gym_phone: '9876543210',
        owner_email: 'owner@gymtest.com',
        email_verified: true,    // already verified
        email_otp_code: '123456',
        email_otp_expires_at: FUTURE,
        expires_at: FUTURE,
      }],
    );

    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ pending_id: PENDING_ID, otp_code: '123456' });

    expect(res.status).toBe(200);
  });

  it('400: wrong OTP returns 400', async () => {
    q(
      [{
        id: PENDING_ID,
        gym_phone: '9876543210',
        owner_email: 'owner@gymtest.com',
        email_verified: false,
        email_otp_code: '999999',    // stored code is different
        email_otp_expires_at: FUTURE,
        expires_at: FUTURE,
      }],
    );

    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ pending_id: PENDING_ID, otp_code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incorrect/i);
  });

  it('400: expired OTP returns 400', async () => {
    const PAST = new Date(Date.now() - 1000).toISOString();
    q(
      [{
        id: PENDING_ID,
        gym_phone: '9876543210',
        owner_email: 'owner@gymtest.com',
        email_verified: false,
        email_otp_code: '123456',
        email_otp_expires_at: PAST,   // expired
        expires_at: FUTURE,
      }],
    );

    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ pending_id: PENDING_ID, otp_code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('404: session not found returns 404', async () => {
    q([]);  // no pending registration found

    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ pending_id: 'non-existent-id', otp_code: '123456' });

    expect(res.status).toBe(404);
  });

  it('400: missing pending_id or otp_code returns 400', async () => {
    const res = await request(app)
      .post('/api/gyms/register/verify-email')
      .send({ otp_code: '123456' });

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/gyms/register/resend-email-otp — Step 2b
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/gyms/register/resend-email-otp', () => {

  it('200: resends OTP to email', async () => {
    q(
      [{ id: PENDING_ID, owner_email: 'owner@gymtest.com', expires_at: FUTURE }],
      // UPDATE otp code (default)
    );

    const res = await request(app)
      .post('/api/gyms/register/resend-email-otp')
      .send({ pending_id: PENDING_ID });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('404: session not found returns 404', async () => {
    q([]);  // no pending registration

    const res = await request(app)
      .post('/api/gyms/register/resend-email-otp')
      .send({ pending_id: 'non-existent' });

    expect(res.status).toBe(404);
  });

  it('400: missing pending_id returns 400', async () => {
    const res = await request(app)
      .post('/api/gyms/register/resend-email-otp')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/gyms/register/verify-phone — Step 3
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/gyms/register/verify-phone', () => {

  it('503: returns 503 when Firebase is not configured', async () => {
    const res = await request(app)
      .post('/api/gyms/register/verify-phone')
      .send({ pending_id: PENDING_ID, firebase_id_token: 'some-token' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/firebase/i);
  });

  it('400: missing required fields returns 503 (Firebase check first)', async () => {
    // Firebase check happens before field validation, so 503 is returned
    const res = await request(app)
      .post('/api/gyms/register/verify-phone')
      .send({});

    expect(res.status).toBe(503);
  });
});
