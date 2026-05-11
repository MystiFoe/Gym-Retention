"use strict";
/**
 * Trainers API Tests
 * POST   /api/trainers
 * GET    /api/trainers
 * GET    /api/trainers/me
 * PATCH  /api/trainers/:id
 * DELETE /api/trainers/:id
 * POST   /api/trainers/:id/assign-members
 * POST   /api/trainers/bulk-import
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
const TRAINER_ID = 'cccccccc-0000-0000-0000-000000000003';
const TRAINER_UID = 'dddddddd-0000-0000-0000-000000000004';
const MEMBER_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const OWNER_TOKEN = jsonwebtoken_1.default.sign({ id: USER_ID, gym_id: GYM_ID, role: 'owner' }, JWT_SECRET, { expiresIn: '1h' });
const TRAINER_TOKEN = jsonwebtoken_1.default.sign({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' }, JWT_SECRET, { expiresIn: '1h' });
const MEMBER_TOKEN = jsonwebtoken_1.default.sign({ id: 'mem-uid', gym_id: GYM_ID, role: 'member' }, JWT_SECRET, { expiresIn: '1h' });
const VALID_TRAINER_BODY = {
    name: 'Jane Trainer',
    phone: '9876543210',
    email: 'jane@gym.com',
    password: 'Trainer@123',
};
const MOCK_TRAINER_ROW = {
    id: TRAINER_ID, name: 'Jane Trainer', phone: '9876543210', email: 'jane@gym.com',
    created_at: new Date().toISOString(), display_id: 'RCV-S-0000001', trainer_role: 'staff',
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
// POST /api/trainers
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/trainers', () => {
    it('201: owner creates trainer successfully', async () => {
        q([{ is_blocked: false }], // authenticate gym block
        [], // email check → not taken
        [], // BEGIN
        [{ id: USER_ID }], // INSERT users RETURNING id
        [], // generateDisplayId INSERT id_sequences (default)
        [{ last_value: '1' }], // generateDisplayId UPDATE RETURNING last_value
        [MOCK_TRAINER_ROW]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_TRAINER_BODY);
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('Jane Trainer');
        expect(res.body.data.display_id).toBe('RCV-S-0000001');
    });
    it('400: missing required fields returns 400 with error details', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Jane' }); // missing phone, email, password
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
    it('400: weak password fails Zod validation', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ ...VALID_TRAINER_BODY, password: 'weakpassword' });
        expect(res.status).toBe(400);
    });
    it('400: invalid email format fails Zod validation', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ ...VALID_TRAINER_BODY, email: 'not-an-email' });
        expect(res.status).toBe(400);
    });
    it('409: duplicate email returns 409', async () => {
        q([{ is_blocked: false }], [{ id: 'existing-user' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send(VALID_TRAINER_BODY);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already registered/i);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).post('/api/trainers').send(VALID_TRAINER_BODY);
        expect(res.status).toBe(401);
    });
    it('403: member role cannot create trainers', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`)
            .send(VALID_TRAINER_BODY);
        expect(res.status).toBe(403);
    });
    it('403: trainer (non-admin) cannot create trainers', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send(VALID_TRAINER_BODY);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// GET /api/trainers
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/trainers', () => {
    it('200: owner gets paginated trainer list', async () => {
        q([{ is_blocked: false }], [{ total: '2' }], [
            { ...MOCK_TRAINER_ROW, login_email: 'jane@gym.com', assigned_members_count: 3, is_active: true },
            { ...MOCK_TRAINER_ROW, id: 't-2', name: 'Bob', login_email: 'bob@gym.com', assigned_members_count: 1 },
        ]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers?page=1&limit=10')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.trainers).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
        expect(res.body.data.page).toBe(1);
    });
    it('200: empty list when no trainers registered', async () => {
        q([{ is_blocked: false }], [{ total: '0' }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.trainers).toEqual([]);
        expect(res.body.data.total).toBe(0);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/trainers');
        expect(res.status).toBe(401);
    });
    it('403: trainer role cannot list all trainers', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// GET /api/trainers/me
// ══════════════════════════════════════════════════════════════════════
describe('GET /api/trainers/me', () => {
    it('200: trainer gets own profile', async () => {
        q([{ is_blocked: false }], [{ id: TRAINER_ID, name: 'Jane Trainer', phone: '9876543210', email: 'jane@gym.com' }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers/me')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.id).toBe(TRAINER_ID);
        expect(res.body.data.name).toBe('Jane Trainer');
    });
    it('404: trainer profile not found returns 404', async () => {
        q([{ is_blocked: false }], []);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers/me')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });
    it('403: owner cannot access /trainers/me', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .get('/api/trainers/me')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(403);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).get('/api/trainers/me');
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// PATCH /api/trainers/:id
// ══════════════════════════════════════════════════════════════════════
describe('PATCH /api/trainers/:id', () => {
    it('200: owner updates trainer name and phone', async () => {
        q([{ is_blocked: false }], [], // BEGIN
        [{ id: TRAINER_ID, name: 'Updated Name', phone: '1234567890', email: 'jane@gym.com', assigned_members_count: 2, is_active: true, created_at: new Date() }]);
        const res = await (0, supertest_1.default)(app)
            .patch(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Updated Name', phone: '1234567890' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.name).toBe('Updated Name');
    });
    it('200: owner updates trainer with new email', async () => {
        q([{ is_blocked: false }], [], // BEGIN
        [{ id: USER_ID }], // SELECT user from trainer join
        [], // check email not taken by another user
        [], // UPDATE users SET phone_or_email
        [{ id: TRAINER_ID, name: 'Jane', phone: '9876543210', email: 'newemail@gym.com', assigned_members_count: 0, is_active: true, created_at: new Date() }]);
        const res = await (0, supertest_1.default)(app)
            .patch(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Jane', phone: '9876543210', email: 'newemail@gym.com' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
    it('400: missing name returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .patch(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ phone: '9876543210' });
        expect(res.status).toBe(400);
    });
    it('404: trainer not found in gym returns 404', async () => {
        q([{ is_blocked: false }], 
        // BEGIN default
        []);
        const res = await (0, supertest_1.default)(app)
            .patch(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Nobody', phone: '9876543210' });
        expect(res.status).toBe(404);
    });
    it('409: new email already in use', async () => {
        q([{ is_blocked: false }], [], // BEGIN
        [{ id: USER_ID }], // SELECT user from trainer
        [{ id: 'other-user-id' }]);
        const res = await (0, supertest_1.default)(app)
            .patch(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ name: 'Jane', phone: '9876543210', email: 'taken@gym.com' });
        expect(res.status).toBe(409);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).patch(`/api/trainers/${TRAINER_ID}`).send({ name: 'X', phone: '1234567890' });
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// DELETE /api/trainers/:id
// ══════════════════════════════════════════════════════════════════════
describe('DELETE /api/trainers/:id', () => {
    it('200: owner soft-deletes trainer and marks user deleted', async () => {
        q([{ is_blocked: false }], [{ user_id: USER_ID }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.id).toBe(TRAINER_ID);
    });
    it('200: trainer not in gym still returns 200 (idempotent delete)', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).delete(`/api/trainers/${TRAINER_ID}`);
        expect(res.status).toBe(401);
    });
    it('403: trainer cannot delete other trainers', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .delete(`/api/trainers/${TRAINER_ID}`)
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(403);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/trainers/:id/assign-members
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/trainers/:id/assign-members', () => {
    it('200: assigns members to trainer and returns real count', async () => {
        q([{ is_blocked: false }], [], // BEGIN
        [{ id: TRAINER_ID }], // trainer check
        [], // UPDATE unassign non-listed
        [], // UPDATE assign selected
        [{ count: '2' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/trainers/${TRAINER_ID}/assign-members`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_ids: [MEMBER_ID, 'mem-2'] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.trainer_id).toBe(TRAINER_ID);
        expect(res.body.data.assigned_count).toBe(2);
    });
    it('200: empty member_ids unassigns all members', async () => {
        q([{ is_blocked: false }], [], // BEGIN
        [{ id: TRAINER_ID }], [], // UPDATE unassign ALL
        // no assign step for empty array
        [{ count: '0' }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/trainers/${TRAINER_ID}/assign-members`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_ids: [] });
        expect(res.status).toBe(200);
        expect(res.body.data.assigned_count).toBe(0);
    });
    it('400: member_ids not an array returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/trainers/${TRAINER_ID}/assign-members`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_ids: 'not-an-array' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be an array/i);
    });
    it('404: trainer not found returns 404', async () => {
        q([{ is_blocked: false }], 
        // BEGIN default
        []);
        const res = await (0, supertest_1.default)(app)
            .post(`/api/trainers/${TRAINER_ID}/assign-members`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ member_ids: [] });
        expect(res.status).toBe(404);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app)
            .post(`/api/trainers/${TRAINER_ID}/assign-members`)
            .send({ member_ids: [] });
        expect(res.status).toBe(401);
    });
});
// ══════════════════════════════════════════════════════════════════════
// POST /api/trainers/bulk-import
// ══════════════════════════════════════════════════════════════════════
describe('POST /api/trainers/bulk-import', () => {
    it('200: imports trainers, skips duplicates', async () => {
        // Trainer 1: new → email check empty → BEGIN → INSERT users → INSERT trainers → COMMIT
        // Trainer 2: duplicate → email check finds existing
        q([{ is_blocked: false }], [], // T1 email check → not taken
        [], // BEGIN
        [{ id: 'u-1' }], // INSERT users T1
        // INSERT trainers T1 uses base default (no RETURNING)
        // COMMIT uses base default
        [{ id: 'u-existing' }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({
            trainers: [
                { name: 'Trainer One', phone: '9000000001', email: 'one@gym.com' },
                { name: 'Trainer Two', phone: '9000000002', email: 'existing@gym.com' },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.imported).toBe(1);
        expect(res.body.data.skipped).toBe(1);
        expect(res.body.data.errors).toHaveLength(1);
        expect(res.body.data.defaultPassword).toBe('Gym@1234');
    });
    it('400: empty trainers array fails Zod validation', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({ trainers: [] });
        expect(res.status).toBe(400);
    });
    it('400: missing trainers field returns 400', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers/bulk-import')
            .set('Authorization', `Bearer ${OWNER_TOKEN}`)
            .send({});
        expect(res.status).toBe(400);
    });
    it('401: unauthenticated returns 401', async () => {
        const res = await (0, supertest_1.default)(app).post('/api/trainers/bulk-import').send({ trainers: [] });
        expect(res.status).toBe(401);
    });
    it('403: trainer role cannot bulk import', async () => {
        q([{ is_blocked: false }]);
        const res = await (0, supertest_1.default)(app)
            .post('/api/trainers/bulk-import')
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`)
            .send({ trainers: [{ name: 'X', phone: '9999999999', email: 'x@g.com' }] });
        expect(res.status).toBe(403);
    });
});
//# sourceMappingURL=trainers.test.js.map