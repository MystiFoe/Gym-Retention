"use strict";
/**
 * Biometric & QR Attendance API Tests
 * POST   /api/biometric/devices
 * GET    /api/biometric/devices
 * DELETE /api/biometric/devices/:id
 * GET    /api/biometric/mappings
 * PUT    /api/biometric/mappings
 * POST   /api/attendance/qr
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
const DEVICE_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jsonwebtoken_1.default.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: 'mem-uid', gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '1h' });
const MOCK_DEVICE = {
    id: DEVICE_ID, serial_number: 'ZK001', device_name: 'Main Entrance',
    last_seen_at: null, is_active: true, created_at: new Date().toISOString(),
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
// POST /api/biometric/devices
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/biometric/devices', () => {
    it('201: registers a biometric device', async () => {
        q([{ is_blocked: false }], [MOCK_DEVICE]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/biometric/devices')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ serial_number: 'ZK001', device_name: 'Main Entrance' });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.serial_number).toBe('ZK001');
    });
    it('201: registers device without device_name (optional)', async () => {
        q([{ is_blocked: false }], [{ ...MOCK_DEVICE, device_name: null }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/biometric/devices')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ serial_number: 'ZK002' });
        expect(res.status).toBe(201);
    });
    it('400: missing serial_number returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/biometric/devices')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ device_name: 'Front Door' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/serial_number/i);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/biometric/devices')
            .send({ serial_number: 'ZK001' });
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot register devices', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/biometric/devices')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send({ serial_number: 'ZK001' });
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// GET /api/biometric/devices
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/biometric/devices', () => {
    it('200: returns list of registered devices', async () => {
        q([{ is_blocked: false }], [MOCK_DEVICE, { ...MOCK_DEVICE, id: 'dev-2', serial_number: 'ZK002' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/devices')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
    });
    it('200: empty list when no devices registered', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/devices')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/biometric/devices');
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot list devices', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/devices')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// DELETE /api/biometric/devices/:id
// ══════════════════════════════════════════════════════════════════════
describe('DELETE /api/biometric/devices/:id', () => {
    it('200: deletes a biometric device', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/biometric/devices/${DEVICE_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).delete(`/api/biometric/devices/${DEVICE_ID}`);
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot delete devices', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/biometric/devices/${DEVICE_ID}`)
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// GET /api/biometric/mappings
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/biometric/mappings', () => {
    it('200: returns all mappings for gym', async () => {
        q([{ is_blocked: false }], [
            { id: 'map-1', serial_number: 'ZK001', device_user_id: '1', member_id: MEMBER_ID, member_name: 'Alice', member_phone: '9876543210' },
            { id: 'map-2', serial_number: 'ZK001', device_user_id: '2', member_id: null, member_name: null, member_phone: null },
        ]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/mappings')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveLength(2);
    });
    it('200: filters by serial number query param', async () => {
        q([{ is_blocked: false }], [{ id: 'map-1', serial_number: 'ZK001', device_user_id: '1', member_id: MEMBER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/mappings?serial=ZK001')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/biometric/mappings');
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot list mappings', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/biometric/mappings')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// PUT /api/biometric/mappings
// ══════════════════════════════════════════════════════════════════════
describe('PUT /api/biometric/mappings', () => {
    it('200: maps a device user to a member', async () => {
        q([{ is_blocked: false }], [{ id: 'map-1', gym_id: GYM_ID, serial_number: 'ZK001', device_user_id: '5', member_id: MEMBER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .put('/api/biometric/mappings')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ serial_number: 'ZK001', device_user_id: '5', member_id: MEMBER_ID });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.member_id).toBe(MEMBER_ID);
    });
    it('200: clears a mapping by setting member_id to null', async () => {
        q([{ is_blocked: false }], [{ id: 'map-1', gym_id: GYM_ID, serial_number: 'ZK001', device_user_id: '5', member_id: null }]);
        const res = await (0, supertest_1.default)(app)
            .put('/api/biometric/mappings')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ serial_number: 'ZK001', device_user_id: '5' });
        expect(res.status).toBe(200);
        expect(res.body.data.member_id).toBeNull();
    });
    it('400: missing serial_number returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .put('/api/biometric/mappings')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ device_user_id: '5', member_id: MEMBER_ID });
        expect(res.status).toBe(400);
    });
    it('400: missing device_user_id returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .put('/api/biometric/mappings')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ serial_number: 'ZK001', member_id: MEMBER_ID });
        expect(res.status).toBe(400);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .put('/api/biometric/mappings')
            .send({ serial_number: 'ZK001', device_user_id: '1' });
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/attendance/qr
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/attendance/qr', () => {
    it('200: marks attendance for member via QR scan', async () => {
        q([{ is_blocked: false }], [{ id: MEMBER_ID, name: 'Alice' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toMatch(/Alice/);
        expect(res.body.data.member_name).toBe('Alice');
    });
    it('200: trainer can also scan QR', async () => {
        q([{ is_blocked: false }], [{ id: MEMBER_ID, name: 'Bob' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(200);
        expect(res.body.data.member_name).toBe('Bob');
    });
    it('400: missing member_id returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/member_id/i);
    });
    it('404: member not found returns 404', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(401);
    });
    it('403: member role cannot scan QR', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/attendance/qr')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
            .send({ member_id: MEMBER_ID });
        expect(res.status).toBe(403);
    });
});
//# sourceMappingURL=biometric.test.js.map