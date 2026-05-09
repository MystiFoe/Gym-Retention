"use strict";
/**
 * Member Attendance Calendar API Tests
 * Endpoint: GET /api/members/:memberId/attendance?month=YYYY-MM
 *
 * Run from backend/ directory:
 *   node node_modules/jest/bin/jest.js --testPathPattern=member_attendance --forceExit --no-coverage
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ─── Environment variables MUST be set before any imports ────────────────────
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test_jwt_secret_must_be_at_least_32_chars_ok';
process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_must_be_32_chars_ok!!';
process.env.CORS_ORIGIN = '*';
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // bind to random port
// ─── Mock @sentry/node first — it pulls in @fastify/otel which has broken ────
// sub-dependencies in this environment. Stub just what server.ts uses.
jest.mock('@sentry/node', () => ({
    init: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
}));
// ─── Mock pg — attach the shared query mock to the Pool constructor so we ────
// can retrieve it after the factory runs (avoids hoisting TDZ issues).
jest.mock('pg', () => {
    const mockQuery = jest.fn();
    const MockPool = jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockImplementation(() => Promise.resolve({ query: mockQuery, release: jest.fn() })),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn(),
        on: jest.fn(), // pool.on('error', ...) in server.ts
    }));
    MockPool._query = mockQuery; // store for retrieval in tests
    return { Pool: MockPool };
});
// ─── Silence other side-effect modules ───────────────────────────────────────
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('nodemailer', () => ({
    createTransport: jest.fn().mockReturnValue({ sendMail: jest.fn().mockResolvedValue({}) }),
}));
jest.mock('razorpay', () => jest.fn().mockImplementation(() => ({})));
jest.mock('prom-client', () => ({
    collectDefaultMetrics: jest.fn(),
    register: {
        contentType: 'text/plain',
        metrics: jest.fn().mockResolvedValue(''),
        registerMetric: jest.fn(),
        clear: jest.fn(),
    },
    Registry: jest.fn().mockImplementation(() => ({
        registerMetric: jest.fn(),
        contentType: 'text/plain',
        metrics: jest.fn().mockResolvedValue(''),
        clear: jest.fn(),
    })),
    Histogram: jest.fn().mockImplementation(() => ({ observe: jest.fn() })),
    Counter: jest.fn().mockImplementation(() => ({ inc: jest.fn() })),
    Gauge: jest.fn().mockImplementation(() => ({ set: jest.fn(), inc: jest.fn() })),
}));
// ─── Now safe to import test utilities ───────────────────────────────────────
const supertest_1 = __importDefault(require("supertest"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
// ─── Constants ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const GYM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEMBER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const TRAINER_UID = 'cccccccc-0000-0000-0000-000000000003';
const TRAINER_ID = 'dddddddd-0000-0000-0000-000000000004';
function makeToken(payload) {
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}
const OWNER_TOKEN = makeToken({ id: 'user-owner', gym_id: GYM_ID, role: 'owner' });
const TRAINER_TOKEN = makeToken({ id: TRAINER_UID, gym_id: GYM_ID, role: 'trainer' });
const MEMBER_TOKEN = makeToken({ id: 'user-member', gym_id: GYM_ID, role: 'member' });
const MOCK_MEMBER = {
    id: MEMBER_ID,
    name: 'Arjun Kumar',
    phone: '9876543210',
    email: 'arjun@example.com',
    status: 'active',
    plan_fee: '1500',
    membership_expiry_date: '2026-12-31',
    last_visit_date: '2026-04-10',
    created_at: '2026-01-01T00:00:00.000Z',
    assigned_trainer_id: null,
};
// ─── App + mock references (populated in beforeAll) ───────────────────────────
let app;
let mockQuery;
beforeAll(() => {
    // Require server after all mocks are registered
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../server');
    app = mod.default;
    // Retrieve the shared query mock that the pg factory attached to Pool
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = jest.requireMock('pg');
    mockQuery = Pool._query;
});
afterEach(() => {
    // Reset queued responses; Pool.connect still returns { query: mockQuery } via factory closure
    mockQuery.mockReset();
});
// ─── Helper: queue multiple DB result sets in call order ─────────────────────
function setupQueries(...rowSets) {
    for (const rows of rowSets) {
        mockQuery.mockResolvedValueOnce({ rows });
    }
}
// ─── Tests ────────────────────────────────────────────────────────────────────
describe('GET /api/members/:memberId/attendance', () => {
    // 1 ── Owner gets member details + present dates ────────────────────────────
    it('200: returns member + present_dates for owner', async () => {
        setupQueries([MOCK_MEMBER], [{ visit_date: '2026-04-05' }, { visit_date: '2026-04-10' }, { visit_date: '2026-04-14' }]);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.member.id).toBe(MEMBER_ID);
        expect(res.body.data.member.name).toBe('Arjun Kumar');
        expect(res.body.data.present_dates).toEqual(['2026-04-05', '2026-04-10', '2026-04-14']);
        expect(res.body.data.month).toBe('2026-04');
    });
    // 2 ── No attendance this month → empty array ──────────────────────────────
    it('200: returns empty present_dates when member has no attendance', async () => {
        setupQueries([MOCK_MEMBER], []);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-02`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.present_dates).toEqual([]);
        expect(res.body.data.month).toBe('2026-02');
    });
    // 3 ── Member not in gym → 404 ─────────────────────────────────────────────
    it('404: member does not exist in the gym', async () => {
        setupQueries([]); // empty member result
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/nonexistent-id/attendance?month=2026-04`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not found/i);
    });
    // 4 ── No token → 401 ──────────────────────────────────────────────────────
    it('401: unauthenticated request is rejected', async () => {
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`);
        expect(res.status).toBe(401);
    });
    // 5 ── Bad token → 401 ─────────────────────────────────────────────────────
    it('401: malformed JWT token is rejected', async () => {
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`)
            .set('Authorization', 'Bearer this.is.garbage');
        expect(res.status).toBe(401);
    });
    // 6 ── Member role → 403 ───────────────────────────────────────────────────
    it('403: member role is not authorised', async () => {
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`)
            .set('Authorization', `Bearer ${MEMBER_TOKEN}`);
        expect(res.status).toBe(403);
    });
    // 7 ── Trainer can access their assigned member ────────────────────────────
    it('200: trainer can view their assigned member attendance', async () => {
        setupQueries([{ id: TRAINER_ID }], // trainer profile lookup
        [{ ...MOCK_MEMBER, assigned_trainer_id: TRAINER_ID }], // member
        [{ visit_date: '2026-04-07' }] // attendance
        );
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`)
            .set('Authorization', `Bearer ${TRAINER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.present_dates).toEqual(['2026-04-07']);
        expect(res.body.data.member.name).toBe('Arjun Kumar');
    });
    // 8 ── Missing month param → defaults to current month ────────────────────
    it('200: defaults to current month when month param is omitted', async () => {
        const now = new Date();
        const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        setupQueries([MOCK_MEMBER], []);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.month).toBe(expected);
    });
    // 9 ── Invalid month format → falls back to current month ─────────────────
    it('200: invalid month format falls back to current month', async () => {
        const now = new Date();
        const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        setupQueries([MOCK_MEMBER], []);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=not-a-month`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        expect(res.body.data.month).toBe(expected);
    });
    // 10 ── Response shape has all required fields ─────────────────────────────
    it('200: response shape contains all required member fields', async () => {
        setupQueries([MOCK_MEMBER], []);
        const res = await (0, supertest_1.default)(app)
            .get(`/api/members/${MEMBER_ID}/attendance?month=2026-04`)
            .set('Authorization', `Bearer ${OWNER_TOKEN}`);
        expect(res.status).toBe(200);
        const { member, present_dates, month } = res.body.data;
        expect(member).toMatchObject({
            id: expect.any(String),
            name: expect.any(String),
            phone: expect.any(String),
            email: expect.any(String),
            status: expect.any(String),
        });
        expect(Array.isArray(present_dates)).toBe(true);
        expect(typeof month).toBe('string');
        expect(month).toMatch(/^\d{4}-\d{2}$/);
    });
});
//# sourceMappingURL=member_attendance.test.js.map