"use strict";
/**
 * Member Portal API Tests
 * GET  /api/customer/profile
 * GET  /api/customer/attendance
 * GET  /api/customer/payments
 * POST /api/attendance/checkin
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
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, member_id: MEMBER_ID, gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '30d' });
const MEMBER_TOKEN_NO_ID = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '30d' });
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: 'owner-uid', gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const MOCK_PROFILE = {
    id: MEMBER_ID,
    name: 'Test Member',
    phone: '9876543210',
    email: 'member@gym.com',
    status: 'active',
    last_visit_date: '2026-05-01',
    membership_expiry_date: '2026-12-31',
    plan_fee: '1500',
    plan: 'monthly',
    created_at: '2026-01-01T00:00:00Z',
    email_verified: false,
    phone_verified: false,
    gym_name: 'Test Gym',
    gym_address: '123 Main St',
    gym_phone: '9999999999',
    payment_enabled: false,
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
// GET /api/customer/profile
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/customer/profile', () => {
    it('200: member_id in JWT, profile found', async () => {
        q([{ is_blocked: false }], // authenticate gym check
        [MOCK_PROFILE]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/profile')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.id).toBe(MEMBER_ID);
        expect(res.body.data.gym_name).toBe('Test Gym');
    });
    it('404: profile not found when member row is missing', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/profile')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/profile not found/i);
    });
    it('404: member_id not in JWT + resolveMemberId finds nothing → 404', async () => {
        q([{ is_blocked: false }], [], // strategy 1 (user_id) → empty
        []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/profile')
            .set('Authorization', `Bearer ${MEMBER_TOKEN_NO_ID}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/profile not found/i);
    });
    it('401: no auth token returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/customer/profile');
        expect(res.status).toBe(401);
    });
    it('403: owner token cannot access /api/customer/profile', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/profile')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// GET /api/customer/attendance
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/customer/attendance', () => {
    it('200: returns attendance array', async () => {
        q([{ is_blocked: false }], [{ date: '2026-05-01', status: 'present', source: 'mobile' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/attendance?year=2026&month=5')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data[0].date).toBe('2026-05-01');
    });
    it('200: returns empty array when no attendance records', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/attendance?year=2026&month=1')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });
    it('401: unauthenticated request rejected', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/customer/attendance');
        expect(res.status).toBe(401);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// GET /api/customer/payments
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/customer/payments', () => {
    it('200: returns payment history', async () => {
        q([{ is_blocked: false }], [{ id: 'pay-1', amount: 150000, currency: 'INR', status: 'completed', payment_method: 'razorpay', description: null, created_at: '2026-01-01' }], [{ count: '1' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/payments')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.payments).toHaveLength(1);
        expect(res.body.data.total).toBe(1);
    });
    it('200: empty payments array when no records', async () => {
        q([{ is_blocked: false }], [], [{ count: '0' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/customer/payments')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.payments).toEqual([]);
        expect(res.body.data.total).toBe(0);
    });
    it('401: no auth', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/customer/payments');
        expect(res.status).toBe(401);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// POST /api/attendance/checkin
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/attendance/checkin', () => {
    it('200: check-in succeeds (not already marked)', async () => {
        q([{ is_blocked: false }], []);
        // insert is fire-and-forget (pool.query) so default mock handles it
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/checkin')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.already_marked).toBe(false);
    });
    it('200: already_marked=true if attendance exists today', async () => {
        q([{ is_blocked: false }], [{ id: 'att-1', source: 'mobile' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/checkin')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.already_marked).toBe(true);
    });
    it('403: owner cannot use checkin endpoint', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/checkin')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(403);
    });
    it('401: no token', async () => {
        const res = await (0, supertest_1.default)(app).post('/api/attendance/checkin');
        expect(res.status).toBe(401);
    });
    it('404: member profile not found when JWT has no member_id and resolve fails', async () => {
        q([{ is_blocked: false }], [], // strategy 1 → empty
        []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/checkin')
            .set('Authorization', `Bearer ${MEMBER_TOKEN_NO_ID}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/member profile not found/i);
    });
});
//# sourceMappingURL=member_portal.test.js.map