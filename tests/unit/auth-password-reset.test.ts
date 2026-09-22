import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { emailService } from '../../src/common/services/email.service.js';

describe('Auth Password Reset Flow (isolated)', () => {
  const app = createApp();

  beforeEach(() => {
    jest.spyOn(redis, 'getdel').mockResolvedValue(null);
    jest.spyOn(redis, 'set').mockResolvedValue('OK');
    jest.spyOn(redis, 'del').mockResolvedValue(1);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('POST /api/v1/auth/forgot-password', () => {
    it('validates email format', async () => {
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns the generic message when the email does not exist (anti-enumeration)', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue(null);
      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nonexistent-user@embedo.ai' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('If an account exists');
      expect(res.body).not.toHaveProperty('resetToken');
    });

    it('NEVER returns the reset token in the response, even when the account exists', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'u1', email: 'real@embedo.ai', suspendedAt: null, deletedAt: null } as never);
      const sendSpy = jest.spyOn(emailService, 'sendPasswordReset').mockResolvedValue(undefined);
      Object.defineProperty(emailService, 'isConfigured', { value: true, configurable: true });

      const res = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'real@embedo.ai' });
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('resetToken');
      expect(JSON.stringify(res.body)).not.toMatch(/reset-password\?token=/);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [to, url] = sendSpy.mock.calls[0] as [string, string];
      expect(to).toBe('real@embedo.ai');
      expect(url).toMatch(/\/reset-password\?token=[a-f0-9]{64}$/);
    });
  });

  describe('POST /api/v1/auth/reset-password', () => {
    it('validates minimum password length', async () => {
      const res = await request(app).post('/api/v1/auth/reset-password').send({ token: 'sample-token', newPassword: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an invalid or expired reset token with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: 'completely-invalid-or-expired-token', newPassword: 'validPassword123!' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toContain('Invalid or expired password reset link');
    });
  });
});
