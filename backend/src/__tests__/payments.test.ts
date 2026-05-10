/**
 * Payments API Tests
 * GET  /api/payments            (owner)
 * GET  /api/payments/report     (owner CSV)
 * POST /api/payments/create-order (member)
 * POST /api/payments/verify       (member)
 */

process.env.DATABASE_URL       = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET         = 'test_jwt_secret_must_be_at_least_32_chars_ok';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_must_be_32_chars_ok!!';
process.env.CORS_ORIGIN        = '*';
process.env.NODE_ENV           = 'test';
process.env.PORT               = '0';
process.env.RAZORPAY_KEY_SECRET = 'test_razorpay_secret';

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

// Mock global fetch (used by razorpayRequest helper)
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import request from 'supertest';
import jwt     from 'jsonwebtoken';
import crypto  from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET!;
const GYM_ID     = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEMBER_ID  = 'cccccccc-0000-0000-0000-000000000003';
const PAYMENT_ID = 'dddddddd-0000-0000-0000-000000000004';

const OWNER_TOKEN   = jwt.sign({ id: USER_ID,   gym_id: GYM_ID, role: 'owner'   }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jwt.sign({ id: 'tr-uid',  gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN  = jwt.sign({ id: 'mem-uid', member_id: MEMBER_ID, gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '30d' });

const MOCK_PAYMENT_ROW = {
  id: PAYMENT_ID, amount: 150000, currency: 'INR', status: 'completed',
  payment_method: 'razorpay', description: 'Monthly fee',
  created_at: '2026-05-01T00:00:00Z',
  member_name: 'Alice', member_phone: '9876543210',
};

let app: any;

beforeAll(() => { app = require('../server').default; });

afterEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockFetch.mockReset();
});

function q(...rowSets: Array<any[] | { rows: any[]; rowCount?: number }>) {
  for (const item of rowSets) {
    const rows     = Array.isArray(item) ? item : item.rows;
    const rowCount = Array.isArray(item) ? item.length : (item.rowCount ?? item.rows.length);
    mockQuery.mockResolvedValueOnce({ rows, rowCount });
  }
}

// ══════════════════════════════════════════════════════════════════════
// GET /api/payments (owner)
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/payments', () => {

  it('200: owner gets paginated payment list', async () => {
    q(
      [{ is_blocked: false }],
      [MOCK_PAYMENT_ROW],
      [{ total: '1', total_amount: '150000' }],
    );

    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payments).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.total_amount).toBe(150000);
  });

  it('200: filters by month query param', async () => {
    q(
      [{ is_blocked: false }],
      [MOCK_PAYMENT_ROW],
      [{ total: '1', total_amount: '150000' }],
    );

    const res = await request(app)
      .get('/api/payments?month=2026-05')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.payments).toHaveLength(1);
  });

  it('200: filters by member_id query param', async () => {
    q(
      [{ is_blocked: false }],
      [MOCK_PAYMENT_ROW],
      [{ total: '1', total_amount: '150000' }],
    );

    const res = await request(app)
      .get(`/api/payments?member_id=${MEMBER_ID}`)
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('200: empty list when no payments', async () => {
    q([{ is_blocked: false }], [], [{ total: '0', total_amount: '0' }]);
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.payments).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/payments');
    expect(res.status).toBe(401);
  });

  it('403: trainer cannot list all payments', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('403: member cannot list all payments', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/payments')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/payments/report (owner CSV)
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/payments/report', () => {

  it('200: returns CSV with correct headers and content-type', async () => {
    q(
      [{ is_blocked: false }],
      [{
        member_name: 'Alice', member_phone: '9876543210',
        amount: 150000, payment_method: 'razorpay',
        description: 'Monthly fee', created_at: new Date('2026-05-01'),
      }],
    );

    const res = await request(app)
      .get('/api/payments/report?month=2026-05')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/payments-2026-05\.csv/);
    expect(res.text).toContain('Member Name');
    expect(res.text).toContain('Alice');
  });

  it('200: empty report when no payments in month', async () => {
    q([{ is_blocked: false }], []);
    const res = await request(app)
      .get('/api/payments/report')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/payments/report');
    expect(res.status).toBe(401);
  });

  it('403: trainer cannot download payment report', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/payments/report')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/payments/create-order (member)
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/payments/create-order', () => {

  it('200: member creates a Razorpay order successfully', async () => {
    q(
      [{ is_blocked: false }],
      [{ razorpay_key_id: 'rzp_test_key', razorpay_key_secret: 'rzp_test_secret' }],
      // INSERT payment (default)
    );

    mockFetch.mockResolvedValueOnce({
      json: jest.fn().mockResolvedValue({ id: 'order_test_123', amount: 150000 }),
    });

    const res = await request(app)
      .post('/api/payments/create-order')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ amount: 1500, description: 'Monthly membership' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.order_id).toBe('order_test_123');
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.key_id).toBe('rzp_test_key');
  });

  it('400: amount missing or zero returns 400', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/payments/create-order')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ description: 'No amount' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
  });

  it('400: amount = 0 returns 400', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/payments/create-order')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ amount: 0 });
    expect(res.status).toBe(400);
  });

  it('400: gym has no Razorpay configured', async () => {
    q(
      [{ is_blocked: false }],
      [{ razorpay_key_id: null, razorpay_key_secret: null }],
    );

    const res = await request(app)
      .post('/api/payments/create-order')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/payments not set up/i);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/payments/create-order').send({ amount: 100 });
    expect(res.status).toBe(401);
  });

  it('403: owner cannot create member payment order', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/payments/create-order')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ amount: 100 });
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/payments/verify (member)
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/payments/verify', () => {

  const ORDER_ID    = 'order_test_123';
  const PAYMENT_REF = 'pay_test_456';

  function makeValidSignature(secret: string, orderId: string, paymentId: string) {
    return crypto.createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  }

  it('200: member verifies payment with valid signature', async () => {
    const secret = 'gym_test_secret';
    const sig    = makeValidSignature(secret, ORDER_ID, PAYMENT_REF);

    q(
      [{ is_blocked: false }],
      [{ razorpay_key_secret: secret }],        // gym secret lookup
      [{ id: PAYMENT_ID }],                     // UPDATE payments RETURNING id
    );

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({
        razorpay_order_id:   ORDER_ID,
        razorpay_payment_id: PAYMENT_REF,
        razorpay_signature:  sig,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.payment_id).toBe(PAYMENT_ID);
    expect(res.body.data.message).toMatch(/successful/i);
  });

  it('400: invalid signature returns 400', async () => {
    q(
      [{ is_blocked: false }],
      [{ razorpay_key_secret: 'correct_secret' }],
    );

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({
        razorpay_order_id:   ORDER_ID,
        razorpay_payment_id: PAYMENT_REF,
        razorpay_signature:  'tampered_signature_value',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/i);
  });

  it('400: missing required payment fields', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ razorpay_order_id: ORDER_ID }); // missing payment_id and signature
    expect(res.status).toBe(400);
  });

  it('400: gym has no Razorpay secret configured', async () => {
    q(
      [{ is_blocked: false }],
      [{ razorpay_key_secret: null }],
    );

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({
        razorpay_order_id:   ORDER_ID,
        razorpay_payment_id: PAYMENT_REF,
        razorpay_signature:  'any_sig',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('404: payment record not found after signature check', async () => {
    const secret = 'gym_test_secret';
    const sig    = makeValidSignature(secret, ORDER_ID, PAYMENT_REF);

    q(
      [{ is_blocked: false }],
      [{ razorpay_key_secret: secret }],
      [],   // UPDATE returns no rows → 404
    );

    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({
        razorpay_order_id:   ORDER_ID,
        razorpay_payment_id: PAYMENT_REF,
        razorpay_signature:  sig,
      });

    expect(res.status).toBe(404);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/payments/verify').send({});
    expect(res.status).toBe(401);
  });

  it('403: owner cannot verify member payment', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/payments/verify')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({
        razorpay_order_id:   ORDER_ID,
        razorpay_payment_id: PAYMENT_REF,
        razorpay_signature:  'sig',
      });
    expect(res.status).toBe(403);
  });
});
