export const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Embedo.ai Backend API',
    version: '1.0.0',
    description: `### Embedo.ai — Embedded Hardware Systems Generation API
Interactive API documentation and playground for frontend developers and client integrations.
Includes endpoints for Authentication, Multi-turn Discuss-First Hardware Copilot, 7-Step AI Architecture Synthesis, and Telemetry.`,
    contact: {
      name: 'Embedo.ai Engineering Team',
      url: 'https://embedo.ai',
    },
  },
  servers: [
    {
      url: 'http://localhost:4000/api/v1',
      description: 'Local Development Server',
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT Access Token provided in Authorization header',
      },
      AnonSessionToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-anon-session-token',
        description: 'Anonymous session identifier for freemium users',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'SESSION_NOT_FOUND' },
              message: { type: 'string', example: 'Design session not found' },
              requestId: { type: 'string', example: 'd83c271b-21d4-4a4b-84a1-43efb27d42cf' },
              details: { type: 'object' },
            },
            required: ['code', 'message', 'requestId'],
          },
        },
      },
      CreateSessionRequest: {
        type: 'object',
        required: ['intentText'],
        properties: {
          intentText: {
            type: 'string',
            example: 'Battery-powered BLE environmental sensor logging temperature and CO2 with USB-C charging.',
            description: 'Natural language hardware requirements prompt',
          },
          forceGenerate: {
            type: 'boolean',
            default: false,
            description: 'Bypass the sufficiency gate and synthesize immediately',
          },
          domain: {
            type: 'string',
            example: 'wearable',
          },
          applicationContext: {
            type: 'string',
            example: 'industrial_iot',
          },
        },
      },
      DiscussRequest: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            items: {
              type: 'object',
              required: ['role', 'content'],
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'system'], example: 'user' },
                content: { type: 'string', example: 'Please add a tamper detection input and replace relay outputs with SSRs.' },
              },
            },
          },
        },
      },
      ArchitectureResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              status: { type: 'string', example: 'DONE' },
              architecture: {
                type: 'object',
                properties: {
                  projectMeta: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', example: 'Smart Access Control Terminal' },
                      tagline: { type: 'string', example: 'ESP32-S3 access terminal with SSR outputs' },
                      controller: { type: 'string', example: 'ESP32-S3' },
                    },
                  },
                  summary: {
                    type: 'object',
                    properties: {
                      mcu: { type: 'string', example: 'ESP32-S3' },
                      powerInput: { type: 'string', example: '9V – 24V DC Input' },
                      outputs: { type: 'string', example: '4x SSR (Solid State Relays)' },
                      interfaces: { type: 'string', example: 'RFID, BLE, Keypad, LCD' },
                      inputs: { type: 'string', example: 'Tamper, User Inputs' },
                      estimatedBomCostUsd: { type: 'number', example: 18.4 },
                    },
                  },
                  refineSuggestions: {
                    type: 'array',
                    items: { type: 'string' },
                    example: ['Add battery backup', 'Add Wi-Fi connectivity', 'Optimize for low power'],
                  },
                  functionalBlock: { type: 'object' },
                  powerTree: { type: 'object' },
                  protocolMap: { type: 'object' },
                  bom: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        partNumber: { type: 'string', example: 'ESP32-S3-MINI-1' },
                        manufacturer: { type: 'string', example: 'Espressif' },
                        category: { type: 'string', example: 'Microcontroller' },
                        description: { type: 'string', example: 'Dual-core Xtensa LX7 MCU with Wi-Fi & BLE' },
                        qty: { type: 'number', example: 1 },
                        unitCostUsd: { type: 'number', example: 2.5 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      FeedbackRequest: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['accepted', 'rejected', 'modified'], example: 'accepted' },
          rating: { type: 'integer', minimum: 1, maximum: 5, example: 5 },
          notes: { type: 'string', example: 'Accurate power topology and pinout mapping.' },
          timeToActionSeconds: { type: 'integer', example: 45 },
          modifications: { type: 'object' },
        },
      },
      OutcomeRequest: {
        type: 'object',
        properties: {
          fabricated: { type: 'boolean', example: true },
          workedFirstTime: { type: 'boolean', example: true },
          iterationsToWorking: { type: 'integer', example: 1 },
          feedbackNotes: { type: 'string', example: 'PCB was fabricated with JLCPCB and booted on first try.' },
        },
      },
      ExportRequest: {
        type: 'object',
        required: ['format'],
        properties: {
          format: { type: 'string', enum: ['kicad', 'altium', 'svg', 'json'], example: 'json' },
        },
      },
      RegisterRequest: {
        type: 'object',
        required: ['email', 'password', 'dataConsent'],
        properties: {
          email: { type: 'string', format: 'email', example: 'engineer@embedo.ai' },
          password: { type: 'string', minLength: 8, example: 'SecurePassword123!' },
          dataConsent: { type: 'boolean', example: true, description: 'Must be true for model training consent' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', example: 'engineer@embedo.ai' },
          password: { type: 'string', example: 'SecurePassword123!' },
        },
      },
      GoogleAuthRequest: {
        type: 'object',
        required: ['idToken'],
        properties: {
          idToken: { type: 'string', example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6...', description: 'Google OAuth ID Token or Credential' },
          expertiseLevel: { type: 'string', enum: ['student', 'hobbyist', 'professional', 'expert'], example: 'professional' },
          dataConsent: { type: 'boolean', default: true, description: 'Training consent flag' },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Service Health Check',
        tags: ['System'],
        responses: {
          200: {
            description: 'Backend service is healthy',
          },
        },
      },
    },
    '/auth/register': {
      post: {
        summary: 'Register New User',
        tags: ['Auth'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RegisterRequest' },
            },
          },
        },
        responses: {
          201: { description: 'Registration successful' },
          400: { description: 'Validation error or consent missing' },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'User Login',
        tags: ['Auth'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/LoginRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Login successful' },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/auth/google': {
      post: {
        summary: 'Sign In / Register with Google OAuth',
        tags: ['Auth'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GoogleAuthRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Google authentication successful, returns user & JWT + sets refresh cookie' },
          401: { description: 'Invalid or expired Google token' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        summary: 'Rotate Refresh Token & Issue New Access Token',
        tags: ['Auth'],
        responses: {
          200: { description: 'Token refreshed' },
          401: { description: 'Invalid or revoked refresh token' },
        },
      },
    },
    '/auth/logout': {
      post: {
        summary: 'Logout & Revoke Token Family',
        tags: ['Auth'],
        responses: {
          200: { description: 'Logged out successfully' },
        },
      },
    },
    '/users/me': {
      get: {
        summary: 'Get Current Authenticated User Profile',
        tags: ['Users'],
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: 'Profile returned' },
          401: { description: 'Unauthorized' },
        },
      },
      delete: {
        summary: 'Soft Delete User Account & Scrub PII',
        tags: ['Users'],
        security: [{ BearerAuth: [] }],
        responses: {
          200: { description: 'Account deleted and PII scrubbed' },
        },
      },
    },
    '/sessions': {
      post: {
        summary: 'Create Hardware Design Session & Trigger AI Synthesis',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateSessionRequest' },
            },
          },
        },
        responses: {
          201: { description: 'Session created and enqueued' },
          400: { description: 'Content policy violation or validation failure' },
        },
      },
    },
    '/sessions/{id}': {
      get: {
        summary: 'Get Design Session Metadata, Chat & Feedback',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'Session retrieved' },
          404: { description: 'Session not found' },
        },
      },
    },
    '/sessions/{id}/discuss': {
      post: {
        summary: 'Discuss-First Hardware Copilot (Luna Tier Chat)',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DiscussRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Copilot reply generated and architecture updated' },
        },
      },
    },
    '/sessions/{id}/architecture': {
      get: {
        summary: 'Get Synthesized Diagrams (Functional, Power, Protocol) & BOM',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'Architecture retrieved successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ArchitectureResponse' },
              },
            },
          },
          404: { description: 'Architecture not generated or session not found' },
        },
      },
    },
    '/sessions/{id}/versions': {
      get: {
        summary: 'List All Historical Version Snapshots (v1.0, v1.1, v1.2...)',
        tags: ['Version Control'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'List of versions returned' },
          404: { description: 'Session not found' },
        },
      },
    },
    '/sessions/{id}/versions/{version}': {
      get: {
        summary: 'Retrieve Diagrams & BOM for a Specific Historical Version',
        tags: ['Version Control'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'string' }, example: 'v1.0' },
        ],
        responses: {
          200: { description: 'Version snapshot returned' },
          404: { description: 'Version not found' },
        },
      },
    },
    '/sessions/{id}/versions/{version}/rollback': {
      post: {
        summary: 'Rollback Active Architecture to a Previous Version',
        tags: ['Version Control'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'string' }, example: 'v1.0' },
        ],
        responses: {
          200: { description: 'Rollback successful' },
        },
      },
    },
    '/sessions/{id}/feedback': {
      post: {
        summary: 'Submit Telemetry / Feedback on Generated Architecture',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/FeedbackRequest' },
            },
          },
        },
        responses: {
          201: { description: 'Feedback logged into data moat' },
        },
      },
    },
    '/sessions/{id}/outcome': {
      post: {
        summary: 'Track Real-world Hardware Fabrication Outcome',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OutcomeRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Outcome recorded' },
        },
      },
    },
    '/sessions/{id}/export': {
      post: {
        summary: 'Export Architecture to EDA (KiCad, Altium, JSON, SVG)',
        tags: ['Design Sessions'],
        security: [{ BearerAuth: [] }, { AnonSessionToken: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExportRequest' },
            },
          },
        },
        responses: {
          200: { description: 'Export package generated' },
        },
      },
    },
  },
};
