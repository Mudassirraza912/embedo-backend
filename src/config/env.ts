import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? undefined : v))
  .optional();

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PREFIX: z.string().default('/api/v1'),
    CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:3000'),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    // Refresh tokens are opaque random bytes hashed at rest; this secret is not used to sign anything.
    // Kept optional for backwards compatibility with existing .env files.
    JWT_REFRESH_SECRET: optionalString,
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Global per-IP limiter (all other limiters are fixed-policy, see rate-limit.middleware.ts)
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    // Absolute per-IP daily cap on paid generations (session creations)
    SESSION_CREATE_DAILY_MAX_PER_IP: z.coerce.number().int().positive().default(50),

    // AI providers. OPENAI_API_KEY is required in production (Sol/Luna + embeddings + moderation all route to it).
    ANTHROPIC_API_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    GOOGLE_AI_API_KEY: optionalString,

    // Google Sign-In. When unset, /auth/google is refused (never skips audience verification).
    GOOGLE_CLIENT_ID: optionalString,

    // Model route cache TTL (seconds). Changes to model_routes propagate within this window without a restart.
    ROUTE_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),

    // Moderation behaviour when a provider check errors. Defaults: closed in production, open elsewhere.
    MODERATION_FAIL_MODE: z.enum(['open', 'closed']).optional(),
    MODERATION_TIER3_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    MODERATION_STRIKE_LIMIT: z.coerce.number().int().positive().default(3),
    MODERATION_STRIKE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
    MODERATION_SUSPENSION_SECONDS: z.coerce.number().int().positive().default(86400),

    // Operator dashboards (Bull Board, Swagger in production). Basic-auth credentials; admin JWT also accepted.
    DASHBOARD_USER: optionalString,
    DASHBOARD_PASSWORD: optionalString,

    // Outbound email (password reset). When unset, reset emails are not sent and the API logs a warning.
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    MAIL_FROM: optionalString,

    // Datasheet ingestion hardening
    INGEST_ALLOWED_DOMAINS: optionalString, // comma-separated hostnames; when unset any public https host is allowed
    INGEST_MAX_PDF_MB: z.coerce.number().positive().default(25),
    INGEST_USER_AGENT: z.string().default('EmbedoBot/1.0 (+https://embedo.ai; datasheet-indexer)'),

    R2_ACCOUNT_ID: optionalString,
    R2_ACCESS_KEY_ID: optionalString,
    R2_SECRET_ACCESS_KEY: optionalString,
    R2_BUCKET_NAME: z.string().default('embedo-exports'),
    R2_PUBLIC_URL: optionalString,

    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
  })
  .superRefine((cfg, ctx) => {
    const isProd = cfg.NODE_ENV === 'production';

    const looksLikePlaceholder = (v: string): boolean =>
      /your[-_ ]?(secret|key|password)|change[-_ ]?me|placeholder|example|^embedo/i.test(v);

    if (isProd) {
      if (!cfg.OPENAI_API_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPENAI_API_KEY'],
          message: 'OPENAI_API_KEY is required in production (generation, embeddings and moderation depend on it).',
        });
      }
      if (looksLikePlaceholder(cfg.JWT_ACCESS_SECRET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_ACCESS_SECRET'],
          message: 'JWT_ACCESS_SECRET looks like a placeholder/default value. Generate a random secret for production.',
        });
      }
      if (cfg.DASHBOARD_PASSWORD && cfg.DASHBOARD_PASSWORD.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DASHBOARD_PASSWORD'],
          message: 'DASHBOARD_PASSWORD must be at least 16 characters in production.',
        });
      }
    }

    if (cfg.OPENAI_API_KEY && /^sk-mock|^sk-test/i.test(cfg.OPENAI_API_KEY) && isProd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is a mock/test key; refusing to start in production.',
      });
    }
  });

const parseEnv = () => {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables on startup:');
    console.error(JSON.stringify(result.error.format(), null, 2));
    process.exit(1);
  }
  const cfg = result.data;
  return {
    ...cfg,
    MODERATION_FAIL_MODE: cfg.MODERATION_FAIL_MODE ?? (cfg.NODE_ENV === 'production' ? 'closed' : 'open'),
  };
};

export const env = parseEnv();
export type Env = typeof env;
