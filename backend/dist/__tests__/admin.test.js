"use strict";
/**
 * Admin API Tests
 * GET    /api/admin/gyms
 * POST   /api/admin/gyms/:id/suspend
 * POST   /api/admin/gyms/:id/reactivate
 * POST   /api/admin/gyms/:id/block
 * POST   /api/admin/gyms/:id/unblock
 * POST   /api/admin/gyms/:id/convert
 * DELETE /api/admin/gyms/:id
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
process.env.ADMIN_SECRET = 'test-admin-secret-token';
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
const ADMIN_TOKEN = 'test-admin-secret-token';
const GYM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
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
const MOCK_GYM = {
    id: GYM_ID, name: 'Test Gym', email: 'gym@test.com', phone: '9000000000',
    owner_name: 'Owner', created_at: new Date().toISOString(),
    trial_ends_at: null, subscription_ends_at: null,
    subscription_status: 'trial', is_blocked: false,
    blocked_at: null, blocked_reason: null,
    member_count: '5', days_remaining: '10',
};
// ══════════════════════════════════════════════════════════════════════
// GET /api/admin/gyms
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/admin/gyms', () => {
    it('200: returns list of gyms with ADMIN_SECRET', async () => {
        q([MOCK_GYM, { ...MOCK_GYM, id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Second Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/admin/gyms')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.gyms).toHaveLength(2);
        expect(res.body.data.gyms[0].name).toBe('Test Gym');
    });
    it('200: empty gym list', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/admin/gyms')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.gyms).toEqual([]);
    });
    it('401: no token returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/admin/gyms');
        expect(res.status).toBe(401);
    });
    it('401: wrong token returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .get('/api/admin/gyms')
            .set('Authorization', 'Bearer wrong-secret');
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/gyms/:id/suspend
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/admin/gyms/:id/suspend', () => {
    it('200: suspends a gym', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/suspend`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/suspended/i);
    });
    it('404: gym not found returns 404', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/suspend`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('404: invalid UUID returns 404', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/admin/gyms/not-a-uuid/suspend')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('401: missing admin token returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/suspend`);
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/gyms/:id/reactivate
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/admin/gyms/:id/reactivate', () => {
    it('200: reactivates gym as trial (no subscription_ends_at)', async () => {
        q([{ name: 'Test Gym', subscription_ends_at: null }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/reactivate`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/trial/i);
    });
    it('200: reactivates gym as active (subscription not expired)', async () => {
        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
        q([{ name: 'Test Gym', subscription_ends_at: futureDate }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/reactivate`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.message).toMatch(/active/i);
    });
    it('404: gym not found returns 404', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/reactivate`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('404: invalid UUID returns 404', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/admin/gyms/bad-id/reactivate')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/gyms/:id/block
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/admin/gyms/:id/block', () => {
    it('200: blocks a gym with reason', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/block`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ reason: 'Fraud suspected' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/blocked/i);
    });
    it('200: blocks a gym without reason (reason is optional)', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/block`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({});
        expect(res.status).toBe(200);
    });
    it('404: gym not found returns 404', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/block`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('404: invalid UUID returns 404', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/admin/gyms/xyz/block')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/gyms/:id/unblock
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/admin/gyms/:id/unblock', () => {
    it('200: unblocks a gym', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/unblock`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/unblocked/i);
    });
    it('404: gym not found returns 404', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/unblock`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('404: invalid UUID returns 404', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/admin/gyms/not-uuid/unblock')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/admin/gyms/:id/convert
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/admin/gyms/:id/convert', () => {
    it('200: converts gym to paid subscription (3 months)', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/convert`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ months: 3 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/3 month/i);
        expect(res.body.data.ends_at).toBeDefined();
    });
    it('200: converts for 12 months', async () => {
        q([{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/convert`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ months: 12 });
        expect(res.status).toBe(200);
    });
    it('400: months field is required', async () => {
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/convert`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({});
        expect(res.status).toBe(400);
    });
    it('400: months must be between 1 and 12', async () => {
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/convert`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ months: 13 });
        expect(res.status).toBe(400);
    });
    it('404: gym not found returns 404', async () => {
        q([]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/admin/gyms/${GYM_ID}/convert`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
            .send({ months: 3 });
        expect(res.status).toBe(404);
    });
});
// ══════════════════════════════════════════════════════════════════════
// DELETE /api/admin/gyms/:id
// ══════════════════════════════════════════════════════════════════════
describe('DELETE /api/admin/gyms/:id', () => {
    it('200: permanently deletes a gym and all data', async () => {
        q([], // BEGIN
        [{ name: 'Test Gym' }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/admin/gyms/${GYM_ID}`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/permanently deleted/i);
    });
    it('404: gym not found returns 404', async () => {
        q([], // BEGIN
        []);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/admin/gyms/${GYM_ID}`)
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('404: invalid UUID returns 404', async () => {
        const res = await (0, supertest_1.default)(app)
            .delete('/api/admin/gyms/not-a-uuid')
            .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
        expect(res.status).toBe(404);
    });
    it('401: missing admin token returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/admin/gyms/${GYM_ID}`);
        expect(res.status).toBe(401);
    });
});
//# sourceMappingURL=admin.test.js.map