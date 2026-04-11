import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Gym Retention API',
      version: '1.0.0',
      description: `
Multi-tenant gym retention SaaS — REST API documentation.

## Authentication
Most endpoints require a **Bearer JWT** token.
1. Call \`POST /api/auth/login\` to get an \`accessToken\`.
2. Click **Authorize** (lock icon) and paste: \`Bearer <accessToken>\`.

## Admin endpoints
Admin routes use a separate static secret instead of JWT.
Set \`Authorization: Bearer <ADMIN_SECRET>\` (value from \`.env\`).
      `.trim(),
      contact: { name: 'MystiFoe', url: 'https://github.com/MystiFoe/Gym-Retention' },
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local development' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Paste the accessToken returned by /api/auth/login',
        },
        AdminSecret: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static ADMIN_SECRET from .env (not a JWT)',
        },
      },
      schemas: {
        // ── Generic ─────────────────────────────────────────────
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Invalid credentials' },
          },
        },
        // ── Auth ────────────────────────────────────────────────
        LoginRequest: {
          type: 'object',
          required: ['phone_or_email', 'password', 'role'],
          properties: {
            phone_or_email: { type: 'string', example: 'owner@gym.com' },
            password: { type: 'string', example: 'Giri@123' },
            role: { type: 'string', enum: ['owner', 'trainer', 'member'], example: 'owner' },
            gym_id: { type: 'string', format: 'uuid', description: 'Required for trainer/member roles' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                refreshToken: { type: 'string' },
                user: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    gym_id: { type: 'string', format: 'uuid' },
                    role: { type: 'string', example: 'owner' },
                  },
                },
              },
            },
          },
        },
        // ── Gym ─────────────────────────────────────────────────
        GymRegisterRequest: {
          type: 'object',
          required: ['name', 'owner_name', 'phone', 'email', 'password'],
          properties: {
            name: { type: 'string', example: 'FitZone Gym' },
            owner_name: { type: 'string', example: 'Giri Kumar' },
            phone: { type: 'string', example: '9876543210' },
            email: { type: 'string', example: 'owner@fitzone.com' },
            address: { type: 'string', example: '123 Main St' },
            password: { type: 'string', example: 'Giri@123' },
          },
        },
        // ── Member ──────────────────────────────────────────────
        MemberRequest: {
          type: 'object',
          required: ['name', 'phone', 'email', 'membership_expiry_date', 'plan_fee'],
          properties: {
            name: { type: 'string', example: 'Rahul Sharma' },
            phone: { type: 'string', example: '9123456780' },
            email: { type: 'string', example: 'rahul@example.com' },
            membership_expiry_date: { type: 'string', format: 'date', example: '2025-12-31' },
            plan_fee: { type: 'number', example: 1500 },
            assigned_trainer_id: { type: 'string', format: 'uuid' },
          },
        },
        // ── Trainer ─────────────────────────────────────────────
        TrainerRequest: {
          type: 'object',
          required: ['name', 'phone', 'email', 'password'],
          properties: {
            name: { type: 'string', example: 'Priya Trainer' },
            phone: { type: 'string', example: '9000011111' },
            email: { type: 'string', example: 'priya@fitzone.com' },
            password: { type: 'string', example: 'Trainer@123' },
          },
        },
        // ── Task ────────────────────────────────────────────────
        TaskRequest: {
          type: 'object',
          required: ['member_id', 'task_type'],
          properties: {
            member_id: { type: 'string', format: 'uuid' },
            task_type: { type: 'string', enum: ['call', 'renewal', 'check_in'] },
            assigned_trainer_id: { type: 'string', format: 'uuid' },
            notes: { type: 'string' },
          },
        },
        TaskUpdateRequest: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            outcome: { type: 'string', enum: ['called', 'not_reachable', 'coming_tomorrow', 'renewed', 'no_action'] },
            notes: { type: 'string' },
          },
        },
        // ── Attendance ──────────────────────────────────────────
        AttendanceRequest: {
          type: 'object',
          required: ['member_id'],
          properties: {
            member_id: { type: 'string', format: 'uuid' },
            visit_date: { type: 'string', format: 'date', example: '2025-01-15' },
          },
        },
        // ── Billing ─────────────────────────────────────────────
        CreateOrderRequest: {
          type: 'object',
          required: ['plan'],
          properties: {
            plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] },
          },
        },
        VerifyPaymentRequest: {
          type: 'object',
          required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature', 'plan'],
          properties: {
            razorpay_order_id: { type: 'string' },
            razorpay_payment_id: { type: 'string' },
            razorpay_signature: { type: 'string' },
            plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] },
          },
        },
        // ── Admin ───────────────────────────────────────────────
        ConvertGymRequest: {
          type: 'object',
          required: ['months'],
          properties: {
            months: { type: 'integer', minimum: 1, maximum: 12, example: 3 },
          },
        },
      },
    },
    // Apply BearerAuth globally to all routes by default
    security: [{ BearerAuth: [] }],
    tags: [
      { name: 'Health',      description: 'Server status' },
      { name: 'Auth',        description: 'Login, logout, password reset' },
      { name: 'Gyms',        description: 'Registration and subscription' },
      { name: 'Members',     description: 'Member CRUD, CSV export, GDPR' },
      { name: 'Trainers',    description: 'Trainer CRUD and member assignment' },
      { name: 'Tasks',       description: 'Follow-up task management' },
      { name: 'Attendance',  description: 'Visit tracking' },
      { name: 'Dashboard',   description: 'KPIs and revenue' },
      { name: 'Admin',       description: 'SaaS operator controls (admin secret)' },
    ],
    paths: {
      // ── Health ───────────────────────────────────────────────────
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          security: [],
          responses: {
            200: { description: 'Server is up', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, uptime: { type: 'number' } } } } } },
          },
        },
      },

      // ── Auth ─────────────────────────────────────────────────────
      '/api/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login (owner / trainer / member)',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
          responses: {
            200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            403: { description: 'Gym suspended' },
          },
        },
      },
      '/api/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Request a password reset email',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
          responses: {
            200: { description: 'Reset email sent (or silently ignored if email not found)' },
          },
        },
      },
      '/api/auth/reset-password': {
        post: {
          tags: ['Auth'],
          summary: 'Reset password using token from email',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'new_password'], properties: { token: { type: 'string' }, new_password: { type: 'string', minLength: 8 } } } } } },
          responses: {
            200: { description: 'Password reset successfully' },
            400: { description: 'Invalid or expired token' },
          },
        },
      },

      // ── Gyms ─────────────────────────────────────────────────────
      '/api/gyms/register': {
        post: {
          tags: ['Gyms'],
          summary: 'Register a new gym (starts a free trial)',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GymRegisterRequest' } } } },
          responses: {
            201: { description: 'Gym registered — returns gym_id and owner credentials' },
            409: { description: 'Email already registered' },
          },
        },
      },
      '/api/gyms/{gymId}/subscription': {
        get: {
          tags: ['Gyms'],
          summary: 'Get current subscription status and available plans',
          parameters: [{ name: 'gymId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Subscription details with trial/active status and plan list' },
          },
        },
      },
      '/api/gyms/{gymId}/billing/create-order': {
        post: {
          tags: ['Gyms'],
          summary: 'Create a Razorpay order for a subscription plan',
          parameters: [{ name: 'gymId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateOrderRequest' } } } },
          responses: {
            200: { description: 'Razorpay order ID and amount' },
          },
        },
      },
      '/api/gyms/{gymId}/billing/verify-payment': {
        post: {
          tags: ['Gyms'],
          summary: 'Verify Razorpay payment signature and activate subscription',
          parameters: [{ name: 'gymId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyPaymentRequest' } } } },
          responses: {
            200: { description: 'Subscription activated' },
            400: { description: 'Invalid payment signature' },
          },
        },
      },

      // ── Members ──────────────────────────────────────────────────
      '/api/members': {
        get: {
          tags: ['Members'],
          summary: 'List members (paginated, filterable by status)',
          parameters: [
            { name: 'page',   in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'at_risk', 'high_risk', 'expiring'] } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Paginated member list' } },
        },
        post: {
          tags: ['Members'],
          summary: 'Add a new member',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberRequest' } } } },
          responses: {
            201: { description: 'Member created' },
            409: { description: 'Phone or email already exists in this gym' },
          },
        },
      },
      '/api/members/export': {
        get: {
          tags: ['Members'],
          summary: 'Export all members as CSV (UTF-8 with BOM for Excel)',
          responses: {
            200: { description: 'CSV file download', content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } } },
          },
        },
      },
      '/api/members/{id}': {
        put: {
          tags: ['Members'],
          summary: 'Update member details',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberRequest' } } } },
          responses: { 200: { description: 'Member updated' }, 404: { description: 'Member not found' } },
        },
        delete: {
          tags: ['Members'],
          summary: 'Soft-delete a member',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Member deleted' } },
        },
      },
      '/api/members/{id}/data': {
        delete: {
          tags: ['Members'],
          summary: 'GDPR: Permanently erase member personal data (name, phone, email, attendance)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Personal data erased' }, 404: { description: 'Member not found' } },
        },
      },

      // ── Trainers ─────────────────────────────────────────────────
      '/api/trainers': {
        get: {
          tags: ['Trainers'],
          summary: 'List all trainers in the gym',
          responses: { 200: { description: 'Trainer list' } },
        },
        post: {
          tags: ['Trainers'],
          summary: 'Add a new trainer (creates user account)',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TrainerRequest' } } } },
          responses: { 201: { description: 'Trainer created' } },
        },
      },
      '/api/trainers/me': {
        get: {
          tags: ['Trainers'],
          summary: 'Get the currently logged-in trainer\'s profile',
          responses: { 200: { description: 'Trainer profile with assigned members' } },
        },
      },
      '/api/trainers/{id}': {
        patch: {
          tags: ['Trainers'],
          summary: 'Update trainer details',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } } } },
          responses: { 200: { description: 'Trainer updated' } },
        },
        delete: {
          tags: ['Trainers'],
          summary: 'Soft-delete a trainer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Trainer deleted' } },
        },
      },
      '/api/trainers/{id}/assign-members': {
        post: {
          tags: ['Trainers'],
          summary: 'Assign members to a trainer',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_ids'], properties: { member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } } },
          responses: { 200: { description: 'Members assigned' } },
        },
      },

      // ── Tasks ─────────────────────────────────────────────────────
      '/api/tasks': {
        get: {
          tags: ['Tasks'],
          summary: 'List follow-up tasks (filterable by status / trainer / member)',
          parameters: [
            { name: 'status',     in: 'query', schema: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            { name: 'trainer_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'member_id',  in: 'query', schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Task list' } },
        },
        post: {
          tags: ['Tasks'],
          summary: 'Create a follow-up task',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskRequest' } } } },
          responses: { 201: { description: 'Task created' } },
        },
      },
      '/api/tasks/{id}': {
        patch: {
          tags: ['Tasks'],
          summary: 'Update task status / outcome (trainer)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskUpdateRequest' } } } },
          responses: { 200: { description: 'Task updated' } },
        },
      },

      // ── Attendance ────────────────────────────────────────────────
      '/api/attendance': {
        post: {
          tags: ['Attendance'],
          summary: 'Log a member visit',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AttendanceRequest' } } } },
          responses: { 201: { description: 'Attendance logged' }, 409: { description: 'Already logged today' } },
        },
        get: {
          tags: ['Attendance'],
          summary: 'Get attendance history',
          parameters: [
            { name: 'member_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
          ],
          responses: { 200: { description: 'Attendance records' } },
        },
      },

      // ── Dashboard ────────────────────────────────────────────────
      '/api/dashboard/kpis': {
        get: {
          tags: ['Dashboard'],
          summary: 'Get owner dashboard KPIs (active, at-risk, high-risk members, revenue)',
          responses: { 200: { description: 'KPI summary' } },
        },
      },
      '/api/revenue': {
        get: {
          tags: ['Dashboard'],
          summary: 'Get revenue records',
          responses: { 200: { description: 'Revenue records list' } },
        },
      },

      // ── Admin ─────────────────────────────────────────────────────
      '/api/admin/gyms': {
        get: {
          tags: ['Admin'],
          summary: 'List all gyms with subscription status, member count, days remaining',
          security: [{ AdminSecret: [] }],
          responses: {
            200: { description: 'Gym list' },
            401: { description: 'Invalid admin secret' },
          },
        },
      },
      '/api/admin/gyms/{id}/suspend': {
        post: {
          tags: ['Admin'],
          summary: 'Suspend a gym (blocks all logins)',
          security: [{ AdminSecret: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym suspended' } },
        },
      },
      '/api/admin/gyms/{id}/reactivate': {
        post: {
          tags: ['Admin'],
          summary: 'Reactivate a suspended gym',
          security: [{ AdminSecret: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym reactivated' } },
        },
      },
      '/api/admin/gyms/{id}/convert': {
        post: {
          tags: ['Admin'],
          summary: 'Manually convert trial → paid subscription',
          security: [{ AdminSecret: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ConvertGymRequest' } } } },
          responses: { 200: { description: 'Subscription activated' } },
        },
      },
    },
  },
  apis: [], // All docs defined above — no JSDoc scanning needed
});

export default spec;
