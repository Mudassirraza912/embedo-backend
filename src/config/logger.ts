import pino from 'pino';
import { env } from './env.js';

/**
 * Structured JSON logger. Sensitive fields are redacted at the logger level so a stray
 * `logger.info({ req })` or `{ body }` can never leak credentials into the log sink.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      'newPassword',
      'passwordConfirmation',
      'hashedPassword',
      'refreshToken',
      'accessToken',
      'resetToken',
      'resetUrl',
      'token',
      'idToken',
      'apiKey',
      'authorization',
      '*.password',
      '*.newPassword',
      '*.hashedPassword',
      '*.refreshToken',
      '*.accessToken',
      '*.resetToken',
      '*.resetUrl',
      '*.token',
      '*.idToken',
      '*.apiKey',
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-anon-session-token"]',
      'res.headers["set-cookie"]',
    ],
    censor: '[REDACTED]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
