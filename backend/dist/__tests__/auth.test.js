"use strict";
/**
 * Auth API Tests — POST /api/auth/login, POST /api/auth/refresh, GET /api/health
 *
 * Strategy: a single shared `mockQuery` is used for ALL pg queries (both pool.query
 * and client.query via pool.connect()). Tests use mockResolvedValueOnce to queue
 * responses in the order the endpoint makes DB calls.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ── Env before imports ────────────────────────────────────────────────────────
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test_jwt_secret_must_be_at_least_32_chars_ok';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_must_be_32_chars_ok!!';
process.env.CORS_ORIGIN = '*';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock('@sentry/node', () => ({
    init: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn(),
}));
// Single shared mockQuery for all DB interactions
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
        query: mockQuery,
        end: jest.fn(),
        on: jest.fn(),
    })),
}));
const mockBcryptCompare = jest.fn();
jest.mock('bcrypt', () => ({
    hash: jest.fn().mockResolvedValue('$hashed'),
    compare: mockBcryptCompare,
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
// ── Imports (after mocks) ─────────────────────────────────────────────────────
const supertest_1 = __importDefault(require("supertest"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const GYM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEMBER_ID = 'cccccccc-0000-0000-0000-000000000003';
const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
let app;
beforeAll(() => {
    app = require('../server').default;
});
afterEach(() => {
    // Keep default mockResolvedValue after each reset so startup-like calls still work
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockBcryptCompare.mockReset();
});
/** Queue DB result-sets in call order */
function q(...rowSets) {
    for (const item of rowSets) {
        const rows = Array.isArray(item) ? item : item.rows;
        const rowCount = Array.isArray(item) ? item.length : (item.rowCount ?? item.rows.length);
        mockQuery.mockResolvedValueOnce({ rows, rowCount });
    }
}
// ════════════════════════════════════════════════════════════════════════════
// GET /health & /api/health
// ════════════════════════════════════════════════════════════════════════════
describe('Health endpoints', () => {
    it('GET /health — 200 with status ok', async () => {
        const res = await (0, supertest_1.default)(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
        expect(res.body.version).toBe('3.0.0');
        expect(typeof res.body.uptime).toBe('number');
    });
    it('GET /api/health — 200 reachable via Firebase rewrite path', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.version).toBe('3.0.0');
    });
});
// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/login
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/login', () => {
    it('400: missing password field', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .send({ phone_or_email: 'owner@gym.com', role: 'owner' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
    it('400: invalid role', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .send({ phone_or_email: 'x@y.com', password: 'Test@1234', role: 'god' });
        expect(res.status).toBe(400);
    });
    it('401: user not found returns 401', async () => {
        q([]); // no user
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .send({ phone_or_email: 'nobody@gym.com', password: 'Test@1234', role: 'owner' });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid credentials/i);
    });
    it('401: wrong password returns 401', async () => {
        q([{ id: USER_ID, gym_id: GYM_ID, phone_or_email: 'o@g.com', password_hash: '$h', role: 'owner' }]);
        mockBcryptCompare.mockResolvedValueOnce(false);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .send({ phone_or_email: 'o@g.com', password: 'Wrong@123', role: 'owner' });
        expect(res.status).toBe(401);
    });
    it('200: owner login returns accessToken + refreshToken', async () => {
        q([{ id: USER_ID, gym_id: GYM_ID, phone_or_email: 'o@g.com', password_hash: '$h', role: 'owner' }], [{ subscription_status: 'trial', is_blocked: false }]);
        mockBcryptCompare.mockResolvedValueOnce(true);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '10.0.0.1')
            .send({ phone_or_email: 'o@g.com', password: 'Test@1234', role: 'owner' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.accessToken).toBeDefined();
        expect(res.body.data.refreshToken).toBeDefined();
        expect(res.body.data.user.role).toBe('owner');
        expect(res.body.data.user.gym_id).toBe(GYM_ID);
    });
    it('200: member login includes member_id in response', async () => {
        q([{ id: USER_ID, gym_id: GYM_ID, phone_or_email: 'm@g.com', password_hash: '$h', role: 'member' }], [{ subscription_status: 'trial', is_blocked: false }], [{ id: MEMBER_ID }]);
        mockBcryptCompare.mockResolvedValueOnce(true);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '10.0.0.2')
            .send({ phone_or_email: 'm@g.com', password: 'Test@1234', role: 'member' });
        expect(res.status).toBe(200);
        expect(res.body.data.user.member_id).toBe(MEMBER_ID);
    });
    it('200: member login works even when member_id not found (member_id absent from token)', async () => {
        q([{ id: USER_ID, gym_id: GYM_ID, phone_or_email: 'm2@g.com', password_hash: '$h', role: 'member' }], [{ subscription_status: 'trial', is_blocked: false }], [], // strategy 1: no user_id match
        []);
        mockBcryptCompare.mockResolvedValueOnce(true);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', '10.0.0.3')
            .send({ phone_or_email: 'm2@g.com', password: 'Test@1234', role: 'member' });
        // Login should still succeed — member_id just won't be in the token
        expect(res.status).toBe(200);
        expect(res.body.data.accessToken).toBeDefined();
    });
});
// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/refresh
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/refresh', () => {
    it('400: missing refresh_token', async () => {
        const res = await (0, supertest_1.default)(app).post('/api/auth/refresh').send({});
        expect(res.status).toBe(400);
    });
    it('401: malformed token', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/refresh')
            .send({ refresh_token: 'bad.token.here' });
        expect(res.status).toBe(401);
    });
    it('200: valid token issues new pair', async () => {
        const rt = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID }, REFRESH_SECRET, { expiresIn: '7d' });
        q([{ id: USER_ID, gym_id: GYM_ID, role: 'owner' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/refresh')
            .send({ refresh_token: rt });
        expect(res.status).toBe(200);
        expect(res.body.data.access_token).toBeDefined();
        expect(res.body.data.refresh_token).toBeDefined();
    });
});
//# sourceMappingURL=auth.test.js.map