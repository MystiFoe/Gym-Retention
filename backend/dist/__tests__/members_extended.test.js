"use strict";
/**
 * Members Extended API Tests
 * GET    /api/members/export     — CSV download
 * POST   /api/members/bulk-import
 * DELETE /api/members/:id/data   — GDPR erase
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
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const TRAINER_UID = 'cccccccc-0000-0000-0000-000000000003';
const MEMBER_ID = 'dddddddd-0000-0000-0000-000000000004';
const TRAINER_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jsonwebtoken_1.default.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: 'mem-uid', gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '1h' });
const EXPIRY_DATE = '2027-01-01';
const MOCK_MEMBER_ROW = {
    id: MEMBER_ID,
    name: 'Alice Kumar',
    phone: '9876543210',
    email: 'alice@test.com',
    status: 'active',
    last_visit_date: '2026-05-01',
    membership_expiry_date: EXPIRY_DATE,
    plan_fee: 1500,
    created_at: '2026-01-01',
    assigned_trainer: null,
};
let app;
beforeAll(() => { app = require('../server').default; });
afterEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});
function q(...rowSets) {
    for (const item of rowSets) {
        const rows = Array.isArray(item) ? item : item.rows;
        const rowCount = Array.isArray(item) ? item.length : (item.rowCount ?? item.rows.length);
        mockQuery.mockResolvedValueOnce({ rows, rowCount });
    }
}
// ══════════════════════════════════════════════════════════════════════
// GET /api/members/export
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/members/export', () => {
    it('200: returns CSV file with correct headers', async () => {
        q([{ is_blocked: false }], [MOCK_MEMBER_ROW]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members/export')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/i);
        expect(res.headers['content-disposition']).toMatch(/attachment/i);
        expect(res.headers['content-disposition']).toMatch(/\.csv/);
        expect(res.text).toContain('Name');
        expect(res.text).toContain('Phone');
        expect(res.text).toContain('Alice Kumar');
    });
    it('200: empty gym returns CSV with headers only', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members/export')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/csv/i);
        expect(res.text).toContain('ID,Name,Phone');
    });
    it('200: includes BOM character for Excel compatibility', async () => {
        q([{ is_blocked: false }], [MOCK_MEMBER_ROW]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members/export')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        // BOM is ﻿ — check that the response includes the CSV header
        expect(res.text).toContain('ID,Name,Phone,Email,Status');
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/members/export');
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot export members', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members/export')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
    it('403: member role cannot export', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/members/export')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/members/bulk-import
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/members/bulk-import', () => {
    const VALID_MEMBERS = [
        { name: 'Alice', phone: '9000000001', email: 'alice@test.com', membership_expiry_date: EXPIRY_DATE, plan_fee: 1500 },
        { name: 'Bob', phone: '9000000002', email: 'bob@test.com', membership_expiry_date: EXPIRY_DATE, plan_fee: 1200 },
    ];
    it('200: imports members successfully', async () => {
        q([{ is_blocked: false }], [], // existing phones → none
        { rows: [], rowCount: 2 });
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ members: VALID_MEMBERS });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.imported).toBe(2);
        expect(res.body.data.skipped).toBe(0);
    });
    it('200: skips duplicate phones', async () => {
        q([{ is_blocked: false }], [{ phone: '9000000001' }], // existing phone → one duplicate
        { rows: [], rowCount: 1 });
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ members: VALID_MEMBERS });
        expect(res.status).toBe(200);
        expect(res.body.data.skipped).toBe(1);
        expect(res.body.data.errors[0].error).toMatch(/duplicate/i);
    });
    it('200: imports with trainer_id assigns trainer', async () => {
        q([{ is_blocked: false }], [{ id: TRAINER_ID }], // trainer check → valid
        [], // existing phones
        { rows: [], rowCount: 1 });
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ trainer_id: TRAINER_ID, members: [VALID_MEMBERS[0]] });
        expect(res.status).toBe(200);
        expect(res.body.data.imported).toBe(1);
    });
    it('400: invalid trainer_id returns 400', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ trainer_id: TRAINER_ID, members: VALID_MEMBERS });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/trainer not found/i);
    });
    it('400: missing members array returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({});
        expect(res.status).toBe(400);
    });
    it('400: empty members array returns 400 (min 1)', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ members: [] });
        expect(res.status).toBe(400);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .send({ members: VALID_MEMBERS });
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot bulk import', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/members/bulk-import')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send({ members: VALID_MEMBERS });
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// DELETE /api/members/:id/data — GDPR erase
// ══════════════════════════════════════════════════════════════════════
describe('DELETE /api/members/:id/data', () => {
    it('200: erases member personal data', async () => {
        q([{ is_blocked: false }], [{ id: MEMBER_ID }], // member check
        []);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/erased/i);
    });
    it('404: member not found returns 404', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`);
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot erase member data', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
    it('403: member role cannot erase data', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/members/${MEMBER_ID}/data`)
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
//# sourceMappingURL=members_extended.test.js.map