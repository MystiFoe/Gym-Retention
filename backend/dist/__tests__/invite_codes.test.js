"use strict";
/**
 * Invite Codes API Tests
 * POST /api/invites
 * GET  /api/invites
 * GET  /api/invites/:code
 * POST /api/auth/staff/register
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
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const TRAINER_ID = 'dddddddd-0000-0000-0000-000000000004';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
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
// POST /api/invites
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/invites', () => {
    it('400: missing type', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Test' });
        expect(res.status).toBe(400);
    });
    it('400: invalid type value', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ type: 'superuser' });
        expect(res.status).toBe(400);
    });
    it('400: member invite requires name field', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ type: 'member' }); // no name
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/name is required/i);
    });
    it('201: staff invite code created', async () => {
        q([{ is_blocked: false }], [{ last_value: '0' }], // id_sequences upsert (INSERT ... ON CONFLICT)
        [{ last_value: '1' }], // id_sequences UPDATE
        [{ id: TRAINER_ID }]);
        // pool.query for INSERT invite_codes uses the default mock (returns [])
        const res = await (0, supertest_1.default)(app)
            .post('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ type: 'staff', name: 'New Trainer' });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.code).toHaveLength(8);
        expect(res.body.data.type).toBe('staff');
    });
    it('401: unauthenticated', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/invites')
            .send({ type: 'staff', name: 'T' });
        expect(res.status).toBe(401);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// GET /api/invites
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/invites', () => {
    it('200: returns active invite codes', async () => {
        q([{ is_blocked: false }], [
            { code: 'ABCD1234', type: 'staff', display_id: 'RCV-S-0000001', placeholder_name: 'Test Staff', trainer_role: 'staff', expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: new Date().toISOString() },
        ]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data[0].code).toBe('ABCD1234');
    });
    it('200: empty list when no active codes', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/invites')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });
    it('401: unauthenticated', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/invites');
        expect(res.status).toBe(401);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// GET /api/invites/:code — public validation endpoint
// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/invites/:code', () => {
    it('200: valid code returns invite info', async () => {
        q([{
                code: 'ABCD1234',
                type: 'staff',
                display_id: 'RCV-S-0000001',
                trainer_role: 'staff',
                gym_name: 'Test Gym',
                placeholder_name: 'New Staff',
                used_at: null,
                expires_at: new Date(Date.now() + 86400000).toISOString(),
            }]);
        const res = await (0, supertest_1.default)(app).get('/api/invites/ABCD1234');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.code).toBe('ABCD1234');
        expect(res.body.data.type).toBe('staff');
        expect(res.body.data.gym_name).toBe('Test Gym');
    });
    it('404: invalid or expired code', async () => {
        q([]); // no row found
        const res = await (0, supertest_1.default)(app).get('/api/invites/BADCODE1');
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/invalid or expired/i);
    });
    // Code is uppercased before lookup — test that lowercase input also works
    it('200: lowercase code is uppercased before lookup', async () => {
        q([{
                code: 'ABCD1234', type: 'member', display_id: 'RCV-M-0000001',
                trainer_role: null, gym_name: 'Test Gym', placeholder_name: 'New Member',
            }]);
        const res = await (0, supertest_1.default)(app).get('/api/invites/abcd1234');
        expect(res.status).toBe(200);
    });
});
// ════════════════════════════════════════════════════════════════════════════
// POST /api/auth/staff/register
// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/auth/staff/register', () => {
    it('400: missing required fields', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/staff/register')
            .send({ code: 'ABCD1234', name: 'Staff' }); // missing email, phone, password
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
    it('400: invalid or expired invite code', async () => {
        q([]); // no invite found
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/staff/register')
            .send({ code: 'BADCODE1', name: 'Staff', email: 's@gym.com', phone: '9999999999', password: 'Test@1234' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid or expired/i);
    });
    it('201: valid invite creates account and returns tokens', async () => {
        q(
        // invite code lookup
        [{ id: 'inv-1', code: 'VALIDCOD', type: 'staff', gym_id: GYM_ID, trainer_id: TRAINER_ID, trainer_role: 'staff', display_id: 'RCV-S-0000001' }], 
        // email check → not taken
        [], 
        // BEGIN → default mock
        // INSERT users
        [{ id: USER_ID, gym_id: GYM_ID, role: 'trainer' }], 
        // UPDATE trainers (activate slot)
        [{ id: TRAINER_ID }], 
        // UPDATE invite_codes (mark used)
        [{ id: 'inv-1' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/staff/register')
            .send({ code: 'VALIDCOD', name: 'New Staff', email: 'staff@gym.com', phone: '9876543210', password: 'Test@1234' });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.accessToken).toBeDefined();
        expect(res.body.data.refreshToken).toBeDefined();
        expect(res.body.data.user.role).toBe('trainer');
    });
    it('409: email already registered returns 409', async () => {
        q(
        // invite code found
        [{ id: 'inv-1', code: 'VALIDCOD', type: 'staff', gym_id: GYM_ID, trainer_id: TRAINER_ID, trainer_role: 'staff', display_id: 'RCV-S-0000001' }], 
        // email check → already taken
        [{ id: 'user-existing' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/auth/staff/register')
            .send({ code: 'VALIDCOD', name: 'New Staff', email: 'existing@gym.com', phone: '9876543210', password: 'Test@1234' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already registered/i);
    });
});
//# sourceMappingURL=invite_codes.test.js.map