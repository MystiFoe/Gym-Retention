"use strict";
/**
 * Extended Auth API Tests
 * POST /api/auth/forgot-password
 * POST /api/auth/verify-reset-otp
 * POST /api/auth/reset-password
 * POST /api/auth/send-otp
 * POST /api/auth/verify-otp
 * POST /api/auth/verify-firebase-token
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
const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const TOKEN_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const RESET_TOKEN = 'a'.repeat(64); // 64-char hex token
const FUTURE = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
// POST /api/auth/forgot-password
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/forgot-password', () => {
    it('200: sends OTP email when user exists (email enumeration safe)', async () => {
        q([{ id: USER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'owner@test.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/code has been sent/i);
    });
    it('200: returns same message when user does not exist (prevents enumeration)', async () => {
        q([]); // user not found → same 200 response
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'nobody@test.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/code has been sent/i);
    });
    it('400: invalid email format returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/forgot-password')
            .send({ email: 'not-an-email' });
        expect(res.status).toBe(400);
    });
    it('400: missing email returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/forgot-password')
            .send({});
        expect(res.status).toBe(400);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-reset-otp
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/verify-reset-otp', () => {
    it('200: verifies correct OTP and returns reset_token', async () => {
        q([{ id: USER_ID }], [{ id: TOKEN_ID, token: 'otp:123456', expires_at: FUTURE }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'owner@test.com', otp_code: '123456' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.reset_token).toBeDefined();
        expect(typeof res.body.data.reset_token).toBe('string');
    });
    it('400: wrong OTP code returns 400', async () => {
        q([{ id: USER_ID }], [{ id: TOKEN_ID, token: 'otp:999999', expires_at: FUTURE }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'owner@test.com', otp_code: '123456' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/incorrect/i);
    });
    it('400: expired OTP returns 400', async () => {
        const PAST = new Date(Date.now() - 1000).toISOString();
        q([{ id: USER_ID }], [{ id: TOKEN_ID, token: 'otp:123456', expires_at: PAST }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'owner@test.com', otp_code: '123456' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/expired/i);
    });
    it('400: user not found returns 400', async () => {
        q([]); // user not found
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'ghost@test.com', otp_code: '123456' });
        expect(res.status).toBe(400);
    });
    it('400: no reset request found returns 400', async () => {
        q([{ id: USER_ID }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'owner@test.com', otp_code: '123456' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no reset request/i);
    });
    it('400: missing fields returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-reset-otp')
            .send({ email: 'owner@test.com' });
        expect(res.status).toBe(400);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/reset-password', () => {
    it('200: resets password with valid token', async () => {
        q([{ id: TOKEN_ID, user_id: USER_ID, expires_at: FUTURE, used_at: null }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/reset-password')
            .send({ token: RESET_TOKEN, new_password: 'NewSecure@123' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/password updated/i);
    });
    it('400: token not found returns 400', async () => {
        q([]); // no token found
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/reset-password')
            .send({ token: RESET_TOKEN, new_password: 'NewSecure@123' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid or expired/i);
    });
    it('400: token already used returns 400', async () => {
        q([{ id: TOKEN_ID, user_id: USER_ID, expires_at: FUTURE, used_at: new Date().toISOString() }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/reset-password')
            .send({ token: RESET_TOKEN, new_password: 'NewSecure@123' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already been used/i);
    });
    it('400: expired token returns 400', async () => {
        const PAST = new Date(Date.now() - 1000).toISOString();
        q([{ id: TOKEN_ID, user_id: USER_ID, expires_at: PAST, used_at: null }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/reset-password')
            .send({ token: RESET_TOKEN, new_password: 'NewSecure@123' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/expired/i);
    });
    it('400: missing required fields returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/reset-password')
            .send({ token: RESET_TOKEN });
        expect(res.status).toBe(400);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/auth/send-otp
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/send-otp', () => {
    it('200: sends OTP when user exists', async () => {
        q([{ id: USER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/send-otp')
            .send({ email: 'owner@test.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/sent/i);
    });
    it('200: returns same message when user not found (enumeration safe)', async () => {
        q([]); // user not found
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/send-otp')
            .send({ email: 'nobody@test.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
    it('400: invalid email returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/send-otp')
            .send({ email: 'bad-email' });
        expect(res.status).toBe(400);
    });
    it('400: missing email returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/send-otp')
            .send({});
        expect(res.status).toBe(400);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-otp
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/verify-otp', () => {
    it('200: verifies valid OTP and marks email as verified', async () => {
        q([{ id: 'otp-id', expires_at: FUTURE, used_at: null }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-otp')
            .send({ email: 'owner@test.com', code: '123456' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toMatch(/verified/i);
    });
    it('400: invalid OTP code returns 400', async () => {
        q([]); // no matching otp found
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-otp')
            .send({ email: 'owner@test.com', code: '000000' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid/i);
    });
    it('400: already-used OTP returns 400', async () => {
        q([{ id: 'otp-id', expires_at: FUTURE, used_at: new Date().toISOString() }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-otp')
            .send({ email: 'owner@test.com', code: '123456' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already been used/i);
    });
    it('400: expired OTP returns 400', async () => {
        const PAST = new Date(Date.now() - 1000).toISOString();
        q([{ id: 'otp-id', expires_at: PAST, used_at: null }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-otp')
            .send({ email: 'owner@test.com', code: '123456' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/expired/i);
    });
    it('400: missing fields returns 400', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-otp')
            .send({ email: 'owner@test.com' });
        expect(res.status).toBe(400);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-firebase-token
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/auth/verify-firebase-token', () => {
    it('503: returns 503 when Firebase is not configured', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-firebase-token')
            .send({ firebase_id_token: 'some-token', role: 'owner' });
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/firebase/i);
    });
    it('400: missing fields still returns 503 (Firebase check is first)', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/verify-firebase-token')
            .send({});
        expect(res.status).toBe(503);
    });
});
//# sourceMappingURL=auth_extended.test.js.map