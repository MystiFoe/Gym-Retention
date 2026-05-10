/**
 * Profile & Gym Settings API Tests
 * GET  /api/profile
 * PUT  /api/profile
 * PUT  /api/gyms/me
 * POST /api/profile/verify-phone
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
import jwt     from 'jsonwebtoken';

const JWT_SECRET    = process.env.JWT_SECRET!;
const GYM_ID        = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID       = 'bbbbbbbb-0000-0000-0000-000000000002';
const TRAINER_UID   = 'cccccccc-0000-0000-0000-000000000003';

const OWNER_TOKEN   = jwt.sign({ id: USER_ID,     gym_id: GYM_ID, role: 'owner'   }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jwt.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN  = jwt.sign({ id: 'mem-uid',   gym_id: GYM_ID, role: 'member'  }, JWT_SECRET, { expiresIn: '1h' });

const MOCK_OWNER_PROFILE = {
  id: USER_ID,
  phone_or_email: 'owner@gym.com',
  phone: '+919876543210',
  phone_verified: true,
  name: 'Gym Owner',
  gym_id: GYM_ID,
  gym_name: 'Test Gym',
  gym_address: '123 Main St',
  gym_phone: '9876543210',
  gym_email: 'gym@test.com',
  gym_razorpay_configured: false,
  gym_razorpay_key_hint: null,
};

const MOCK_TRAINER_PROFILE = {
  id: TRAINER_UID,
  phone_or_email: 'trainer@gym.com',
  phone_verified: false,
  name: 'Test Trainer',
  phone: '9000000001',
  email: 'trainer@gym.com',
  trainer_id: 'dddddddd-0000-0000-0000-000000000004',
};

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

// ══════════════════════════════════════════════════════════════════════
// GET /api/profile
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/profile', () => {

  it('200: returns owner profile with gym info', async () => {
    q(
      [{ is_blocked: false }],
      [MOCK_OWNER_PROFILE],
    );

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.role).toBe('owner');
    expect(res.body.data.gym.name).toBe('Test Gym');
    expect(res.body.data.email).toBe('owner@gym.com');
  });

  it('200: returns trainer profile', async () => {
    q(
      [{ is_blocked: false }],
      [MOCK_TRAINER_PROFILE],
    );

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.role).toBe('trainer');
    expect(res.body.data.name).toBe('Test Trainer');
  });

  it('404: profile not found returns 404 for owner', async () => {
    q(
      [{ is_blocked: false }],
      [],   // query returns no rows
    );

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('404: profile not found returns 404 for trainer', async () => {
    q(
      [{ is_blocked: false }],
      [],
    );

    const res = await request(app)
      .get('/api/profile')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);

    expect(res.status).toBe(404);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PUT /api/profile
// ══════════════════════════════════════════════════════════════════════

describe('PUT /api/profile', () => {

  it('200: owner updates name only', async () => {
    q(
      [{ is_blocked: false }],
      // UPDATE gyms SET owner_name (default)
    );

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ name: 'New Owner Name' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toMatch(/updated/i);
  });

  it('200: trainer updates name and phone', async () => {
    q(
      [{ is_blocked: false }],
      // UPDATE trainers (default)
      // UPDATE users phone (default)
    );

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ name: 'Updated Trainer', phone: '9111222333' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('200: owner updates email (unique check passes)', async () => {
    q(
      [{ is_blocked: false }],
      // UPDATE gyms owner_name (default)
      [],              // email uniqueness check → no conflict
      // UPDATE users phone_or_email (default)
      // UPDATE gyms email (default)
    );

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ name: 'Owner', email: 'newemail@gym.com' });

    expect(res.status).toBe(200);
  });

  it('409: email already in use by another account', async () => {
    q(
      [{ is_blocked: false }],
      [],                          // UPDATE gyms SET owner_name (always runs first)
      [{ id: 'other-user-id' }],  // email uniqueness check → conflict
    );

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ name: 'Owner', email: 'taken@gym.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in use/i);
  });

  it('400: name too short returns 400', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ name: 'A' });   // min 2 chars

    expect(res.status).toBe(400);
  });

  it('400: password change without currentPassword returns 400', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .put('/api/profile')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ name: 'Owner', newPassword: 'NewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password/i);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app)
      .put('/api/profile')
      .send({ name: 'Owner' });
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PUT /api/gyms/me
// ══════════════════════════════════════════════════════════════════════

describe('PUT /api/gyms/me', () => {

  it('200: owner updates gym name and address', async () => {
    q(
      [{ is_blocked: false }],
      // UPDATE gyms (client.query, default)
    );

    const res = await request(app)
      .put('/api/gyms/me')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ gymName: 'Updated Gym Name', address: '456 New Street' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.message).toMatch(/updated/i);
  });

  it('200: owner updates gym with Razorpay keys', async () => {
    q(
      [{ is_blocked: false }],
    );

    const res = await request(app)
      .put('/api/gyms/me')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({
        gymName: 'My Gym',
        razorpay_key_id: 'rzp_test_abc123',
        razorpay_key_secret: 'secret_xyz',
      });

    expect(res.status).toBe(200);
  });

  it('400: gymName is required', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .put('/api/gyms/me')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ address: '123 Street' });

    expect(res.status).toBe(400);
  });

  it('400: gymName too short (min 2 chars)', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .put('/api/gyms/me')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ gymName: 'X' });

    expect(res.status).toBe(400);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app)
      .put('/api/gyms/me')
      .send({ gymName: 'My Gym' });
    expect(res.status).toBe(401);
  });

  it('403: trainer cannot update gym settings', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .put('/api/gyms/me')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ gymName: 'My Gym' });

    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/profile/verify-phone
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/profile/verify-phone', () => {

  it('503: returns 503 when Firebase is not configured', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .post('/api/profile/verify-phone')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ firebase_id_token: 'some-token' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/firebase/i);
  });

  it('400: missing firebase_id_token returns 503 (Firebase check first)', async () => {
    q([{ is_blocked: false }]);

    const res = await request(app)
      .post('/api/profile/verify-phone')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({});

    // Firebase not initialized → 503 before field validation
    expect(res.status).toBe(503);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app)
      .post('/api/profile/verify-phone')
      .send({ firebase_id_token: 'some-token' });
    expect(res.status).toBe(401);
  });
});
