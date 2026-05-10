/**
 * Tasks API Tests
 * POST  /api/tasks
 * GET   /api/tasks
 * PATCH /api/tasks/:id
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

const JWT_SECRET  = process.env.JWT_SECRET!;
const GYM_ID      = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID     = 'bbbbbbbb-0000-0000-0000-000000000002';
const TRAINER_UID = 'cccccccc-0000-0000-0000-000000000003';
const TRAINER_ID  = 'dddddddd-0000-0000-0000-000000000004';
const MEMBER_ID   = 'eeeeeeee-0000-0000-0000-000000000005';
const TASK_ID     = 'ffffffff-0000-0000-0000-000000000006';

const OWNER_TOKEN   = jwt.sign({ id: USER_ID,     gym_id: GYM_ID, role: 'owner'   }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jwt.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN  = jwt.sign({ id: 'mem-uid',   gym_id: GYM_ID, role: 'member'  }, JWT_SECRET, { expiresIn: '1h' });

const MOCK_TASK = {
  id: TASK_ID, member_id: MEMBER_ID, task_type: 'call',
  assigned_trainer_id: TRAINER_ID, status: 'pending',
  created_at: new Date().toISOString(),
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
// POST /api/tasks
// ══════════════════════════════════════════════════════════════════════

describe('POST /api/tasks', () => {

  it('201: creates task with explicit trainer_id', async () => {
    q(
      [{ is_blocked: false }],
      [{ id: MEMBER_ID }],           // member existence check
      [{ id: TRAINER_ID }],          // trainer existence check
      [MOCK_TASK],                   // INSERT follow_up_tasks RETURNING
      [{ fcm_token: null }],         // notification query (no token)
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'call', assigned_trainer_id: TRAINER_ID });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.task_type).toBe('call');
    expect(res.body.data.status).toBe('pending');
  });

  it('201: auto-assigns trainer from member when no trainer_id given', async () => {
    q(
      [{ is_blocked: false }],
      [{ id: MEMBER_ID }],                                              // member check
      [{ assigned_trainer_id: TRAINER_ID, name: 'Test Member' }],      // member trainer lookup
      [MOCK_TASK],                                                       // INSERT task
      [{ fcm_token: null }],                                            // notification
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'renewal' });

    expect(res.status).toBe(201);
    expect(res.body.data.assigned_trainer_id).toBe(TRAINER_ID);
  });

  it('404: member not found returns 404', async () => {
    q(
      [{ is_blocked: false }],
      [],  // member check → empty
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'call' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/member not found/i);
  });

  it('400: member has no trainer assigned and none provided', async () => {
    q(
      [{ is_blocked: false }],
      [{ id: MEMBER_ID }],
      [{ assigned_trainer_id: null, name: 'Solo Member' }],  // no trainer
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'call' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no staff assigned/i);
  });

  it('404: explicit trainer_id not found in gym', async () => {
    q(
      [{ is_blocked: false }],
      [{ id: MEMBER_ID }],   // member found
      [],                     // trainer check → empty
    );

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'call', assigned_trainer_id: TRAINER_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/trainer not found/i);
  });

  it('400: missing required member_id field', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ task_type: 'call' });
    expect(res.status).toBe(400);
  });

  it('400: invalid task_type value', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'invalid_type' });
    expect(res.status).toBe(400);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).post('/api/tasks').send({ member_id: MEMBER_ID, task_type: 'call' });
    expect(res.status).toBe(401);
  });

  it('403: member role cannot create tasks', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ member_id: MEMBER_ID, task_type: 'call' });
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/tasks
// ══════════════════════════════════════════════════════════════════════

describe('GET /api/tasks', () => {

  it('200: owner gets paginated task list', async () => {
    q(
      [{ is_blocked: false }],
      [{ total: '2' }],
      [
        { ...MOCK_TASK, member_name: 'Alice', member_phone: '9000000001', trainer_name: 'Bob' },
        { ...MOCK_TASK, id: 'task-2', member_name: 'Carol', member_phone: '9000000002', trainer_name: 'Dave' },
      ],
    );

    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tasks).toHaveLength(2);
    expect(res.body.data.total).toBe(2);
  });

  it('200: trainer gets tasks (authorize owner|trainer)', async () => {
    q(
      [{ is_blocked: false }],
      [{ total: '1' }],
      [{ ...MOCK_TASK, member_name: 'Alice', trainer_name: 'Jane' }],
    );

    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(1);
  });

  it('200: filters by status query param', async () => {
    q([{ is_blocked: false }], [{ total: '1' }], [MOCK_TASK]);
    const res = await request(app)
      .get('/api/tasks?status=pending')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
  });

  it('200: empty task list when no tasks', async () => {
    q([{ is_blocked: false }], [{ total: '0' }], []);
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${OWNER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toEqual([]);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('403: member role cannot list tasks', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════
// PATCH /api/tasks/:id
// ══════════════════════════════════════════════════════════════════════

describe('PATCH /api/tasks/:id', () => {

  it('200: trainer completes task with outcome=called', async () => {
    q(
      [{ is_blocked: false }],
      [{ member_id: MEMBER_ID }],  // UPDATE task RETURNING member_id
      [{ fcm_token: null }],       // owner notification query
    );

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ outcome: 'called' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(TASK_ID);
  });

  it('200: outcome=renewed creates revenue record', async () => {
    q(
      [{ is_blocked: false }],
      [{ member_id: MEMBER_ID }],        // UPDATE task
      [{ plan_fee: 1500 }],              // SELECT member plan_fee
      // INSERT revenue_records (default)
      [{ fcm_token: null }],             // owner notification
    );

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ outcome: 'renewed', notes: 'Member renewed membership' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('200: all valid outcome values are accepted', async () => {
    const validOutcomes = ['called', 'not_reachable', 'coming_tomorrow', 'no_action'];

    for (const outcome of validOutcomes) {
      mockQuery.mockReset();
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
      q(
        [{ is_blocked: false }],
        [{ member_id: MEMBER_ID }],
        [],   // owner notification (no token)
      );

      const res = await request(app)
        .patch(`/api/tasks/${TASK_ID}`)
        .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
        .send({ outcome });

      expect(res.status).toBe(200);
    }
  });

  it('400: missing outcome field', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ notes: 'no outcome provided' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outcome is required/i);
  });

  it('400: invalid outcome value', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ outcome: 'invalid_outcome' });
    expect(res.status).toBe(400);
  });

  it('404: task not found in gym returns 404', async () => {
    q(
      [{ is_blocked: false }],
      [],  // UPDATE task → no rows
    );

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
      .send({ outcome: 'called' });

    expect(res.status).toBe(404);
  });

  it('401: unauthenticated returns 401', async () => {
    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).send({ outcome: 'called' });
    expect(res.status).toBe(401);
  });

  it('403: owner cannot complete tasks (trainer-only endpoint)', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${OWNER_TOKEN}`)
      .send({ outcome: 'called' });
    expect(res.status).toBe(403);
  });

  it('403: member cannot complete tasks', async () => {
    q([{ is_blocked: false }]);
    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
      .send({ outcome: 'called' });
    expect(res.status).toBe(403);
  });
});
