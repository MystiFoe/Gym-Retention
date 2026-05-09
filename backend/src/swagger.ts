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
- **Owner/Staff login**: \`POST /api/auth/login\` with email + password + role
- **Member login**: \`POST /api/auth/login\` with email + password + role=member
- **Token refresh**: \`POST /api/auth/refresh\` — supply refresh_token, get new pair
- **Phone OTP login** (owner/staff only): Firebase phone OTP → \`POST /api/auth/verify-firebase\`

## Staff & Member Onboarding
1. Owner generates invite code via \`POST /api/invite-codes\`
2. Shares 8-char code with person
3. Person calls \`POST /api/auth/staff/register\` or \`POST /api/auth/member/register\`

## Member Registration with Verification
1. \`POST /api/auth/member/send-email-otp\` — validate invite, send OTP to email
2. Client does Firebase phone OTP verification (gets firebaseIdToken)
3. \`POST /api/auth/member/register\` — with emailOtpKey, emailOtp, firebaseIdToken

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
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        MemberInput: {
          type: 'object',
          required: ['name', 'phone', 'membership_expiry_date'],
          properties: {
            name: { type: 'string', minLength: 2, example: 'Rahul Kumar' },
            phone: { type: 'string', example: '+919876543210' },
            email: { type: 'string', format: 'email' },
            plan: { type: 'string', example: 'monthly' },
            plan_fee: { type: 'number', example: 1500 },
            membership_expiry_date: { type: 'string', format: 'date', example: '2026-06-30' },
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
            check_in_time: { type: 'string', format: 'time', nullable: true },
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
      { name: 'Auth', description: 'Authentication — login, register, refresh, OTP' },
      { name: 'Gym Registration', description: 'Business / gym self-registration flow' },
      { name: 'Gyms', description: 'Gym profile & subscription management' },
      { name: 'Members', description: 'Owner/trainer member CRUD' },
      { name: 'Trainers', description: 'Owner trainer management' },
      { name: 'Attendance', description: 'Mark & view attendance' },
      { name: 'Tasks', description: 'Follow-up task management' },
      { name: 'Invite Codes', description: 'Invite code generation & validation' },
      { name: 'Payments (Owner)', description: 'Owner payment history & Razorpay setup' },
      { name: 'Payments (Member)', description: 'Member payment portal' },
      { name: 'Member Portal', description: 'Self-service endpoints for logged-in members' },
      { name: 'Biometric', description: 'ZKTeco biometric device integration' },
      { name: 'Profile', description: 'Logged-in user profile' },
      { name: 'Admin', description: 'Super-admin platform management' },
    ],
    paths: {
      // ════════════════════════════════════════════════════════════════════
      // AUTH
      // ════════════════════════════════════════════════════════════════════
      '/auth/login': {
        post: {
          tags: ['Auth'],
          summary: 'Login with email/phone + password',
          description: 'Authenticates owner, trainer, or member. Returns access + refresh tokens. For members, also returns member_id in the token payload.',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
          responses: {
            200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            403: { description: 'Account blocked or suspended' },
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['Auth'],
          summary: 'Refresh access token',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } } },
          },
          responses: {
            200: { description: 'New token pair issued', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            401: { description: 'Invalid or expired refresh token' },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['Auth'],
          summary: 'Logout (client-side token discard)',
          description: 'No server-side state — tokens are stateless JWTs. This endpoint exists for FCM token cleanup.',
          responses: { 200: { description: 'OK' } },
        },
      },
      '/auth/forgot-password': {
        post: {
          tags: ['Auth'],
          summary: 'Request password reset email',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
          },
          responses: {
            200: { description: 'Reset link sent (if email exists)' },
          },
        },
      },
      '/auth/reset-password': {
        post: {
          tags: ['Auth'],
          summary: 'Reset password using token from email',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['token', 'new_password'],
                  properties: {
                    token: { type: 'string' },
                    new_password: { type: 'string', minLength: 8, description: 'Min 8 chars, 1 uppercase, 1 number, 1 special char' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Password reset successful' },
            400: { description: 'Invalid or expired token' },
          },
        },
      },
      '/auth/verify-firebase': {
        post: {
          tags: ['Auth'],
          summary: 'Exchange Firebase phone ID token for app JWT (owner/trainer only)',
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
            404: { description: 'No account found for this phone' },
          },
        },
      },
      '/auth/fcm-token': {
        put: {
          tags: ['Auth'],
          summary: 'Register FCM push notification token',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['fcm_token'], properties: { fcm_token: { type: 'string' } } } } },
          },
          responses: { 200: { description: 'Token saved' } },
        },
      },

      // ── Gym Registration (public multi-step flow) ─────────────────────
      '/gyms/register': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 1 — Submit business registration + send email OTP',
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
            200: { description: 'Pending registration created, OTP sent', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { pendingId: { type: 'string' }, ownerEmail: { type: 'string' } } } } } } } },
            409: { description: 'Email already registered' },
          },
        },
      },
      '/gyms/verify-email': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 2 — Verify email OTP',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['pendingId', 'otpCode'], properties: { pendingId: { type: 'string' }, otpCode: { type: 'string', minLength: 6, maxLength: 6 } } } } },
          },
          responses: {
            200: { description: 'Email verified, proceed to phone verification' },
            400: { description: 'Invalid OTP' },
          },
        },
      },
      '/gyms/complete-registration': {
        post: {
          tags: ['Gym Registration'],
          summary: 'Step 3 — Verify phone via Firebase, create gym + owner account',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['pendingId', 'firebase_id_token'], properties: { pendingId: { type: 'string' }, firebase_id_token: { type: 'string' } } } } },
          },
          responses: {
            201: { description: 'Gym created, owner logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
          },
        },
      },

      // ── Staff Self-Registration ───────────────────────────────────────
      '/auth/staff/register': {
        post: {
          tags: ['Auth'],
          summary: 'Staff self-registration using invite code',
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
            201: { description: 'Account created, logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Invalid or expired invite code' },
            409: { description: 'Email already registered' },
          },
        },
      },

      // ── Member Self-Registration ──────────────────────────────────────
      '/auth/member/send-email-otp': {
        post: {
          tags: ['Auth'],
          summary: 'Send email OTP for member registration verification',
          description: 'Step 1 of member registration. Validates invite code and sends a 6-digit OTP to the provided email. Returns a tempKey to be used in /auth/member/register.',
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
            200: { description: 'OTP sent', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { tempKey: { type: 'string', description: 'Pass this to /auth/member/register as emailOtpKey' } } } } } } } },
            400: { description: 'Invalid invite code' },
          },
        },
      },
      '/auth/member/register': {
        post: {
          tags: ['Auth'],
          summary: 'Member self-registration using invite code',
          description: 'Creates member user account. Pass emailOtpKey + emailOtp (from send-email-otp) and firebaseIdToken (from Firebase phone OTP) to verify contacts and set verified flags on the member record.',
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
            201: { description: 'Member account created, logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } },
            400: { description: 'Invalid invite code or OTP' },
            409: { description: 'Email already registered' },
          },
        },
      },
      '/auth/invite-code/validate': {
        post: {
          tags: ['Invite Codes'],
          summary: 'Validate an invite code (public)',
          security: [],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: 'ABCD1234' } } } } },
          },
          responses: {
            200: { description: 'Valid code info returned', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { type: { type: 'string', enum: ['staff', 'member'] }, gym_name: { type: 'string' }, display_id: { type: 'string' }, trainer_role: { type: 'string', nullable: true }, placeholder_name: { type: 'string', nullable: true } } } } } } } },
            400: { description: 'Invalid or expired code' },
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
          responses: { 200: { description: 'Gym profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/Gym' } } } } },
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
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/gyms/{gymId}/subscription': {
        get: {
          tags: ['Gyms'],
          summary: 'Get subscription status',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Subscription details' } },
        },
      },
      '/gyms/{gymId}/billing/create-order': {
        post: {
          tags: ['Gyms'],
          summary: 'Create Razorpay order for gym subscription',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['plan'], properties: { plan: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] } } } } },
          },
          responses: { 200: { description: 'Order created' } },
        },
      },
      '/gyms/{gymId}/billing/verify-payment': {
        post: {
          tags: ['Gyms'],
          summary: 'Verify Razorpay payment for gym subscription',
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
          summary: 'List all members',
          parameters: [
            { in: 'query', name: 'status', schema: { type: 'string', enum: ['active', 'at_risk', 'high_risk'] } },
            { in: 'query', name: 'search', schema: { type: 'string' }, description: 'Search by name/phone/email' },
            { in: 'query', name: 'trainer_id', schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50, maximum: 200 } },
          ],
          responses: {
            200: { description: 'Member list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Member' } }, total: { type: 'integer' } } } } } },
          },
        },
        post: {
          tags: ['Members'],
          summary: 'Add a single member',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberInput' } } } },
          responses: {
            201: { description: 'Member created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Member' } } } } } },
          },
        },
      },
      '/members/{id}': {
        put: {
          tags: ['Members'],
          summary: 'Update member details',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MemberInput' } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          tags: ['Members'],
          summary: 'Soft-delete member (GDPR erase)',
          description: 'Anonymises name, phone, email with unique placeholders. Sets is_deleted=true.',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Member erased' } },
        },
      },
      '/members/bulk-import': {
        post: {
          tags: ['Members'],
          summary: 'Bulk import members from CSV/Excel data',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['members'],
                  properties: {
                    trainer_id: { type: 'string', format: 'uuid', nullable: true },
                    members: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/MemberInput' },
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Import summary with created/skipped counts' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // TRAINERS
      // ════════════════════════════════════════════════════════════════════
      '/trainers': {
        get: {
          tags: ['Trainers'],
          summary: 'List all trainers/staff',
          responses: { 200: { description: 'Trainer list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Trainer' } } } } } } } },
        },
        post: {
          tags: ['Trainers'],
          summary: 'Add a trainer (creates pending slot + invite code)',
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
          responses: { 201: { description: 'Trainer slot created' } },
        },
      },
      '/trainers/me': {
        get: {
          tags: ['Trainers'],
          summary: 'Get own trainer profile (trainer role only)',
          responses: { 200: { description: 'Trainer profile' } },
        },
      },
      '/trainers/{id}': {
        patch: {
          tags: ['Trainers'],
          summary: 'Update trainer details',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } } } },
          responses: { 200: { description: 'Updated' } },
        },
        delete: {
          tags: ['Trainers'],
          summary: 'Remove trainer',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/trainers/{id}/role': {
        put: {
          tags: ['Trainers'],
          summary: 'Promote or demote trainer role (owner only)',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['trainer_role'], properties: { trainer_role: { type: 'string', enum: ['staff', 'admin'] } } } } } },
          responses: { 200: { description: 'Role updated' } },
        },
      },
      '/trainers/{id}/members': {
        put: {
          tags: ['Trainers'],
          summary: 'Assign/unassign members to a trainer',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_ids', 'action'], properties: { member_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, action: { type: 'string', enum: ['add', 'remove'] } } } } } },
          responses: { 200: { description: 'Assignment updated' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // INVITE CODES
      // ════════════════════════════════════════════════════════════════════
      '/invite-codes': {
        post: {
          tags: ['Invite Codes'],
          summary: 'Generate invite code for a member or trainer slot',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['type'],
                  properties: {
                    type: { type: 'string', enum: ['staff', 'member'] },
                    member_id: { type: 'string', format: 'uuid', description: 'Required for member type' },
                    trainer_id: { type: 'string', format: 'uuid', description: 'Required for staff type' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Invite code created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/InviteCode' } } } } } },
          },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // ATTENDANCE (Owner/Trainer)
      // ════════════════════════════════════════════════════════════════════
      '/attendance': {
        post: {
          tags: ['Attendance'],
          summary: 'Mark attendance for a member (staff/owner)',
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
                    check_in_time: { type: 'string', format: 'time', example: '09:30:00' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: 'Attendance marked' },
            409: { description: 'Already marked for today' },
          },
        },
        get: {
          tags: ['Attendance'],
          summary: 'List attendance records',
          parameters: [
            { in: 'query', name: 'date', schema: { type: 'string', format: 'date' }, description: 'Filter by specific date' },
          ],
          responses: { 200: { description: 'Attendance records', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/AttendanceRecord' } } } } } } } },
        },
      },
      '/attendance/{memberId}': {
        get: {
          tags: ['Attendance'],
          summary: 'Get attendance for a specific member by month',
          parameters: [
            { in: 'path', name: 'memberId', required: true, schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'month', required: true, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$', example: '2026-05' } },
          ],
          responses: { 200: { description: 'Present dates list', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { presentDates: { type: 'array', items: { type: 'string', format: 'date' } } } } } } } } } },
        },
      },
      '/attendance/checkin': {
        post: {
          tags: ['Member Portal'],
          summary: 'Member self check-in (mobile app)',
          description: 'Marks attendance for the logged-in member for today. Source is set to "mobile". Idempotent — returns already_marked=true if already done today.',
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
          },
        },
      },
      '/attendance/qr': {
        post: {
          tags: ['Attendance'],
          summary: 'QR code attendance — staff scans member QR',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_id'], properties: { member_id: { type: 'string', format: 'uuid' } } } } } },
          responses: { 200: { description: 'Attendance marked via QR scan' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // TASKS
      // ════════════════════════════════════════════════════════════════════
      '/tasks': {
        post: {
          tags: ['Tasks'],
          summary: 'Create follow-up task for a member',
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
          summary: 'List tasks',
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
          summary: 'Update task (status, outcome, notes)',
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
          responses: { 200: { description: 'Task updated' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // PAYMENTS (Owner)
      // ════════════════════════════════════════════════════════════════════
      '/payments': {
        get: {
          tags: ['Payments (Owner)'],
          summary: 'List all gym payments',
          parameters: [
            { in: 'query', name: 'month', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
            { in: 'query', name: 'member_id', schema: { type: 'string', format: 'uuid' } },
            { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
            { in: 'query', name: 'limit', schema: { type: 'integer', default: 50 } },
          ],
          responses: { 200: { description: 'Payment list with total revenue', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } }, total: { type: 'integer' }, total_amount: { type: 'number' } } } } } } } } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // MEMBER PORTAL
      // ════════════════════════════════════════════════════════════════════
      '/customer/profile': {
        get: {
          tags: ['Member Portal'],
          summary: 'Get logged-in member profile',
          description: 'Returns member details, gym info, plan info, and payment_enabled flag. Includes email_verified and phone_verified badges.',
          responses: { 200: { description: 'Member profile', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/CustomerProfile' } } } } } } },
        },
        put: {
          tags: ['Member Portal'],
          summary: 'Update own profile (name, email)',
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
          summary: 'Get own attendance for a month',
          parameters: [
            { in: 'query', name: 'year', required: true, schema: { type: 'integer', example: 2026 } },
            { in: 'query', name: 'month', required: true, schema: { type: 'integer', example: 5 } },
          ],
          responses: {
            200: {
              description: 'Attendance records',
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
          responses: { 200: { description: 'Payment history', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } }, total: { type: 'integer' } } } } } } } } },
        },
      },
      '/payments/create-order': {
        post: {
          tags: ['Payments (Member)'],
          summary: 'Create Razorpay payment order (member)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', description: 'Amount in rupees' }, description: { type: 'string' } } } } },
          },
          responses: { 200: { description: 'Razorpay order created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'integer', description: 'In paise' }, currency: { type: 'string' }, key_id: { type: 'string' } } } } } } } } },
          400: { description: 'Razorpay not configured or amount invalid' },
        },
      },
      '/payments/verify': {
        post: {
          tags: ['Payments (Member)'],
          summary: 'Verify Razorpay payment after checkout (member)',
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
          responses: { 200: { description: 'Payment verified, membership updated' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // BIOMETRIC
      // ════════════════════════════════════════════════════════════════════
      '/biometric/devices': {
        get: {
          tags: ['Biometric'],
          summary: 'List registered biometric devices',
          responses: { 200: { description: 'Device list' } },
        },
        post: {
          tags: ['Biometric'],
          summary: 'Register a new biometric device by serial number',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['serial_number'], properties: { serial_number: { type: 'string', example: 'ZKDEV001' }, device_name: { type: 'string' } } } } } },
          responses: { 201: { description: 'Device registered' } },
        },
      },
      '/biometric/devices/{id}': {
        delete: {
          tags: ['Biometric'],
          summary: 'Remove a biometric device',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'Deleted' } },
        },
      },
      '/biometric/mappings': {
        get: {
          tags: ['Biometric'],
          summary: 'List device user ID → member mappings',
          parameters: [{ in: 'query', name: 'serial', schema: { type: 'string' } }],
          responses: { 200: { description: 'Mapping list' } },
        },
        put: {
          tags: ['Biometric'],
          summary: 'Map or update a device user ID to a member',
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
      // PROFILE
      // ════════════════════════════════════════════════════════════════════
      '/profile': {
        get: {
          tags: ['Profile'],
          summary: 'Get logged-in user profile (owner/trainer)',
          responses: { 200: { description: 'User profile with gym info' } },
        },
        put: {
          tags: ['Profile'],
          summary: 'Update own profile',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } } } } } },
          responses: { 200: { description: 'Updated' } },
        },
      },
      '/profile/change-password': {
        post: {
          tags: ['Profile'],
          summary: 'Change own password',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['current_password', 'new_password'], properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 8 } } } } },
          },
          responses: { 200: { description: 'Password changed' }, 400: { description: 'Wrong current password' } },
        },
      },

      // ════════════════════════════════════════════════════════════════════
      // ADMIN (Super-admin / Platform)
      // ════════════════════════════════════════════════════════════════════
      '/admin/gyms': {
        get: {
          tags: ['Admin'],
          summary: 'List all gyms on the platform',
          description: 'Requires X-Admin-Key header.',
          parameters: [{ in: 'header', name: 'X-Admin-Key', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Gym list with subscription status' } },
        },
      },
      '/admin/gyms/{gymId}/block': {
        post: {
          tags: ['Admin'],
          summary: 'Block / unblock a gym',
          parameters: [
            { in: 'header', name: 'X-Admin-Key', required: true, schema: { type: 'string' } },
            { in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['block'], properties: { block: { type: 'boolean' }, reason: { type: 'string' } } } } } },
          responses: { 200: { description: 'Gym blocked/unblocked' } },
        },
      },
      '/admin/gyms/{gymId}/subscription': {
        put: {
          tags: ['Admin'],
          summary: 'Override gym subscription status',
          parameters: [
            { in: 'header', name: 'X-Admin-Key', required: true, schema: { type: 'string' } },
            { in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['trial', 'active', 'suspended', 'cancelled'] } } } } } },
          responses: { 200: { description: 'Subscription updated' } },
        },
      },
    },
  },
  apis: [],
});

export default spec;
