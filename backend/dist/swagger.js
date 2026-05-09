"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
const spec = (0, swagger_jsdoc_1.default)({
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'Recurva API',
            version: '2.0.0',
            description: `
**Customer retention platform for gyms** — multi-tenant SaaS with three roles.

## Roles
| Role | Token | Expiry | Notes |
|------|-------|--------|-------|
| \`owner\` | JWT (access + refresh) | 1h / 7d | Full access |
| \`trainer\` (staff) | JWT (access + refresh) | 1h / 7d | Access to assigned customers only |
| \`trainer\` (admin) | JWT with \`trainer_role: "admin"\` | 1h / 7d | Same access as owner except subscription/billing |
| \`member\` | JWT (access only — phone OTP) | 30d | Own profile, attendance, payments |

## ID Format
All entities have globally-unique display IDs generated on creation:
- Business: \`RCV-B-XXXXX\`
- Staff/Admin: \`RCV-S-XXXXXXX\`
- Member: \`RCV-M-XXXXXXX\`

## Staff/Member Onboarding
Owner generates an invite code → shares 8-char code → person self-registers with own credentials.

## How to authenticate
1. Call the relevant login endpoint.
2. Click **Authorize** (🔒) and enter: \`Bearer <access_token>\`.

## Admin endpoints
Use \`Authorization: Bearer <ADMIN_SECRET>\` (value from server \`.env\`).
      `.trim(),
        },
        servers: [
            { url: 'https://recurva.in', description: 'Production' },
            { url: 'http://localhost:3000', description: 'Local development' },
        ],
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Bearer token from login endpoint',
                },
                AdminSecret: {
                    type: 'http',
                    scheme: 'bearer',
                    description: 'Static ADMIN_SECRET (not a JWT)',
                },
            },
            schemas: {
                Uuid: { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
                Error: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        error: { type: 'string', example: 'Human-readable error message' },
                    },
                },
                TokenPair: {
                    type: 'object',
                    properties: {
                        access_token: { type: 'string' },
                        refresh_token: { type: 'string' },
                        user: {
                            type: 'object',
                            properties: {
                                id: { $ref: '#/components/schemas/Uuid' },
                                gym_id: { $ref: '#/components/schemas/Uuid' },
                                role: { type: 'string', enum: ['owner', 'trainer'] },
                                trainer_role: { type: 'string', enum: ['staff', 'admin'], description: 'Only present when role=trainer' },
                            },
                        },
                    },
                },
                InviteCode: {
                    type: 'object',
                    properties: {
                        code: { type: 'string', example: 'A7K3MP2Q', description: '8-char uppercase alphanumeric, single-use, 7-day expiry' },
                        display_id: { type: 'string', example: 'RCV-S-0000001', description: 'Pre-assigned unique ID for the new person' },
                        type: { type: 'string', enum: ['staff', 'member'] },
                        trainer_role: { type: 'string', enum: ['staff', 'admin'], nullable: true },
                        expires_in_days: { type: 'integer', example: 7 },
                        placeholder_name: { type: 'string', nullable: true, description: 'Optional name hint set by owner' },
                    },
                },
                InviteCodeInfo: {
                    type: 'object',
                    description: 'Public info returned when validating an invite code',
                    properties: {
                        code: { type: 'string' },
                        type: { type: 'string', enum: ['staff', 'member'] },
                        display_id: { type: 'string' },
                        trainer_role: { type: 'string', nullable: true },
                        gym_name: { type: 'string' },
                        placeholder_name: { type: 'string', nullable: true },
                    },
                },
                MemberToken: {
                    type: 'object',
                    properties: {
                        access_token: { type: 'string', description: '30-day JWT — no refresh token' },
                        member: {
                            type: 'object',
                            properties: {
                                id: { $ref: '#/components/schemas/Uuid' },
                                name: { type: 'string' },
                                gym_id: { $ref: '#/components/schemas/Uuid' },
                                gym_name: { type: 'string' },
                                role: { type: 'string', enum: ['member'] },
                            },
                        },
                    },
                },
                Member: {
                    type: 'object',
                    properties: {
                        id: { $ref: '#/components/schemas/Uuid' },
                        name: { type: 'string', example: 'Kishore R' },
                        phone: { type: 'string', example: '8783463233' },
                        email: { type: 'string', format: 'email' },
                        status: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] },
                        last_visit_date: { type: 'string', format: 'date', nullable: true },
                        membership_expiry_date: { type: 'string', format: 'date' },
                        plan_fee: { type: 'number', example: 7462 },
                        created_at: { type: 'string', format: 'date-time' },
                        assigned_trainer_id: { $ref: '#/components/schemas/Uuid', nullable: true },
                    },
                },
                Trainer: {
                    type: 'object',
                    properties: {
                        id: { $ref: '#/components/schemas/Uuid' },
                        name: { type: 'string' },
                        phone: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        assigned_members_count: { type: 'integer' },
                        is_active: { type: 'boolean' },
                        created_at: { type: 'string', format: 'date-time' },
                        login_email: { type: 'string', format: 'email', description: 'Email used to log in (may differ from contact email)' },
                    },
                },
                Task: {
                    type: 'object',
                    properties: {
                        id: { $ref: '#/components/schemas/Uuid' },
                        member_id: { $ref: '#/components/schemas/Uuid' },
                        task_type: { type: 'string', enum: ['call', 'renewal', 'check_in'] },
                        status: { type: 'string', enum: ['pending', 'completed'] },
                        outcome: { type: 'string', enum: ['called', 'not_reachable', 'coming_tomorrow', 'renewed', 'no_action'], nullable: true },
                        notes: { type: 'string', nullable: true },
                        created_at: { type: 'string', format: 'date-time' },
                        completed_at: { type: 'string', format: 'date-time', nullable: true },
                        assigned_trainer_id: { $ref: '#/components/schemas/Uuid', nullable: true },
                        member_name: { type: 'string' },
                        member_phone: { type: 'string' },
                        trainer_name: { type: 'string', nullable: true },
                    },
                },
                Payment: {
                    type: 'object',
                    properties: {
                        id: { $ref: '#/components/schemas/Uuid' },
                        amount: { type: 'integer', description: 'Paise (₹1 = 100 paise)', example: 746200 },
                        currency: { type: 'string', example: 'INR' },
                        status: { type: 'string', enum: ['pending', 'completed', 'failed'] },
                        payment_method: { type: 'string', nullable: true, example: 'upi' },
                        description: { type: 'string', nullable: true },
                        created_at: { type: 'string', format: 'date-time' },
                        member_name: { type: 'string', description: 'Owner-view only' },
                        member_phone: { type: 'string', description: 'Owner-view only' },
                    },
                },
                CustomerProfile: {
                    type: 'object',
                    properties: {
                        id: { $ref: '#/components/schemas/Uuid' },
                        name: { type: 'string' },
                        phone: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                        status: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] },
                        last_visit_date: { type: 'string', format: 'date', nullable: true },
                        membership_expiry_date: { type: 'string', format: 'date' },
                        plan_fee: { type: 'number' },
                        created_at: { type: 'string', format: 'date-time' },
                        gym_name: { type: 'string' },
                        gym_address: { type: 'string' },
                        gym_phone: { type: 'string' },
                        payment_enabled: { type: 'boolean', description: 'True when gym owner has set Razorpay keys' },
                    },
                },
            },
        },
        security: [{ BearerAuth: [] }],
        tags: [
            { name: 'System', description: 'Health check' },
            { name: 'Registration', description: '3-step gym onboarding (email OTP → phone OTP)' },
            { name: 'Auth', description: 'Login, token refresh, password reset' },
            { name: 'Members', description: 'Customer CRUD, export, GDPR erase' },
            { name: 'Trainers', description: 'Staff CRUD, member assignment' },
            { name: 'Tasks', description: 'Follow-up task management' },
            { name: 'Attendance', description: 'Visit marking and history' },
            { name: 'Profile', description: 'User and gym settings (owner / trainer)' },
            { name: 'Customer Portal', description: 'Self-service portal for members (role: member)' },
            { name: 'Payments', description: 'Razorpay gym membership payments (create → verify → history)' },
            { name: 'Subscription', description: 'Recurva platform billing (owner pays Recurva)' },
            { name: 'Dashboard', description: 'KPIs and revenue metrics' },
            { name: 'Admin', description: 'Super-admin operations (ADMIN_SECRET)' },
        ],
        paths: {
            // ── System ────────────────────────────────────────────────────────────────
            '/health': {
                get: {
                    tags: ['System'],
                    summary: 'Health check',
                    security: [],
                    responses: {
                        200: { description: 'Server is up', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, uptime: { type: 'number' } } } } } },
                    },
                },
            },
            // ── Registration ─────────────────────────────────────────────────────────
            '/api/gyms/register': {
                post: {
                    tags: ['Registration'],
                    summary: 'Step 1 — Submit gym details (sends email OTP)',
                    security: [],
                    requestBody: {
                        required: true,
                        content: { 'application/json': { schema: { type: 'object', required: ['gym_name', 'owner_name', 'phone', 'email', 'owner_password', 'owner_email'], properties: {
                                        gym_name: { type: 'string', minLength: 2, maxLength: 100 },
                                        owner_name: { type: 'string', minLength: 2 },
                                        phone: { type: 'string', example: '9876543210' },
                                        email: { type: 'string', format: 'email', description: 'Gym public email' },
                                        address: { type: 'string' },
                                        owner_password: { type: 'string', minLength: 8, description: 'Uppercase + digit + special character required' },
                                        owner_email: { type: 'string', format: 'email', description: 'Login email for the owner' },
                                    } } } },
                    },
                    responses: {
                        201: { description: 'Pending registration created; OTP sent to owner_email', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { pendingId: { type: 'string' }, ownerEmail: { type: 'string' }, gymPhone: { type: 'string' } } } } } } } },
                        409: { description: 'Email already registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/gyms/register/verify-email': {
                post: {
                    tags: ['Registration'],
                    summary: 'Step 2 — Verify email OTP',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['pending_id', 'otp_code'], properties: { pending_id: { type: 'string', format: 'uuid' }, otp_code: { type: 'string', minLength: 6, maxLength: 6, example: '482910' } } } } } },
                    responses: {
                        200: { description: 'Email verified; send Firebase phone OTP next' },
                        400: { description: 'Invalid or expired OTP', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/gyms/register/resend-email-otp': {
                post: {
                    tags: ['Registration'],
                    summary: 'Resend email OTP',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['pending_id'], properties: { pending_id: { type: 'string', format: 'uuid' } } } } } },
                    responses: { 200: { description: 'OTP resent' } },
                },
            },
            '/api/gyms/register/verify-phone': {
                post: {
                    tags: ['Registration'],
                    summary: 'Step 3 — Verify phone via Firebase; completes registration',
                    description: 'Creates the gym + owner user, starts 30-day trial, returns JWT.',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['pending_id', 'firebase_id_token'], properties: { pending_id: { type: 'string', format: 'uuid' }, firebase_id_token: { type: 'string' } } } } } },
                    responses: {
                        201: { description: 'Gym created, tokens issued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/TokenPair' } } } } } },
                    },
                },
            },
            // ── Auth ─────────────────────────────────────────────────────────────────
            '/api/auth/login': {
                post: {
                    tags: ['Auth'],
                    summary: 'Email/phone + password login (owner or trainer)',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['phone_or_email', 'password', 'role'], properties: {
                                        phone_or_email: { type: 'string', example: 'owner@gym.com' },
                                        password: { type: 'string', example: 'Giri@123' },
                                        role: { type: 'string', enum: ['owner', 'trainer'] },
                                        gym_id: { type: 'string', format: 'uuid', description: 'Required when the same email is used across multiple gyms' },
                                    } } } } },
                    responses: {
                        200: { description: 'Login successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/TokenPair' } } } } } },
                        401: { description: 'Wrong password or user not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                        403: { description: 'Gym blocked', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/refresh': {
                post: {
                    tags: ['Auth'],
                    summary: 'Refresh access token',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } } } },
                    responses: {
                        200: { description: 'New token pair', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' } } } } } } } },
                        401: { description: 'Invalid or expired refresh token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/verify-firebase-token': {
                post: {
                    tags: ['Auth'],
                    summary: 'Phone OTP login (owner or trainer)',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token', 'role'], properties: { firebase_id_token: { type: 'string' }, role: { type: 'string', enum: ['owner', 'trainer'] } } } } } },
                    responses: {
                        200: { description: 'Login successful', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/TokenPair' } } } } } },
                        404: { description: 'No account with this phone number', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/customer/login': {
                post: {
                    tags: ['Auth'],
                    summary: 'Member login via phone OTP (Firebase) — issues 30-day token',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token'], properties: { firebase_id_token: { type: 'string' } } } } } },
                    responses: {
                        200: {
                            description: 'Single-gym: returns MemberToken. Multiple gyms: returns {multiple:true, gyms:[...], firebase_id_token} — call /auth/customer/select-gym to pick.',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberToken' } } },
                        },
                        404: { description: 'Phone not found in any gym', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/customer/select-gym': {
                post: {
                    tags: ['Auth'],
                    summary: 'Select one gym when member belongs to multiple',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token', 'member_id'], properties: { firebase_id_token: { type: 'string' }, member_id: { type: 'string', format: 'uuid' } } } } } },
                    responses: {
                        200: { description: 'Token issued for chosen gym', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/MemberToken' } } } } } },
                        403: { description: 'member_id does not match the phone in Firebase token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/forgot-password': {
                post: {
                    tags: ['Auth'],
                    summary: 'Request password reset (emails OTP; always 200)',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
                    responses: { 200: { description: 'OTP sent (or silently ignored to prevent email enumeration)' } },
                },
            },
            '/api/auth/verify-reset-otp': {
                post: {
                    tags: ['Auth'],
                    summary: 'Verify password reset OTP → receive reset token',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'otp_code'], properties: { email: { type: 'string', format: 'email' }, otp_code: { type: 'string', minLength: 6, maxLength: 6 } } } } } },
                    responses: {
                        200: { description: 'Reset token issued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { reset_token: { type: 'string' } } } } } } } },
                        400: { description: 'Invalid or expired OTP', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/reset-password': {
                post: {
                    tags: ['Auth'],
                    summary: 'Set a new password using the reset token',
                    security: [],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'new_password'], properties: { token: { type: 'string' }, new_password: { type: 'string', minLength: 8, description: 'Uppercase + digit + special char required' } } } } } },
                    responses: {
                        200: { description: 'Password updated successfully' },
                        400: { description: 'Invalid or expired token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/auth/fcm-token': {
                put: {
                    tags: ['Auth'],
                    summary: 'Register device FCM push token (mobile only)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['fcm_token'], properties: { fcm_token: { type: 'string' } } } } } },
                    responses: { 200: { description: 'Token saved' } },
                },
            },
            // ── Members ───────────────────────────────────────────────────────────────
            '/api/members': {
                get: {
                    tags: ['Members'],
                    summary: 'List members — owner sees all, trainer sees only their assigned members',
                    parameters: [
                        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
                        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
                        { in: 'query', name: 'status', schema: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] } },
                        { in: 'query', name: 'trainer_id', schema: { type: 'string', format: 'uuid' } },
                    ],
                    responses: {
                        200: { description: 'Paginated member list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: {
                                                    members: { type: 'array', items: { $ref: '#/components/schemas/Member' } },
                                                    total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' },
                                                } } } } } } },
                    },
                },
                post: {
                    tags: ['Members'],
                    summary: 'Add a new member',
                    description: 'If the same phone/email was previously deleted, the slot is automatically freed and the member is re-created.',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'phone', 'membership_expiry_date', 'plan_fee'], properties: {
                                        name: { type: 'string', minLength: 2, maxLength: 100 },
                                        phone: { type: 'string', example: '9876543210' },
                                        email: { type: 'string', format: 'email' },
                                        last_visit_date: { type: 'string', format: 'date' },
                                        membership_expiry_date: { type: 'string', format: 'date' },
                                        plan_fee: { type: 'number', minimum: 0 },
                                        assigned_trainer_id: { type: 'string', format: 'uuid' },
                                    } } } } },
                    responses: {
                        201: { description: 'Member created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Member' } } } } } },
                        409: { description: 'Active member with this phone or email already exists', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/members/export': {
                get: {
                    tags: ['Members'],
                    summary: 'Export all gym members as CSV',
                    responses: { 200: { description: 'CSV download', content: { 'text/csv': { schema: { type: 'string' } } } } },
                },
            },
            '/api/members/bulk-import': {
                post: {
                    tags: ['Members'],
                    summary: 'Bulk-import members from array (max 5 000)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { trainer_id: { type: 'string', format: 'uuid' }, members: { type: 'array', maxItems: 5000, items: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, plan_fee: { type: 'number' }, membership_expiry_date: { type: 'string' }, last_visit_date: { type: 'string' } } } } } } } } },
                    responses: { 200: { description: 'Import summary', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { imported: { type: 'integer' }, skipped: { type: 'integer' }, errors: { type: 'array', items: { type: 'object' } } } } } } } } } },
                },
            },
            '/api/members/{id}': {
                put: {
                    tags: ['Members'],
                    summary: 'Update member details',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, membership_expiry_date: { type: 'string', format: 'date' }, plan_fee: { type: 'number' } } } } } },
                    responses: { 200: { description: 'Updated' }, 404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
                },
                delete: {
                    tags: ['Members'],
                    summary: 'Soft-delete a member (hidden from app; data retained)',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Deleted' } },
                },
            },
            '/api/members/{id}/data': {
                delete: {
                    tags: ['Members'],
                    summary: 'GDPR erase — permanently destroy member PII',
                    description: '⚠️ Irreversible. Overwrites name/phone/email with `[deleted]` and hard-deletes attendance logs. Use only on explicit data-erasure requests.',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'PII erased' }, 404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
                },
            },
            // ── Trainers ─────────────────────────────────────────────────────────────
            '/api/trainers': {
                get: {
                    tags: ['Trainers'],
                    summary: 'List all staff members (owner only)',
                    parameters: [
                        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
                        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
                    ],
                    responses: { 200: { description: 'Trainer list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { trainers: { type: 'array', items: { $ref: '#/components/schemas/Trainer' } }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } } } } } } } } },
                },
                post: {
                    tags: ['Trainers'],
                    summary: 'Add a new staff member (creates login account)',
                    description: 'If the email was previously used by a deleted trainer, the slot is automatically freed.',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'phone', 'email', 'password'], properties: {
                                        name: { type: 'string', minLength: 2 },
                                        phone: { type: 'string' },
                                        email: { type: 'string', format: 'email' },
                                        password: { type: 'string', minLength: 8, description: 'Uppercase + digit + special char required' },
                                    } } } } },
                    responses: {
                        201: { description: 'Trainer created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Trainer' } } } } } },
                        409: { description: 'Email already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/trainers/me': {
                get: {
                    tags: ['Trainers'],
                    summary: "Logged-in trainer's profile (trainer role only)",
                    responses: { 200: { description: 'Trainer profile' } },
                },
            },
            '/api/trainers/bulk-import': {
                post: {
                    tags: ['Trainers'],
                    summary: 'Bulk-import staff members (max 200)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { trainers: { type: 'array', maxItems: 200, items: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } } } } } } },
                    responses: { 200: { description: 'Import summary' } },
                },
            },
            '/api/trainers/{id}': {
                patch: {
                    tags: ['Trainers'],
                    summary: 'Update trainer name, phone, or email',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', format: 'email' } } } } } },
                    responses: { 200: { description: 'Updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Trainer' } } } } } } },
                },
                delete: {
                    tags: ['Trainers'],
                    summary: 'Soft-delete trainer; email slot freed immediately for re-use',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Trainer deleted' } },
                },
            },
            '/api/trainers/{id}/assign-members': {
                post: {
                    tags: ['Trainers'],
                    summary: 'Assign members to a trainer',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_ids'], properties: { member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
                    responses: { 200: { description: 'Members assigned' } },
                },
            },
            // ── Tasks ─────────────────────────────────────────────────────────────────
            '/api/tasks': {
                get: {
                    tags: ['Tasks'],
                    summary: 'List tasks — owner sees all; trainer sees only theirs',
                    parameters: [
                        { in: 'query', name: 'status', schema: { type: 'string', enum: ['pending', 'completed'] } },
                        { in: 'query', name: 'trainer_id', schema: { type: 'string', format: 'uuid' } },
                        { in: 'query', name: 'member_id', schema: { type: 'string', format: 'uuid' } },
                        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
                        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 100 } },
                    ],
                    responses: { 200: { description: 'Paginated task list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { tasks: { type: 'array', items: { $ref: '#/components/schemas/Task' } }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } } } } } } } } },
                },
                post: {
                    tags: ['Tasks'],
                    summary: 'Create a follow-up task (auto-assigns to member\'s trainer)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_id', 'task_type'], properties: {
                                        member_id: { type: 'string', format: 'uuid' },
                                        task_type: { type: 'string', enum: ['call', 'renewal', 'check_in'] },
                                        assigned_trainer_id: { type: 'string', format: 'uuid', description: 'Defaults to member\'s assigned trainer' },
                                        notes: { type: 'string', maxLength: 500 },
                                    } } } } },
                    responses: { 201: { description: 'Task created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Task' } } } } } } },
                },
            },
            '/api/tasks/{id}': {
                patch: {
                    tags: ['Tasks'],
                    summary: 'Complete a task (trainer only)',
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['outcome'], properties: {
                                        outcome: { type: 'string', enum: ['called', 'not_reachable', 'coming_tomorrow', 'renewed', 'no_action'] },
                                        notes: { type: 'string' },
                                    } } } } },
                    responses: { 200: { description: 'Task completed' } },
                },
            },
            // ── Attendance ────────────────────────────────────────────────────────────
            '/api/attendance': {
                post: {
                    tags: ['Attendance'],
                    summary: 'Mark a member visit (owner or trainer)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_id', 'visit_date'], properties: { member_id: { type: 'string', format: 'uuid' }, visit_date: { type: 'string', format: 'date' }, check_in_time: { type: 'string', example: '09:30:00' } } } } } },
                    responses: { 200: { description: 'Attendance marked' } },
                },
                get: {
                    tags: ['Attendance'],
                    summary: 'List attendance records for a date',
                    parameters: [{ in: 'query', name: 'date', schema: { type: 'string', format: 'date', description: 'Defaults to today' } }],
                    responses: { 200: { description: 'Attendance list' } },
                },
            },
            '/api/members/{memberId}/attendance': {
                get: {
                    tags: ['Attendance'],
                    summary: "Member's monthly calendar — present/absent dates (owner/staff view)",
                    parameters: [
                        { in: 'path', name: 'memberId', required: true, schema: { $ref: '#/components/schemas/Uuid' } },
                        { in: 'query', name: 'month', schema: { type: 'string', example: '2026-05', description: 'YYYY-MM; defaults to current month' } },
                    ],
                    responses: { 200: { description: 'Calendar data', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { member: { $ref: '#/components/schemas/Member' }, present_dates: { type: 'array', items: { type: 'string', format: 'date' } }, month: { type: 'string' } } } } } } } } },
                },
            },
            // ── Profile ───────────────────────────────────────────────────────────────
            '/api/profile': {
                get: {
                    tags: ['Profile'],
                    summary: "Current user's profile (owner or trainer)",
                    responses: { 200: { description: 'Profile data including gym details for owners' } },
                },
                put: {
                    tags: ['Profile'],
                    summary: 'Update name, phone, email; optionally change password',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: {
                                        name: { type: 'string', minLength: 2, maxLength: 100 },
                                        phone: { type: 'string' },
                                        email: { type: 'string', format: 'email' },
                                        currentPassword: { type: 'string', description: 'Required if setting newPassword' },
                                        newPassword: { type: 'string', minLength: 6 },
                                    } } } } },
                    responses: { 200: { description: 'Updated' }, 400: { description: 'Incorrect current password', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
                },
            },
            '/api/profile/verify-phone': {
                post: {
                    tags: ['Profile'],
                    summary: 'Verify owner/trainer phone via Firebase OTP',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token'], properties: { firebase_id_token: { type: 'string' } } } } } },
                    responses: { 200: { description: 'Phone verified', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { message: { type: 'string' }, phone: { type: 'string' } } } } } } } } },
                },
            },
            '/api/gyms/me': {
                put: {
                    tags: ['Profile'],
                    summary: 'Update gym name, address, phone, and Razorpay payment keys',
                    description: 'Razorpay key_secret is write-only and never returned in any response.',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['gymName'], properties: {
                                        gymName: { type: 'string', minLength: 2, maxLength: 100 },
                                        address: { type: 'string' },
                                        phone: { type: 'string' },
                                        razorpay_key_id: { type: 'string', example: 'rzp_live_xxxxxxxx', description: 'Publishable key from Razorpay dashboard' },
                                        razorpay_key_secret: { type: 'string', description: 'Secret key — stored server-side only' },
                                    } } } } },
                    responses: { 200: { description: 'Gym settings updated' } },
                },
            },
            // ── Customer Portal ───────────────────────────────────────────────────────
            '/api/customer/profile': {
                get: {
                    tags: ['Customer Portal'],
                    summary: "Member's own profile + gym info",
                    responses: { 200: { description: 'Profile', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/CustomerProfile' } } } } } } },
                },
                put: {
                    tags: ['Customer Portal'],
                    summary: 'Update name and/or email (phone cannot be changed — it is the login credential)',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' } } } } } },
                    responses: { 200: { description: 'Profile updated' } },
                },
            },
            '/api/customer/attendance': {
                get: {
                    tags: ['Customer Portal'],
                    summary: "Member's own monthly attendance",
                    parameters: [
                        { in: 'query', name: 'year', schema: { type: 'integer', example: 2026 } },
                        { in: 'query', name: 'month', schema: { type: 'integer', minimum: 1, maximum: 12, example: 5 } },
                    ],
                    responses: { 200: { description: 'Attendance records', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object', properties: { date: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['present', 'absent'] } } } } } } } } } },
                },
            },
            '/api/customer/payments': {
                get: {
                    tags: ['Customer Portal'],
                    summary: "Member's own payment history",
                    parameters: [
                        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
                        { in: 'query', name: 'limit', schema: { type: 'integer', default: 20, maximum: 50 } },
                    ],
                    responses: { 200: { description: 'Payment history', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } }, total: { type: 'integer' } } } } } } } } },
                },
            },
            // ── Payments ─────────────────────────────────────────────────────────────
            '/api/payments/create-order': {
                post: {
                    tags: ['Payments'],
                    summary: 'Create Razorpay order for gym membership renewal (member)',
                    description: 'Returns `order_id` and `key_id` to pass to the Razorpay Flutter SDK.',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: {
                                        amount: { type: 'number', minimum: 1, example: 7462, description: 'Amount in rupees (not paise)' },
                                        description: { type: 'string', example: 'Monthly gym subscription' },
                                    } } } } },
                    responses: {
                        200: { description: 'Razorpay order ready', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: {
                                                    order_id: { type: 'string', example: 'order_ABC123' },
                                                    amount: { type: 'integer', example: 746200, description: 'Amount in paise' },
                                                    currency: { type: 'string', example: 'INR' },
                                                    key_id: { type: 'string', example: 'rzp_live_xxxxx', description: 'Pass as `key` to Razorpay SDK' },
                                                } } } } } } },
                        400: { description: 'Razorpay not configured for this gym — owner must set keys in gym settings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/payments/verify': {
                post: {
                    tags: ['Payments'],
                    summary: 'Verify Razorpay signature + record successful payment (member)',
                    description: 'Call this immediately in the Razorpay `onSuccess` callback. Verifies HMAC-SHA256 and marks payment `completed`.',
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'], properties: {
                                        razorpay_order_id: { type: 'string' },
                                        razorpay_payment_id: { type: 'string' },
                                        razorpay_signature: { type: 'string', description: 'HMAC-SHA256 from Razorpay success callback' },
                                    } } } } },
                    responses: {
                        200: { description: 'Payment verified', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { message: { type: 'string' }, payment_id: { type: 'string', format: 'uuid' } } } } } } } },
                        400: { description: 'Signature mismatch — payment rejected', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    },
                },
            },
            '/api/payments': {
                get: {
                    tags: ['Payments'],
                    summary: "All gym's completed payments (owner)",
                    parameters: [
                        { in: 'query', name: 'month', schema: { type: 'string', example: '2026-05', description: 'YYYY-MM filter' } },
                        { in: 'query', name: 'member_id', schema: { type: 'string', format: 'uuid' } },
                        { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
                        { in: 'query', name: 'limit', schema: { type: 'integer', default: 50, maximum: 100 } },
                    ],
                    responses: { 200: { description: 'Payment list with aggregate total', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: {
                                                    payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } },
                                                    total: { type: 'integer' },
                                                    total_amount: { type: 'integer', description: 'Sum of amounts in paise' },
                                                } } } } } } } },
                },
            },
            '/api/payments/report': {
                get: {
                    tags: ['Payments'],
                    summary: 'Download monthly payment report as CSV (owner)',
                    parameters: [{ in: 'query', name: 'month', schema: { type: 'string', example: '2026-05', description: 'YYYY-MM; defaults to current month' } }],
                    responses: {
                        200: {
                            description: 'CSV file',
                            content: { 'text/csv': { schema: { type: 'string', example: 'Member Name,Phone,Amount (Rs),Method,Description,Date\n"Kishore R",8783463233,7462.00,upi,,01-05-2026\n\nTOTAL,, 7462.00,,, 1 payments' } } },
                        },
                    },
                },
            },
            // ── Dashboard ─────────────────────────────────────────────────────────────
            '/api/dashboard/kpis': {
                get: {
                    tags: ['Dashboard'],
                    summary: 'Owner KPI summary — member counts by status and revenue',
                    responses: { 200: { description: 'KPI data', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: {
                                                    totalMembers: { type: 'integer' },
                                                    activeMembers: { type: 'integer' },
                                                    atRiskMembers: { type: 'integer' },
                                                    highRiskMembers: { type: 'integer' },
                                                    revenueRecovered: { type: 'number' },
                                                } } } } } } } },
                },
            },
            '/api/revenue': {
                get: {
                    tags: ['Dashboard'],
                    summary: 'Revenue tracking — monthly breakdown and metrics',
                    responses: { 200: { description: 'Revenue data' } },
                },
            },
            // ── Subscription ──────────────────────────────────────────────────────────
            '/api/gyms/{gymId}/subscription': {
                get: {
                    tags: ['Subscription'],
                    summary: "Recurva subscription status and available upgrade plans",
                    parameters: [{ in: 'path', name: 'gymId', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Subscription info', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: {
                                                    status: { type: 'string', enum: ['trial', 'active', 'expired'] },
                                                    daysRemaining: { type: 'integer' },
                                                    trialEndsAt: { type: 'string', format: 'date-time', nullable: true },
                                                    subscriptionEndsAt: { type: 'string', format: 'date-time', nullable: true },
                                                    plans: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, amountInPaise: { type: 'integer' }, months: { type: 'integer' } } } },
                                                } } } } } } } },
                },
            },
            '/api/gyms/{gymId}/billing/create-order': {
                post: {
                    tags: ['Subscription'],
                    summary: 'Create Razorpay order for Recurva subscription',
                    parameters: [{ in: 'path', name: 'gymId', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['plan'], properties: { plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] } } } } } },
                    responses: { 200: { description: 'Razorpay order created' } },
                },
            },
            '/api/gyms/{gymId}/billing/verify-payment': {
                post: {
                    tags: ['Subscription'],
                    summary: 'Verify Recurva subscription payment and activate plan',
                    parameters: [{ in: 'path', name: 'gymId', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature', 'plan'], properties: {
                                        razorpay_order_id: { type: 'string' },
                                        razorpay_payment_id: { type: 'string' },
                                        razorpay_signature: { type: 'string' },
                                        plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] },
                                    } } } } },
                    responses: { 200: { description: 'Subscription activated' }, 400: { description: 'Invalid signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
                },
            },
            // ── Admin ─────────────────────────────────────────────────────────────────
            '/api/admin/gyms': {
                get: {
                    tags: ['Admin'],
                    summary: 'List all gyms with metrics (admin only)',
                    security: [{ AdminSecret: [] }],
                    responses: { 200: { description: 'All gyms' }, 401: { description: 'Invalid admin secret', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
                },
            },
            '/api/admin/gyms/{id}/block': {
                post: {
                    tags: ['Admin'],
                    summary: 'Block a gym — all logins immediately rejected (even with valid JWT)',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
                    responses: { 200: { description: 'Gym blocked' } },
                },
            },
            '/api/admin/gyms/{id}/unblock': {
                post: {
                    tags: ['Admin'],
                    summary: 'Unblock a gym',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Gym unblocked' } },
                },
            },
            '/api/admin/gyms/{id}/suspend': {
                post: {
                    tags: ['Admin'],
                    summary: 'Suspend a gym (subscription expired)',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Gym suspended' } },
                },
            },
            '/api/admin/gyms/{id}/reactivate': {
                post: {
                    tags: ['Admin'],
                    summary: 'Reactivate a suspended gym',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Reactivated' } },
                },
            },
            '/api/admin/gyms/{id}/convert': {
                post: {
                    tags: ['Admin'],
                    summary: 'Manually activate subscription (admin override)',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['months'], properties: { months: { type: 'integer', minimum: 1, maximum: 12 } } } } } },
                    responses: { 200: { description: 'Subscription activated' } },
                },
            },
            '/api/admin/gyms/{id}': {
                delete: {
                    tags: ['Admin'],
                    summary: '⚠️ PERMANENTLY delete a gym and all its data',
                    description: 'Irreversible. Removes all members, trainers, tasks, attendance, revenue, billing and user accounts for the gym.',
                    security: [{ AdminSecret: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' } }],
                    responses: { 200: { description: 'Gym and all data permanently deleted' } },
                },
            },
            // ── Invite Codes ──────────────────────────────────────────────────────
            '/api/invites': {
                post: {
                    tags: ['Invites'],
                    summary: 'Generate an invite code for a new staff member or customer',
                    description: 'Owner or admin generates a one-time 8-character invite code. Staff invites create a pending trainer slot. Member invites reserve a display ID. Codes expire after 7 days and are single-use.',
                    security: [{ BearerAuth: [] }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['type'],
                                    properties: {
                                        type: { type: 'string', enum: ['staff', 'member'], description: 'Who this invite is for' },
                                        name: { type: 'string', description: 'Optional label (required for member invites)' },
                                        phone: { type: 'string', description: 'Optional phone hint (member invites)' },
                                        trainer_role: { type: 'string', enum: ['staff', 'admin'], default: 'staff', description: 'Role for staff invites' },
                                    },
                                },
                                examples: {
                                    staffInvite: { summary: 'Staff invite', value: { type: 'staff', name: 'John Trainer', trainer_role: 'staff' } },
                                    adminInvite: { summary: 'Admin invite', value: { type: 'staff', name: 'Jane Manager', trainer_role: 'admin' } },
                                    memberInvite: { summary: 'Member invite', value: { type: 'member', name: 'Alice Member', phone: '9876543210' } },
                                },
                            },
                        },
                    },
                    responses: {
                        201: { description: 'Invite code generated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/InviteCode' } } } } } },
                        400: { description: 'Missing required fields' },
                        401: { description: 'Unauthorized' },
                    },
                },
                get: {
                    tags: ['Invites'],
                    summary: 'List all active (unused, non-expired) invite codes for this gym',
                    security: [{ BearerAuth: [] }],
                    responses: {
                        200: { description: 'Array of active invite codes', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/InviteCode' } } } } } } },
                        401: { description: 'Unauthorized' },
                    },
                },
            },
            '/api/invites/{code}': {
                get: {
                    tags: ['Invites'],
                    summary: 'Validate an invite code — public, no auth required',
                    description: 'Returns invite details if the code is valid, unused and not expired. Used by the staff registration screen to show gym name and role before the person enters their details.',
                    parameters: [{ in: 'path', name: 'code', required: true, schema: { type: 'string', example: 'A7K3MP2Q' }, description: '8-char invite code (case-insensitive)' }],
                    responses: {
                        200: { description: 'Code is valid', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/InviteCodeInfo' } } } } } },
                        404: { description: 'Invalid, used or expired code' },
                    },
                },
            },
            // ── Staff Self-Registration ───────────────────────────────────────────
            '/api/auth/staff/register': {
                post: {
                    tags: ['Auth'],
                    summary: 'Staff self-registration using invite code — public',
                    description: 'Staff member enters an owner-generated invite code and sets their own name, email, phone and password. On success, returns a JWT pair and the person is immediately logged in. The invite code is consumed and cannot be reused.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['code', 'name', 'email', 'phone', 'password'],
                                    properties: {
                                        code: { type: 'string', example: 'A7K3MP2Q' },
                                        name: { type: 'string', example: 'John Trainer' },
                                        email: { type: 'string', format: 'email', example: 'john@example.com', description: 'Used as login identifier' },
                                        phone: { type: 'string', example: '9876543210' },
                                        password: { type: 'string', format: 'password', example: 'Trainer@123', description: 'Min 8 chars, 1 uppercase, 1 number, 1 special char' },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        201: {
                            description: 'Registration successful — JWT pair returned',
                            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/TokenPair' } } } } },
                        },
                        400: { description: 'Invalid/expired invite code or missing fields' },
                        409: { description: 'Email already registered in this gym' },
                    },
                },
            },
            // ── Member Invite Linking ─────────────────────────────────────────────
            '/api/auth/customer/link-invite': {
                post: {
                    tags: ['Customer Portal'],
                    summary: 'Link a member account via invite code — public',
                    description: 'Called when a member completes phone OTP but their number is not found in any gym. They enter the invite code provided by the gym owner to link their Firebase phone identity to the pre-created member record.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['firebase_id_token', 'code'],
                                    properties: {
                                        firebase_id_token: { type: 'string', description: 'Firebase ID token from phone OTP verification' },
                                        code: { type: 'string', example: 'B9MNQRST', description: '8-char member invite code' },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        200: { description: 'Account linked — member JWT returned', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/MemberToken' } } } } } },
                        400: { description: 'Invalid/expired invite code' },
                        401: { description: 'Invalid Firebase token' },
                        404: { description: 'No matching member record found' },
                    },
                },
            },
            // ── Trainer Role Management ───────────────────────────────────────────
            '/api/trainers/{id}/role': {
                put: {
                    tags: ['Trainers'],
                    summary: 'Promote or demote a trainer (owner only)',
                    description: 'Changes a trainer\'s role between `staff` and `admin`. Admin trainers get the same access as the owner for all management operations except subscription/billing/role changes. **Owner-only** — admin trainers cannot call this endpoint.',
                    security: [{ BearerAuth: [] }],
                    parameters: [{ in: 'path', name: 'id', required: true, schema: { $ref: '#/components/schemas/Uuid' }, description: 'Trainer ID' }],
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['trainer_role'],
                                    properties: {
                                        trainer_role: { type: 'string', enum: ['staff', 'admin'] },
                                    },
                                },
                                examples: {
                                    promote: { summary: 'Promote to admin', value: { trainer_role: 'admin' } },
                                    demote: { summary: 'Demote to staff', value: { trainer_role: 'staff' } },
                                },
                            },
                        },
                    },
                    responses: {
                        200: { description: 'Role updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { id: { $ref: '#/components/schemas/Uuid' }, trainer_role: { type: 'string' } } } } } } } },
                        400: { description: 'Invalid trainer_role value' },
                        403: { description: 'Owner-only operation' },
                        404: { description: 'Trainer not found' },
                    },
                },
            },
        },
    },
    apis: [],
});
exports.default = spec;
//# sourceMappingURL=swagger.js.map