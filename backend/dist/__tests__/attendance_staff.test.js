"use strict";
/**
 * Staff Attendance Management API Tests
 * POST /api/attendance   — staff marks member attendance
 * GET  /api/attendance   — list attendance logs
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
const LOG_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jsonwebtoken_1.default.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: 'mem-uid', gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '1h' });
const TODAY = new Date().toISOString().split('T')[0];
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
// POST /api/attendance
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/attendance', () => {
    it('201: owner marks attendance for a member', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID, visit_date: TODAY });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
    });
    it('201: trainer marks attendance for a member', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send({ member_id: MEMBER_ID, visit_date: TODAY });
        expect(res.status).toBe(201);
    });
    it('201: marks attendance with check_in_time', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID, visit_date: TODAY, check_in_time: '09:30:00' });
        expect(res.status).toBe(201);
    });
    it('409: duplicate attendance for same day returns 409', async () => {
        q([{ is_blocked: false }], [{ id: LOG_ID }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID, visit_date: TODAY });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already marked/i);
    });
    it('400: missing member_id returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ visit_date: TODAY });
        expect(res.status).toBe(400);
    });
    it('400: missing visit_date returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(400);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .send({ member_id: MEMBER_ID, visit_date: TODAY });
        expect(res.status).toBe(401);
    });
    it('403: member role cannot mark attendance', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
            .send({ member_id: MEMBER_ID, visit_date: TODAY });
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// GET /api/attendance
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/attendance', () => {
    it('200: returns attendance logs for owner', async () => {
        q([{ is_blocked: false }], [
            { id: LOG_ID, member_id: MEMBER_ID, visit_date: TODAY, check_in_time: '09:00:00', created_at: new Date().toISOString() },
            { id: 'log-2', member_id: MEMBER_ID, visit_date: '2026-05-08', check_in_time: null, created_at: new Date().toISOString() },
        ]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.attendance).toHaveLength(2);
    });
    it('200: trainer can view attendance logs', async () => {
        q([{ is_blocked: false }], [{ id: LOG_ID, member_id: MEMBER_ID, visit_date: TODAY, check_in_time: null, created_at: new Date().toISOString() }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/attendance')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.attendance).toHaveLength(1);
    });
    it('200: filters by date query param', async () => {
        q([{ is_blocked: false }], [{ id: LOG_ID, member_id: MEMBER_ID, visit_date: TODAY, check_in_time: null, created_at: new Date().toISOString() }]);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/attendance?date=${TODAY}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.attendance).toHaveLength(1);
    });
    it('200: returns empty array when no attendance records', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/attendance')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.attendance).toEqual([]);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/attendance');
        expect(res.status).toBe(401);
    });
    it('403: member role cannot list attendance', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/attendance')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
//# sourceMappingURL=attendance_staff.test.js.map