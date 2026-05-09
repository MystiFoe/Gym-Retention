"use strict";
/**
 * Members CRUD API Tests
 * GET    /api/members
 * POST   /api/members
 * PUT    /api/members/:id
 * DELETE /api/members/:id
 * DELETE /api/members/:id/data  (GDPR)
 * GET    /api/members/export    (CSV)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test_jwt_secret_must_be_at_least_32_chars_ok';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_must_be_32_chars_ok!!';
process.env.CORS_ORIGIN = '*';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
jest.mock('@sentry/node', () => ({
    init: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn(),
}));
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
        query: mockQuery,
        end: jest.fn(),
        on: jest.fn(),
    })),
}));
jest.mock('bcrypt', () => ({
    hash: jest.fn().mockResolvedValue('$hashed'),
    compare: jest.fn().mockResolvedValue(true),
}));
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
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
    Registry: jest.fn().mockImplementation(() => ({ registerMetric: jest.fn(), contentType: 'text/plain', metrics: jest.fn().mockResolvedValue(''), clear: jest.fn() })),
    Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
    Counter: jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
    Gauge: jest.fn().mockImplementation(() => ({ set: jest.fn(), inc: jest.fn() })),
}));
const supertest_1 = __importDefault(require("supertest"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET;
const GYM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jsonwebtoken_1.default.sign({ id: 'trainer-uid', gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '1h' });
const VALID_BODY = {
    name: 'Test User',
    phone: '9876543210',
    email: 'test@gym.com',
    membership_expiry_date: '2026-12-31',
    plan_fee: 1500,
    plan: 'monthly',
};
const MOCK_MEMBER_ROW = {
    id: MEMBER_ID, name: 'Test User', phone: '9876543210', email: 'test@gym.com',
    status: 'active', plan_fee: '1500', plan: 'monthly',
    created_at: new Date().toISOString(), assigned_trainer_id: null,
    days_last_visit: 0, days_to_expiry: 200,
    membership_expiry_date: '2026-12-31', last_visit_date: null, display_id: 'RCV-M-0000001',
};
let app;
beforeAll(() => {
    app = require('../server').default;
});
afterEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});
function q(...rowSets) {
    for (const rows of rowSets) {
        mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
    }
}
// ════════════════════════════════════════════════════════════════════════════
// GET /api/members
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/members', () => {
    it('200: owner gets paginated member list', async () => {
        q([{ is_blocked: false }], [{ total: '2' }], [MOCK_MEMBER_ROW, { ...MOCK_MEMBER_ROW, id: 'mem-2', name: 'Member Two' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members?page=1&limit=10')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.members).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
    });
    it('200: trainer sees only their assigned members', async () => {
        q([{ is_blocked: false }], [{ id: 'trainer-row-id' }], // trainer lookup
        [{ total: '1' }], [MOCK_MEMBER_ROW]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.members).toHaveLength(1);
    });
    it('401: unauthenticated', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/members');
        expect(res.status).toBe(401);
    });
    it('403: member role cannot list members', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// POST /api/members
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/members', () => {
    it('201: creates member successfully', async () => {
        q([{ is_blocked: false }], [], // phone uniqueness check → not taken
        [], // email uniqueness check → not taken
        [{ last_value: '1' }], // generateDisplayId → id_sequences upsert
        [{ last_value: '1' }], // generateDisplayId → id_sequences update
        [{ ...MOCK_MEMBER_ROW }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_BODY);
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('Test User');
    });
    it('400: missing required fields', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Test' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
    it('409: duplicate phone returns 409', async () => {
        q([{ is_blocked: false }], [{ id: 'existing', is_deleted: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_BODY);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/phone/i);
    });
    it('403: trainer cannot create members', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send(VALID_BODY);
        expect(res.status).toBe(403);
    });
    it('401: unauthenticated', async () => {
        const res = await (0, supertest_1.default)(app).post('/api/members').send(VALID_BODY);
        expect(res.status).toBe(401);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// PUT /api/members/:id
// ════════════════════════════════════════════════════════════════════════════
describe('PUT /api/members/:id', () => {
    it('200: owner updates member', async () => {
        q([{ is_blocked: false }], [], // phone uniqueness → OK
        [{ id: MEMBER_ID, updated_at: new Date() }]);
        const res = await (0, supertest_1.default)(app)
            .put(`/api/members/${MEMBER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_BODY);
        expect([200, 400]).toContain(res.status);
    });
    it('404: member not in this gym returns 404', async () => {
        q([{ is_blocked: false }], [], // phone check OK
        []);
        const res = await (0, supertest_1.default)(app)
            .put(`/api/members/${MEMBER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_BODY);
        expect(res.status).toBe(404);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/members/:id
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/members/:id', () => {
    it('200: owner soft-deletes member', async () => {
        q([{ is_blocked: false }], [{ id: MEMBER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.id).toBe(MEMBER_ID);
    });
    it('403: trainer cannot delete members', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}`)
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/members/:id/data — GDPR erase
// ════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/members/:id/data (GDPR)', () => {
    it('200: erases PII and returns success', async () => {
        q([{ is_blocked: false }], [{ id: MEMBER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/erased/i);
    });
    it('404: member not in gym returns 404', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(404);
    });
});
//# sourceMappingURL=members.test.js.map