import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Recurva Gym Retention API',
      version: '3.0.0',
      description: `
**Customer retention platform for gyms** — multi-tenant SaaS with three roles.

## Roles
| Role | Access |
|------|--------|
| \`owner\` | Full gym management, billing, subscriptions |
| \`trainer\` (staff) | Member attendance, tasks, assigned members |
| \`trainer\` (admin) | Same as owner except billing/subscription |
| \`member\` | Own attendance, payments, profile |

## Authentication Flow
- **Owner/Staff login**: \`POST /api/auth/login\` with email/phone + password + role
- **Member login**: \`POST /api/auth/login\` with email/phone + password + role=member
- **Member mobile login**: \`POST /api/auth/customer/login\` — email/phone lookup, returns gym list
- **Token refresh**: \`POST /api/auth/refresh\` — supply refresh_token, get new pair
- **Firebase OTP login**: Phone OTP → \`POST /api/auth/verify-firebase-token\`

## Staff & Member Onboarding
1. Owner generates invite code via \`POST /api/invites\`
2. Shares 8-char code with person
3. Person calls \`POST /api/auth/staff/register\` or \`POST /api/auth/member/register\`

## Member Registration with Verification
1. \`POST /api/auth/member/send-email-otp\` — validate invite, send OTP to email
2. Client does Firebase phone OTP verification (gets firebaseIdToken)
3. \`POST /api/auth/member/register\` — with emailOtpKey, emailOtp, firebaseIdToken

## Gym Self-Registration
1. \`POST /api/gyms/register\` — submit details, receive email OTP
2. \`POST /api/gyms/register/verify-email\` — verify email OTP
3. \`POST /api/gyms/register/verify-phone\` — Firebase phone OTP → gym + owner account created

## Display ID Format
- Business: \`RCV-B-XXXXX\`
- Staff/Admin: \`RCV-S-XXXXXXX\`
- Member: \`RCV-M-XXXXXXX\`

## Error Responses
All errors follow: \`{ "success": false, "error": "message" }\`
`,
      contact: { name: 'Recurva Support', email: 'support@recurva.app' },
    },
    servers: [
      { url: 'https://api-mbnwf5sqva-el.a.run.app/api', description: 'Production (Firebase Cloud Run)' },
      { url: 'http://localhost:3000/api', description: 'Local development' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token obtained from login or register endpoints',
        },
      },
      schemas: {
        // ── Common ──────────────────────────────────────────────────────────
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
        // ── Auth ────────────────────────────────────────────────────────────
        LoginRequest: {
          type: 'object',
          required: ['phone_or_email', 'password', 'role'],
          properties: {
            phone_or_email: { type: 'string', example: 'owner@gym.com' },
            password: { type: 'string', format: 'password', example: 'Secret@123' },
            role: { type: 'string', enum: ['owner', 'trainer', 'member'] },
            gym_id: { type: 'string', format: 'uuid', description: 'Optional — disambiguates when user belongs to multiple gyms' },
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
                    role: { type: 'string', enum: ['owner', 'trainer', 'member'] },
                    trainer_role: { type: 'string', enum: ['staff', 'admin'], description: 'Only for trainer role' },
                    member_id: { type: 'string', format: 'uuid', description: 'Only for member role' },
                  },
                },
              },
            },
          },
        },
        // ── Gym ─────────────────────────────────────────────────────────────
        Gym: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'FitZone Gym' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', example: '+919876543210' },
            address: { type: 'string' },
            display_id: { type: 'string', example: 'RCV-B-00001' },
            subscription_status: { type: 'string', enum: ['trial', 'active', 'suspended', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        // ── Member ──────────────────────────────────────────────────────────
        Member: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Rahul Kumar' },
            phone: { type: 'string', example: '+919876543210' },
            email: { type: 'string', format: 'email' },
            display_id: { type: 'string', example: 'RCV-M-0001234' },
            status: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] },
            plan: { type: 'string', example: 'monthly' },
            plan_fee: { type: 'number', example: 1500 },
            membership_expiry_date: { type: 'string', format: 'date' },
            last_visit_date: { type: 'string', format: 'date', nullable: true },
            email_verified: { type: 'boolean' },
            phone_verified: { type: 'boolean' },
            assigned_trainer_id: { type: 'string', format: 'uuid', nullable: true },
            days_last_visit: { type: 'integer', description: 'Days since last gym visit' },
            days_to_expiry: { type: 'integer', description: 'Days until membership expires (negative = expired)' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        MemberInput: {
          type: 'object',
          required: ['name', 'phone', 'membership_expiry_date', 'plan_fee'],
          properties: {
            name: { type: 'string', minLength: 2, example: 'Rahul Kumar' },
            phone: { type: 'string', example: '9876543210' },
            email: { type: 'string', format: 'email' },
            plan: { type: 'string', example: 'monthly' },
            plan_fee: { type: 'number', example: 1500 },
            membership_expiry_date: { type: 'string', format: 'date', example: '2026-06-30' },
            assigned_trainer_id: { type: 'string', format: 'uuid', nullable: true },
          },
        },
        // ── Trainer ─────────────────────────────────────────────────────────
        Trainer: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            display_id: { type: 'string', example: 'RCV-S-0000001' },
            trainer_role: { type: 'string', enum: ['staff', 'admin'] },
            is_active: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        // ── Attendance ──────────────────────────────────────────────────────
        AttendanceRecord: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            member_id: { type: 'string', format: 'uuid' },
            visit_date: { type: 'string', format: 'date' },
            check_in_time: { type: 'string', nullable: true, description: 'HH:MM:SS format' },
            source: { type: 'string', enum: ['staff', 'mobile', 'biometric', 'qr'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        // ── Payment ─────────────────────────────────────────────────────────
        Payment: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            member_id: { type: 'string', format: 'uuid' },
            amount: { type: 'integer', description: 'Amount in paise (₹1 = 100 paise)', example: 150000 },
            currency: { type: 'string', example: 'INR' },
            status: { type: 'string', enum: ['pending', 'completed', 'failed'] },
            razorpay_order_id: { type: 'string' },
            razorpay_payment_id: { type: 'string' },
            description: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        // ── Invite Code ─────────────────────────────────────────────────────
        InviteCode: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            code: { type: 'string', example: 'ABCD1234', minLength: 8, maxLength: 8 },
            type: { type: 'string', enum: ['staff', 'member'] },
            trainer_role: { type: 'string', enum: ['staff', 'admin'], nullable: true },
            gym_name: { type: 'string' },
            display_id: { type: 'string' },
            placeholder_name: { type: 'string', nullable: true },
            expires_at: { type: 'string', format: 'date-time' },
            used_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        // ── Customer Profile (member self-view) ──────────────────────────────
        CustomerProfile: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string', format: 'email' },
            status: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] },
            plan: { type: 'string' },
            plan_fee: { type: 'number' },
            membership_expiry_date: { type: 'string', format: 'date' },
            last_visit_date: { type: 'string', format: 'date', nullable: true },
            email_verified: { type: 'boolean' },
            phone_verified: { type: 'boolean' },
            gym_name: { type: 'string' },
            gym_address: { type: 'string' },
            gym_phone: { type: 'string' },
            payment_enabled: { type: 'boolean' },
          },
        },
        // ── Task ────────────────────────────────────────────────────────────
        Task: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            member_id: { type: 'string', format: 'uuid' },
            task_type: { type: 'string', enum: ['call', 'renewal', 'check_in'] },
            status: { type: 'string', enum: ['pending', 'completed', 'cancelled'] },
            assigned_trainer_id: { type: 'string', format: 'uuid', nullable: true },
            notes: { type: 'string', nullable: true },
            outcome: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            completed_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Health', description: 'Health check' },
      { name: 'Auth', description: 'Authentication — login, register, refresh, OTP' },
      { name: 'Gym Registration', description: 'Business / gym self-registration flow (public, multi-step)' },
      { name: 'Gyms', description: 'Gym profile & subscription management' },
      { name: 'Members', description: 'Owner/trainer member CRUD' },
      { name: 'Trainers', description: 'Owner trainer management' },
      { name: 'Attendance', description: 'Mark & view attendance (owner/trainer)' },
      { name: 'Tasks', description: 'Follow-up task management' },
      { name: 'Invite Codes', description: 'Invite code generation & validation' },
      { name: 'Payments (Owner)', description: 'Owner payment history, reports & Razorpay setup' },
      { name: 'Payments (Member)', description: 'Member payment portal' },
      { name: 'Member Portal', description: 'Self-service endpoints for logged-in members' },
      { name: 'Biometric', description: 'ZKTeco biometric device integration' },
      { name: 'Profile', description: 'Logged-in user profile (owner/trainer)' },
      { name: 'Dashboard', description: 'KPI dashboard & revenue analytics (owner)' },
      { name: 'Admin', description: 'Super-admin platform management' },
    ],
    paths: {
      // ════════════════════════════════════════════════════════════════════
      // HEALTH
      // ════════════════════════════════════════════════════════════════════
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check (also available at /api/health)',
          security: [],
          responses: {
            200: {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      timestamp: { type: 'string', format: 'date-time' },
                      version: { type: 'string', example: '3.0.0' },
                      uptime: { type: 'number', description: 'Process uptime in seconds' },
                      environment: { type: 'string', example: 'production' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // AUTH
      // ════════════════════════════════════════════════════════════════════
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login with email/phone + password (owner, trainer, member)',
          description: 'Returns access + refresh tokens. For members, also embeds member_id in the JWT payload.',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
          responses: {
            200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Validation error — missing or invalid fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            403: { description: 'Gym blocked or subscription suspended', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            429: { description: 'Rate limit exceeded (5 attempts per 15 min per IP)' },
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['Auth'],
          summary: 'Refresh access token using a valid refresh token',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } } },
          },
          responses: {
            200: {
              description: 'New token pair issued',
              content: {
                'application/json': {
                  schema: {
                    type: 'object', properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object', properties: { access_token: { type: 'string' }, refresh_token: { type: 'string' } } },
                    },
                  },
                },
              },
            },
            400: { description: 'Missing refresh_token field' },
            401: { description: 'Invalid or expired refresh token' },
          },
        },
      },
      '/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Request a password-reset OTP sent to email',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'role'], properties: { email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['owner', 'trainer', 'member'] } } } } },
          },
          responses: {
            200: { description: 'OTP sent to email (even if email not found, to prevent enumeration)' },
          },
        },
      },
      '/auth/verify-reset-otp': {
        post: {
          tags: ['Auth'],
          summary: 'Verify password-reset OTP and receive a reset token',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'otp', 'role'], properties: { email: { type: 'string', format: 'email' }, otp: { type: 'string', minLength: 6, maxLength: 6 }, role: { type: 'string', enum: ['owner', 'trainer', 'member'] } } } } },
          },
          responses: {
            200: { description: 'OTP valid — returns reset_token', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { reset_token: { type: 'string' } } } } } } } },
            400: { description: 'Invalid or expired OTP' },
          },
        },
      },
      '/auth/reset-password': {
        post: {
          tags: ['Auth'],
          summary: 'Set a new password using the reset token from verify-reset-otp',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['reset_token', 'new_password'],
                  properties: {
                    reset_token: { type: 'string' },
                    new_password: { type: 'string', minLength: 8, description: 'Min 8 chars, 1 uppercase, 1 digit, 1 special char' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Password reset successful' },
            400: { description: 'Invalid or expired reset token' },
          },
        },
      },
      '/auth/send-otp': {
        post: {
          tags: ['Auth'],
          summary: 'Send email OTP for verification (authenticated — owner/trainer)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
          },
          responses: {
            200: { description: 'OTP sent' },
          },
        },
      },
      '/auth/verify-otp': {
        post: {
          tags: ['Auth'],
          summary: 'Verify email OTP (authenticated — marks email_verified)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['otp'], properties: { otp: { type: 'string', minLength: 6, maxLength: 6 } } } } },
          },
          responses: {
            200: { description: 'Email verified' },
            400: { description: 'Invalid OTP' },
          },
        },
      },
      '/auth/verify-firebase-token': {
        post: {
          tags: ['Auth'],
          summary: 'Exchange Firebase phone ID token for app JWT (owner/trainer)',
          description: 'After Firebase phone OTP, exchange the Firebase ID token for an app JWT pair.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['firebase_id_token', 'role'],
                  properties: {
                    firebase_id_token: { type: 'string' },
                    role: { type: 'string', enum: ['owner', 'trainer'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'JWT issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            404: { description: 'No account found for this phone number' },
          },
        },
      },
      '/auth/phone-reset-token': {
        post: {
          tags: ['Auth'],
          summary: 'Exchange a Firebase phone token for a password-reset token (no password required)',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token', 'role'], properties: { firebase_id_token: { type: 'string' }, role: { type: 'string', enum: ['owner', 'trainer'] } } } } },
          },
          responses: {
            200: { description: 'Reset token issued', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { reset_token: { type: 'string' } } } } } } } },
            404: { description: 'Account not found for this phone' },
          },
        },
      },
      '/auth/fcm-token': {
        put: {
          tags: ['Auth'],
          summary: 'Register or update FCM push notification token',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['fcm_token'], properties: { fcm_token: { type: 'string' } } } } },
          },
          responses: { 200: { description: 'FCM token saved' } },
        },
      },
      '/auth/customer/login': {
        post: {
          tags: ['Auth'],
          summary: 'Member mobile login — step 1: look up gyms by email or phone',
          description: 'Returns a list of gyms the member belongs to. If only one gym, proceed directly. If multiple, user selects gym via /auth/customer/select-gym.',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['phone_or_email'], properties: { phone_or_email: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'List of gyms for this phone/email', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { gyms: { type: 'array', items: { type: 'object', properties: { gym_id: { type: 'string', format: 'uuid' }, gym_name: { type: 'string' }, member_id: { type: 'string', format: 'uuid' } } } } } } } } } } },
            404: { description: 'No membership found for this contact' },
          },
        },
      },
      '/auth/customer/select-gym': {
        post: {
          tags: ['Auth'],
          summary: 'Member mobile login — step 2: select a gym and receive JWT',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['phone_or_email', 'gym_id'], properties: { phone_or_email: { type: 'string' }, gym_id: { type: 'string', format: 'uuid' } } } } },
          },
          responses: {
            200: { description: 'JWT issued for the selected gym', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            404: { description: 'Membership not found' },
          },
        },
      },
      '/auth/customer/link-invite': {
        post: {
          tags: ['Auth'],
          summary: 'Link an existing member to a user account via invite code',
          description: 'Called after customer/select-gym when the member does not yet have a user account linked.',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['phone_or_email', 'invite_code'], properties: { phone_or_email: { type: 'string' }, invite_code: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'Account linked, JWT issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Invalid invite code' },
          },
        },
      },

      // ── Gym Registration (public multi-step flow) ─────────────────────
      '/gyms/register': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 1 — Submit business registration and receive email OTP',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ownerName', 'ownerEmail', 'ownerPhone', 'gymName', 'password'],
                  properties: {
                    ownerName: { type: 'string' },
                    ownerEmail: { type: 'string', format: 'email' },
                    ownerPhone: { type: 'string' },
                    gymName: { type: 'string' },
                    gymAddress: { type: 'string' },
                    password: { type: 'string', minLength: 8 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Pending registration created, OTP sent to email', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { pendingId: { type: 'string' }, ownerEmail: { type: 'string' } } } } } } } },
            409: { description: 'Email already registered' },
          },
        },
      },
      '/gyms/register/verify-email': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 2 — Verify email OTP',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['pendingId', 'otpCode'], properties: { pendingId: { type: 'string' }, otpCode: { type: 'string', minLength: 6, maxLength: 6 } } } } },
          },
          responses: {
            200: { description: 'Email verified — proceed to phone verification' },
            400: { description: 'Invalid or expired OTP' },
          },
        },
      },
      '/gyms/register/resend-email-otp': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Resend email OTP for gym registration',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['pendingId'], properties: { pendingId: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'OTP resent' },
            404: { description: 'Pending registration not found or already completed' },
          },
        },
      },
      '/gyms/register/verify-phone': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 3 — Verify phone via Firebase OTP, create gym + owner account',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['pendingId', 'firebase_id_token'], properties: { pendingId: { type: 'string' }, firebase_id_token: { type: 'string' } } } } },
          },
          responses: {
            201: { description: 'Gym created and owner logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Pending registration not found, email not yet verified, or phone mismatch' },
          },
        },
      },

      // ── Staff Self-Registration ───────────────────────────────────────
      '/auth/staff/register': {
        post: {
          tags: ['Auth'],
          summary: 'Staff self-registration using an owner-generated invite code',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'name', 'email', 'phone', 'password'],
                  properties: {
                    code: { type: 'string', minLength: 8, maxLength: 8, example: 'ABCD1234' },
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    phone: { type: 'string' },
                    password: { type: 'string', minLength: 8 },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Account created and logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Missing fields or invalid/expired invite code' },
            409: { description: 'Email already registered' },
          },
        },
      },

      // ── Member Self-Registration ──────────────────────────────────────
      '/auth/member/send-email-otp': {
        post: {
          tags: ['Auth'],
          summary: 'Member registration — step 1: validate invite code and send email OTP',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'email'],
                  properties: {
                    code: { type: 'string', minLength: 8, maxLength: 8 },
                    email: { type: 'string', format: 'email' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'OTP sent — returns tempKey', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { tempKey: { type: 'string', description: 'Pass as emailOtpKey in /auth/member/register' } } } } } } } },
            400: { description: 'Invalid or expired invite code' },
          },
        },
      },
      '/auth/member/register': {
        post: {
          tags: ['Auth'],
          summary: 'Member registration — step 2: verify OTPs and create account',
          description: 'Pass emailOtpKey + emailOtp (from send-email-otp) and optionally firebaseIdToken (Firebase phone OTP). Verified contacts are flagged on the member record.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'name', 'email', 'phone', 'password'],
                  properties: {
                    code: { type: 'string', minLength: 8, maxLength: 8 },
                    name: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    phone: { type: 'string' },
                    password: { type: 'string', minLength: 8 },
                    emailOtpKey: { type: 'string', description: 'From /auth/member/send-email-otp' },
                    emailOtp: { type: 'string', minLength: 6, maxLength: 6 },
                    firebaseIdToken: { type: 'string', description: 'Firebase ID token after phone OTP verification' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Member account created and logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Invalid invite code or OTP' },
            409: { description: 'Email or phone already registered' },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // GYMS
      // ════════════════════════════════════════════════════════════════════
      '/gyms/me': {
        get: {
          tags: ['Gyms'],
          summary: 'Get own gym profile',
          responses: { 200: { description: 'Gym profile', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Gym' } } } } } } },
        },
        put: {
          tags: ['Gyms'],
          summary: 'Update gym profile (name, address, Razorpay keys)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    gymName: { type: 'string' },
                    address: { type: 'string' },
                    razorpay_key_id: { type: 'string' },
                    razorpay_key_secret: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated successfully' } },
        },
      },
      '/gyms/{gymId}/subscription': {
        get: {
          tags: ['Gyms'],
          summary: 'Get subscription details for the gym',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Subscription details' } },
        },
      },
      '/gyms/{gymId}/billing/create-order': {
        post: {
          tags: ['Gyms'],
          summary: 'Create a Razorpay order for gym subscription renewal',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['plan'], properties: { plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] } } } } },
          },
          responses: {
            200: { description: 'Razorpay order created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'integer' }, currency: { type: 'string' }, key_id: { type: 'string' } } } } } } } },
            503: { description: 'Razorpay not configured' },
          },
        },
      },
      '/gyms/{gymId}/billing/verify-payment': {
        post: {
          tags: ['Gyms'],
          summary: 'Verify Razorpay payment and activate gym subscription',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature', 'plan'],
                  properties: {
                    razorpay_order_id: { type: 'string' },
                    razorpay_payment_id: { type: 'string' },
                    razorpay_signature: { type: 'string' },
                    plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Payment verified, subscription activated' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // MEMBERS
      // ════════════════════════════════════════════════════════════════════
      '/members': {
        get: {
          tags: ['Members'],
          summary: 'List members (owner: all, trainer: assigned only)',
          parameters: [
            { in: 'query', name: 'status', schema: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] } },
            { in: 'query', name: 'search', schema: { type: 'string' }, description: 'Search by name, phone, or email' },
            { in: 'query', name: 'trainer_id', schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50, maximum: 200 } },
          ],
          responses: {
            200: {
              description: 'Paginated member list',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          members: { type: 'array', items: { $ref: '#/components/schemas/Member' } },
                          total: { type: 'integer' },
                          page: { type: 'integer' },
                          limit: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Members'],
          summary: 'Add a single member (owner only)',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberInput' } } } },
          responses: {
            201: { description: 'Member created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Member' } } } } } },
            400: { description: 'Validation error' },
            409: { description: 'Phone or email already registered in this gym' },
          },
        },
      },
      '/members/export': {
        get: {
          tags: ['Members'],
          summary: 'Download all members as CSV (owner only)',
          responses: {
            200: {
              description: 'CSV file',
              content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
            },
          },
        },
      },
      '/members/bulk-import': {
        post: {
          tags: ['Members'],
          summary: 'Bulk import members from JSON array (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['members'],
                  properties: {
                    trainer_id: { type: 'string', format: 'uuid', nullable: true },
                    members: { type: 'array', items: { $ref: '#/components/schemas/MemberInput' } },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Import summary with created/skipped counts and errors' } },
        },
      },
      '/members/{id}': {
        put: {
          tags: ['Members'],
          summary: 'Update member details (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberInput' } } } },
          responses: {
            200: { description: 'Member updated' },
            404: { description: 'Member not found in this gym' },
          },
        },
        delete: {
          tags: ['Members'],
          summary: 'Soft-delete member — sets is_deleted=true (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'Member soft-deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } } } } },
            404: { description: 'Member not found' },
          },
        },
      },
      '/members/{id}/data': {
        delete: {
          tags: ['Members'],
          summary: 'GDPR erase — anonymise all PII for a member (owner only)',
          description: 'Replaces name, phone, email with unique placeholders. Preserves aggregate records (attendance counts, revenue) with anonymised keys.',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            200: { description: 'PII erased', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { message: { type: 'string', example: 'Member data erased successfully' } } } } } } } },
            404: { description: 'Member not found in this gym' },
          },
        },
      },
      '/members/{memberId}/attendance': {
        get: {
          tags: ['Attendance'],
          summary: 'Get attendance calendar for a member by month (owner/trainer)',
          description: 'Trainer can only access attendance for their assigned members. Defaults to current month if month param is omitted or invalid.',
          parameters: [
            { in: 'path', name: 'memberId', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'month', required: false, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$', example: '2026-05' }, description: 'YYYY-MM format. Defaults to current month.' },
          ],
          responses: {
            200: {
              description: 'Member details and list of present dates',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          member: { $ref: '#/components/schemas/Member' },
                          present_dates: { type: 'array', items: { type: 'string', format: 'date' }, example: ['2026-05-01', '2026-05-03'] },
                          month: { type: 'string', example: '2026-05' },
                        },
                      },
                    },
                  },
                },
              },
            },
            403: { description: 'Trainer trying to access a member not assigned to them' },
            404: { description: 'Member not found in this gym' },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // TRAINERS
      // ════════════════════════════════════════════════════════════════════
      '/trainers': {
        get: {
          tags: ['Trainers'],
          summary: 'List all trainers/staff (owner only)',
          responses: { 200: { description: 'Trainer list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Trainer' } } } } } } } },
        },
        post: {
          tags: ['Trainers'],
          summary: 'Add a trainer — creates pending slot and invite code (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'phone'],
                  properties: {
                    name: { type: 'string' },
                    phone: { type: 'string' },
                    email: { type: 'string', format: 'email' },
                    trainer_role: { type: 'string', enum: ['staff', 'admin'], default: 'staff' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Trainer slot created, invite code returned' } },
        },
      },
      '/trainers/bulk-import': {
        post: {
          tags: ['Trainers'],
          summary: 'Bulk import trainers from JSON array (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['trainers'],
                  properties: {
                    trainers: { type: 'array', items: { type: 'object', required: ['name', 'phone'], properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, trainer_role: { type: 'string', enum: ['staff', 'admin'] } } } },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Import summary' } },
        },
      },
      '/trainers/me': {
        get: {
          tags: ['Trainers'],
          summary: 'Get own trainer profile (trainer role only)',
          responses: { 200: { description: 'Trainer profile with assigned member count' } },
        },
      },
      '/trainers/{id}': {
        patch: {
          tags: ['Trainers'],
          summary: 'Update trainer details (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } } } },
          responses: { 200: { description: 'Updated' }, 404: { description: 'Trainer not found' } },
        },
        delete: {
          tags: ['Trainers'],
          summary: 'Remove trainer (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Trainer removed' } },
        },
      },
      '/trainers/{id}/role': {
        put: {
          tags: ['Trainers'],
          summary: 'Promote or demote trainer_role between staff and admin (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['trainer_role'], properties: { trainer_role: { type: 'string', enum: ['staff', 'admin'] } } } } } },
          responses: { 200: { description: 'Role updated' } },
        },
      },
      '/trainers/{id}/assign-members': {
        post: {
          tags: ['Trainers'],
          summary: 'Assign a list of members to a trainer (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['member_ids'], properties: { member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } } } } } },
          },
          responses: { 200: { description: 'Members assigned to trainer' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // INVITE CODES
      // ════════════════════════════════════════════════════════════════════
      '/invites': {
        post: {
          tags: ['Invite Codes'],
          summary: 'Generate an invite code for a staff slot or member (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: ['staff', 'member'] },
                    name: { type: 'string', description: 'Required for both types. Placeholder name for the slot.' },
                    trainer_role: { type: 'string', enum: ['staff', 'admin'], description: 'For staff type only (default: staff)' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Invite code created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/InviteCode' } } } } } },
            400: { description: 'Missing type, invalid type, or missing name field' },
          },
        },
        get: {
          tags: ['Invite Codes'],
          summary: 'List active (unused, non-expired) invite codes (owner only)',
          responses: {
            200: { description: 'Active invite codes', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/InviteCode' } } } } } } },
          },
        },
      },
      '/invites/{code}': {
        get: {
          tags: ['Invite Codes'],
          summary: 'Validate an invite code and return its details (public)',
          description: 'Code is case-insensitive (auto-uppercased). Returns 404 if code is invalid, used, or expired.',
          security: [],
          parameters: [{ in: 'path', name: 'code', required: true, schema: { type: 'string', minLength: 8, maxLength: 8, example: 'ABCD1234' } }],
          responses: {
            200: { description: 'Valid code info', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/InviteCode' } } } } } },
            404: { description: 'Invalid or expired code' },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // ATTENDANCE (Owner/Trainer)
      // ════════════════════════════════════════════════════════════════════
      '/attendance': {
        post: {
          tags: ['Attendance'],
          summary: 'Mark attendance for a member (owner or trainer)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['member_id', 'visit_date'],
                  properties: {
                    member_id: { type: 'string', format: 'uuid' },
                    visit_date: { type: 'string', format: 'date', example: '2026-05-09' },
                    check_in_time: { type: 'string', example: '09:30:00', description: 'HH:MM:SS' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Attendance marked' },
            409: { description: 'Already marked for this date' },
          },
        },
        get: {
          tags: ['Attendance'],
          summary: 'List attendance records (owner: all, trainer: assigned members)',
          parameters: [
            { in: 'query', name: 'date', schema: { type: 'string', format: 'date' }, description: 'Filter by specific date (YYYY-MM-DD)' },
          ],
          responses: { 200: { description: 'Attendance records', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/AttendanceRecord' } } } } } } } },
        },
      },
      '/attendance/checkin': {
        post: {
          tags: ['Member Portal'],
          summary: 'Member self check-in via mobile app',
          description: 'Marks attendance for today for the logged-in member. Source is set to "mobile". Idempotent — returns already_marked=true if already checked in today.',
          responses: {
            200: {
              description: 'Check-in result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          message: { type: 'string' },
                          already_marked: { type: 'boolean' },
                          source: { type: 'string', enum: ['mobile', 'biometric', 'staff', 'qr'] },
                        },
                      },
                    },
                  },
                },
              },
            },
            404: { description: 'Member profile not found' },
          },
        },
      },
      '/attendance/qr': {
        post: {
          tags: ['Attendance'],
          summary: 'QR code attendance — staff scans member QR (owner or trainer)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['member_id'], properties: { member_id: { type: 'string', format: 'uuid' } } } } },
          },
          responses: { 200: { description: 'Attendance marked via QR scan' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // TASKS
      // ════════════════════════════════════════════════════════════════════
      '/tasks': {
        post: {
          tags: ['Tasks'],
          summary: 'Create a follow-up task for a member (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['member_id', 'task_type'],
                  properties: {
                    member_id: { type: 'string', format: 'uuid' },
                    task_type: { type: 'string', enum: ['call', 'renewal', 'check_in'] },
                    assigned_trainer_id: { type: 'string', format: 'uuid', nullable: true },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 201: { description: 'Task created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Task' } } } } } } },
        },
        get: {
          tags: ['Tasks'],
          summary: 'List tasks (owner: all, trainer: assigned)',
          parameters: [
            { in: 'query', name: 'status', schema: { type: 'string', enum: ['pending', 'completed', 'cancelled'] } },
            { in: 'query', name: 'member_id', schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'assigned_trainer_id', schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { 200: { description: 'Task list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Task' } } } } } } } },
        },
      },
      '/tasks/{id}': {
        patch: {
          tags: ['Tasks'],
          summary: 'Update task status, outcome, and notes (trainer)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['completed', 'cancelled'] },
                    outcome: { type: 'string' },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Task updated' }, 404: { description: 'Task not found' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // PAYMENTS (Owner)
      // ════════════════════════════════════════════════════════════════════
      '/payments': {
        get: {
          tags: ['Payments (Owner)'],
          summary: 'List all payment records for the gym (owner only)',
          parameters: [
            { in: 'query', name: 'month', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, description: 'Filter by YYYY-MM' },
            { in: 'query', name: 'member_id', schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
          ],
          responses: {
            200: {
              description: 'Payment list with total revenue',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } },
                          total: { type: 'integer' },
                          total_amount: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/payments/report': {
        get: {
          tags: ['Payments (Owner)'],
          summary: 'Download monthly payment report as CSV (owner only)',
          parameters: [
            { in: 'query', name: 'month', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, description: 'YYYY-MM (defaults to current month)' },
          ],
          responses: {
            200: { description: 'CSV report', content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } } },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // DASHBOARD & REVENUE
      // ════════════════════════════════════════════════════════════════════
      '/dashboard/kpis': {
        get: {
          tags: ['Dashboard'],
          summary: 'Get KPI summary for owner dashboard',
          description: 'Returns total members, at-risk count, high-risk count, and total revenue recovered.',
          responses: {
            200: {
              description: 'KPI summary',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          totalMembers: { type: 'integer' },
                          activeMembers: { type: 'integer' },
                          atRiskMembers: { type: 'integer' },
                          highRiskMembers: { type: 'integer' },
                          revenueRecovered: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/revenue': {
        get: {
          tags: ['Dashboard'],
          summary: 'Get revenue analytics and monthly breakdown (owner only)',
          responses: {
            200: {
              description: 'Revenue data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          totalRevenueRecovered: { type: 'number' },
                          revenueThisMonth: { type: 'number' },
                          revenueThisYear: { type: 'number' },
                          revenueRecords: { type: 'array', items: { type: 'object' } },
                          revenue: { type: 'array', items: { type: 'object' }, description: 'Monthly breakdown' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // MEMBER PORTAL
      // ════════════════════════════════════════════════════════════════════
      '/customer/profile': {
        get: {
          tags: ['Member Portal'],
          summary: 'Get logged-in member profile with gym info',
          description: 'Returns member details, gym info, plan info, payment_enabled flag, and email/phone verification status.',
          responses: {
            200: { description: 'Member profile', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/CustomerProfile' } } } } } },
            404: { description: 'Member profile not found' },
          },
        },
        put: {
          tags: ['Member Portal'],
          summary: 'Update own profile name and email',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' } } } } },
          },
          responses: { 200: { description: 'Profile updated' } },
        },
      },
      '/customer/attendance': {
        get: {
          tags: ['Member Portal'],
          summary: 'Get own attendance records for a month',
          parameters: [
            { in: 'query', name: 'year', required: true, schema: { type: 'integer', example: 2026 } },
            { in: 'query', name: 'month', required: true, schema: { type: 'integer', example: 5 } },
          ],
          responses: {
            200: {
              description: 'Attendance records for the month',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            date: { type: 'string', format: 'date' },
                            status: { type: 'string', enum: ['present'] },
                            source: { type: 'string', enum: ['mobile', 'biometric', 'staff', 'qr'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            404: { description: 'Member profile not found' },
          },
        },
      },
      '/customer/payments': {
        get: {
          tags: ['Member Portal'],
          summary: 'Get own payment history',
          parameters: [
            { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 } },
          ],
          responses: {
            200: { description: 'Payment history', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } }, total: { type: 'integer' } } } } } } } },
            404: { description: 'Member profile not found' },
          },
        },
      },
      '/payments/create-order': {
        post: {
          tags: ['Payments (Member)'],
          summary: 'Create a Razorpay payment order (member)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', description: 'Amount in rupees' }, description: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'Razorpay order created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'integer', description: 'In paise' }, currency: { type: 'string' }, key_id: { type: 'string' } } } } } } } },
            400: { description: 'Razorpay not configured for this gym or amount invalid' },
          },
        },
      },
      '/payments/verify': {
        post: {
          tags: ['Payments (Member)'],
          summary: 'Verify Razorpay payment signature after checkout (member)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
                  properties: {
                    razorpay_order_id: { type: 'string' },
                    razorpay_payment_id: { type: 'string' },
                    razorpay_signature: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Payment verified and membership renewed' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // PROFILE (Owner/Trainer)
      // ════════════════════════════════════════════════════════════════════
      '/profile': {
        get: {
          tags: ['Profile'],
          summary: 'Get logged-in owner/trainer profile with gym info',
          responses: { 200: { description: 'User profile with gym info' } },
        },
        put: {
          tags: ['Profile'],
          summary: 'Update own profile (name, phone, email)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', format: 'email' } } } } } },
          responses: { 200: { description: 'Profile updated' } },
        },
      },
      '/profile/verify-phone': {
        post: {
          tags: ['Profile'],
          summary: 'Verify Firebase phone token and mark phone as verified on the user account',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['firebase_id_token'], properties: { firebase_id_token: { type: 'string' } } } } },
          },
          responses: { 200: { description: 'Phone verified' }, 400: { description: 'Token invalid or phone mismatch' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // BIOMETRIC
      // ════════════════════════════════════════════════════════════════════
      '/biometric/devices': {
        get: {
          tags: ['Biometric'],
          summary: 'List registered biometric devices (owner only)',
          responses: { 200: { description: 'Device list' } },
        },
        post: {
          tags: ['Biometric'],
          summary: 'Register a new ZKTeco biometric device by serial number (owner only)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['serial_number'], properties: { serial_number: { type: 'string', example: 'ZKDEV001' }, device_name: { type: 'string' } } } } } },
          responses: { 201: { description: 'Device registered' } },
        },
      },
      '/biometric/devices/{id}': {
        delete: {
          tags: ['Biometric'],
          summary: 'Remove a biometric device (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/biometric/mappings': {
        get: {
          tags: ['Biometric'],
          summary: 'List device user ID to member mappings (owner only)',
          parameters: [{ in: 'query', name: 'serial', schema: { type: 'string' }, description: 'Filter by device serial number' }],
          responses: { 200: { description: 'Mapping list' } },
        },
        put: {
          tags: ['Biometric'],
          summary: 'Map or update a device user ID to a member (owner only)',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['serial_number', 'device_user_id'],
                  properties: {
                    serial_number: { type: 'string' },
                    device_user_id: { type: 'string' },
                    member_id: { type: 'string', format: 'uuid', nullable: true },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Mapping updated' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // ADMIN (Super-admin / Platform)
      // ════════════════════════════════════════════════════════════════════
      '/admin/gyms': {
        get: {
          tags: ['Admin'],
          summary: 'List all gyms on the platform',
          description: 'Requires `Authorization: Bearer <ADMIN_SECRET>` (set via ADMIN_SECRET env var on the server).',
          responses: { 200: { description: 'All gyms with subscription and usage stats' } },
        },
      },
      '/admin/gyms/{id}/block': {
        post: {
          tags: ['Admin'],
          summary: 'Block a gym — all logins for that gym will fail',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } } },
          responses: { 200: { description: 'Gym blocked' } },
        },
      },
      '/admin/gyms/{id}/unblock': {
        post: {
          tags: ['Admin'],
          summary: 'Unblock a gym',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym unblocked' } },
        },
      },
      '/admin/gyms/{id}/suspend': {
        post: {
          tags: ['Admin'],
          summary: 'Suspend a gym subscription',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym suspended' } },
        },
      },
      '/admin/gyms/{id}/reactivate': {
        post: {
          tags: ['Admin'],
          summary: 'Reactivate a suspended gym',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym reactivated' } },
        },
      },
      '/admin/gyms/{id}/convert': {
        post: {
          tags: ['Admin'],
          summary: 'Convert gym subscription status to a specific plan',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['trial', 'active', 'suspended', 'cancelled'] } } } } } },
          responses: { 200: { description: 'Subscription status updated' } },
        },
      },
      '/admin/gyms/{id}': {
        delete: {
          tags: ['Admin'],
          summary: 'Permanently delete a gym and all its data (irreversible)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Gym and all associated data deleted' } },
        },
      },
    },
  },
  apis: [],
});

export default spec;
