/**
 * Dashboard & Revenue API Tests
 * GET /api/dashboard/kpis
 * GET /api/revenue
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

const JWT_SECRET = process.env.JWT_SECRET!;
const GYM_ID     = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';

const OWNER_TOKEN   = jwt.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner'   }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jwt.sign({ id: 'trainer-uid', gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN  = jwt.sign({ id: 'mem-uid',    gym_id: GYM_ID, role: 'member'  }, JWT_SECRET, { expiresIn: '1h' });

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
// GET /api/dashboard/kpis
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/dashboard/kpis', () => {

  it('200: returns KPI counts and revenue for owner', async () => {
    q(
      [{ is_blocked: false }],
      [{ active_members: '10', at_risk_members: '3', high_risk_members: '2', total_members: '15' }],
      [{ total_revenue: '50000' }],
    );

    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalMembers).toBe(15);
    expect(res.body.data.activeMembers).toBe(10);
    expect(res.body.data.atRiskMembers).toBe(3);
    expect(res.body.data.highRiskMembers).toBe(2);
    expect(res.body.data.revenueRecovered).toBe(50000);
  });

  it('200: zero members and zero revenue', async () => {
    q(
      [{ is_blocked: false }],
      [{ active_members: '0', at_risk_members: '0', high_risk_members: '0', total_members: '0' }],
      [{ total_revenue: '0' }],
    );

    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalMembers).toBe(0);
    expect(res.body.data.revenueRecovered).toBe(0);
  });

  it('200: fractional revenue is parsed correctly', async () => {
    q(
      [{ is_blocked: false }],
      [{ active_members: '5', at_risk_members: '1', high_risk_members: '0', total_members: '6' }],
      [{ total_revenue: '12345.67' }],
    );

    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revenueRecovered).toBeCloseTo(12345.67);
  });

  it('401: unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/dashboard/kpis');
    expect(res.status).toBe(401);
  });

  it('403: trainer role is forbidden', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('403: member role is forbidden', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/dashboard/kpis')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/revenue
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/revenue', () => {

  it('200: returns metrics, records, and monthly breakdown', async () => {
    q(
      [{ is_blocked: false }],
      [{
        total_recovered_members: '5',
        total_revenue: '75000',
        revenue_this_month: '15000',
        revenue_this_year: '75000',
      }],
      [
        { id: 'rev-1', member_id: 'mem-1', member_name: 'Alice', task_id: 'task-1', action: 'renewal', revenue_recovered: 1500, tracked_at: new Date().toISOString() },
        { id: 'rev-2', member_id: 'mem-2', member_name: 'Bob',   task_id: 'task-2', action: 'renewal', revenue_recovered: 2000, tracked_at: new Date().toISOString() },
      ],
      [
        { month: '2026-05-01', total_revenue: '15000', recovery_count: '3' },
        { month: '2026-04-01', total_revenue: '60000', recovery_count: '12' },
      ],
    );

    const res = await request(app)
      .get('/api/revenue')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.metrics.totalRecoveredMembers).toBe(5);
    expect(res.body.data.metrics.totalRevenueRecovered).toBe(75000);
    expect(res.body.data.metrics.revenueThisMonth).toBe(15000);
    expect(res.body.data.revenueRecords).toHaveLength(2);
    expect(res.body.data.revenue).toHaveLength(2);
  });

  it('200: empty gym — all zeros and empty arrays', async () => {
    q(
      [{ is_blocked: false }],
      [{
        total_recovered_members: '0',
        total_revenue: '0',
        revenue_this_month: '0',
        revenue_this_year: '0',
      }],
      [],
      [],
    );

    const res = await request(app)
      .get('/api/revenue')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.metrics.totalRecoveredMembers).toBe(0);
    expect(res.body.data.revenueRecords).toEqual([]);
    expect(res.body.data.revenue).toEqual([]);
  });

  it('200: monthly breakdown maps total and count correctly', async () => {
    q(
      [{ is_blocked: false }],
      [{ total_recovered_members: '1', total_revenue: '1500', revenue_this_month: '1500', revenue_this_year: '1500' }],
      [{ id: 'r1', member_id: 'm1', member_name: 'Alice', task_id: 't1', action: 'renewal', revenue_recovered: 1500, tracked_at: new Date().toISOString() }],
      [{ month: '2026-05-01', total_revenue: '1500', recovery_count: '1' }],
    );

    const res = await request(app)
      .get('/api/revenue')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    const monthRow = res.body.data.revenue[0];
    expect(monthRow.total).toBe(1500);
    expect(monthRow.count).toBe(1);
  });

  it('401: unauthenticated request returns 401', async () => {
    const res = await request(app).get('/api/revenue');
    expect(res.status).toBe(401);
  });

  it('403: trainer cannot access revenue data', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/revenue')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});
