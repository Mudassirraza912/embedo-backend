import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { emailService } from '../../src/common/services/email.service.js';
import { env } from '../../src/config/env.js';

describe('Auth OTP & Verification Flows (isolated)', () => {
  const app = createApp();

  beforeEach(() => {
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    jest.spyOn(redis, 'set').mockResolvedValue('OK');
    jest.spyOn(redis, 'del').mockResolvedValue(1);
    jest.spyOn(redis, 'ttl').mockResolvedValue(550);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/auth/register', () => {
    it('validates email, password length, and dataConsent', async () => {
      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'invalid-email',
        password: 'short',
        dataConsent: false,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects registration if an account already exists with 409 CONFLICT', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'u1', email: 'existing@embedo.ai' } as never);

      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'existing@embedo.ai',
        password: 'Password123!',
        dataConsent: true,
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('already exists');
    });

    it('enforces 30-second cooldown rate limit if requested in quick succession', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue(null);
      jest.spyOn(redis, 'get').mockImplementation(async (key: string) => {
        if (key.startsWith('otp_cooldown:')) return '1';
        return null;
      });

      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'rapid@embedo.ai',
        password: 'Password123!',
        dataConsent: true,
      });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.body.error.message).toContain('Please wait 30 seconds');
    });

    it('generates 5-digit OTP, stores in Redis, sends email, and returns pending_verification status', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue(null);
      const sendOtpSpy = jest.spyOn(emailService, 'sendOtpVerification').mockResolvedValue(undefined);
      const setRedisSpy = jest.spyOn(redis, 'set').mockResolvedValue('OK');

      const res = await request(app).post('/api/v1/auth/register').send({
        email: 'newuser@embedo.ai',
        fullName: 'New User',
        password: 'SecurePassword123!',
        dataConsent: true,
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending_verification');
      expect(res.body.email).toBe('newuser@embedo.ai');
      expect(res.body.cooldownSeconds).toBe(30);

      expect(sendOtpSpy).toHaveBeenCalledTimes(1);
      const [to, otp] = sendOtpSpy.mock.calls[0] as [string, string];
      expect(to).toBe('newuser@embedo.ai');
      expect(otp).toMatch(/^\d{5}$/);

      // Verifies Redis storage
      expect(setRedisSpy).toHaveBeenCalledWith(
        'pending_reg:newuser@embedo.ai',
        expect.stringContaining('otpHash'),
        'EX',
        600
      );
      expect(setRedisSpy).toHaveBeenCalledWith(
        'otp_cooldown:newuser@embedo.ai',
        '1',
        'EX',
        30
      );
    });
  });

  describe('POST /api/v1/auth/verify-otp', () => {
    it('rejects invalid email or non-5-digit OTP format with 400', async () => {
      const res = await request(app).post('/api/v1/auth/verify-otp').send({
        email: 'bad-email',
        otp: '123',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects when verification code has expired or was not requested', async () => {
      jest.spyOn(redis, 'get').mockResolvedValue(null);

      const res = await request(app).post('/api/v1/auth/verify-otp').send({
        email: 'expired@embedo.ai',
        otp: '12345',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toContain('expired or is invalid');
    });

    it('decrements attempts and rejects when incorrect code is provided', async () => {
      // crypto sha256 hash of '99999'
      const crypto = await import('node:crypto');
      const correctHash = crypto.createHash('sha256').update('99999').digest('hex');

      const pendingRecord = {
        otpHash: correctHash,
        email: 'test@embedo.ai',
        hashedPassword: '$2a$12$somehashedpassword',
        attemptsRemaining: 5,
        dataConsent: true,
      };

      jest.spyOn(redis, 'get').mockResolvedValue(JSON.stringify(pendingRecord));
      const setRedisSpy = jest.spyOn(redis, 'set').mockResolvedValue('OK');

      const res = await request(app).post('/api/v1/auth/verify-otp').send({
        email: 'test@embedo.ai',
        otp: '11111', // wrong code
      });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).toContain('4 attempt(s) remaining');
      expect(setRedisSpy).toHaveBeenCalledWith(
        'pending_reg:test@embedo.ai',
        expect.stringContaining('"attemptsRemaining":4'),
        'EX',
        expect.any(Number)
      );
    });

    it('successfully registers user, issues tokens and sets cookie on correct OTP', async () => {
      const crypto = await import('node:crypto');
      const correctHash = crypto.createHash('sha256').update('54321').digest('hex');

      const pendingRecord = {
        otpHash: correctHash,
        email: 'success@embedo.ai',
        hashedPassword: '$2a$12$somehashedpassword',
        attemptsRemaining: 5,
        dataConsent: true,
      };

      jest.spyOn(redis, 'get').mockResolvedValue(JSON.stringify(pendingRecord));
      const delRedisSpy = jest.spyOn(redis, 'del').mockResolvedValue(1);

      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue(null);
      jest.spyOn(prisma.user, 'create').mockResolvedValue({
        id: 'u-success-1',
        email: 'success@embedo.ai',
        role: 'user',
        expertiseLevel: null,
        dataConsent: true,
        suspendedAt: null,
        deletedAt: null,
      } as never);

      jest.spyOn(prisma.refreshToken, 'create').mockResolvedValue({
        id: 'rt-1',
        userId: 'u-success-1',
      } as never);

      const res = await request(app).post('/api/v1/auth/verify-otp').send({
        email: 'success@embedo.ai',
        otp: '54321',
      });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('success@embedo.ai');
      expect(res.body).toHaveProperty('accessToken');
      expect(res.headers['set-cookie']).toBeDefined();
      expect(delRedisSpy).toHaveBeenCalledWith(['pending_reg:success@embedo.ai', 'otp_cooldown:success@embedo.ai']);
    });
  });

  describe('POST /api/v1/auth/resend-otp', () => {
    it('enforces 30-second cooldown rate limit on resend', async () => {
      jest.spyOn(redis, 'get').mockImplementation(async (key: string) => {
        if (key.startsWith('otp_cooldown:')) return '1';
        return null;
      });

      const res = await request(app).post('/api/v1/auth/resend-otp').send({
        email: 'cooldown@embedo.ai',
      });

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('successfully resends fresh OTP and resets attempts to 5', async () => {
      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue(null);
      const pendingRecord = {
        otpHash: 'oldhash',
        email: 'resend@embedo.ai',
        hashedPassword: '$2a$12$password',
        attemptsRemaining: 2,
        dataConsent: true,
      };

      jest.spyOn(redis, 'get').mockImplementation(async (key: string) => {
        if (key.startsWith('pending_reg:')) return JSON.stringify(pendingRecord);
        return null;
      });

      const sendOtpSpy = jest.spyOn(emailService, 'sendOtpVerification').mockResolvedValue(undefined);
      const setRedisSpy = jest.spyOn(redis, 'set').mockResolvedValue('OK');

      const res = await request(app).post('/api/v1/auth/resend-otp').send({
        email: 'resend@embedo.ai',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cooldownSeconds).toBe(30);

      expect(sendOtpSpy).toHaveBeenCalledTimes(1);
      const [, otp] = sendOtpSpy.mock.calls[0] as [string, string];
      expect(otp).toMatch(/^\d{5}$/);

      expect(setRedisSpy).toHaveBeenCalledWith(
        'pending_reg:resend@embedo.ai',
        expect.stringContaining('"attemptsRemaining":5'),
        'EX',
        600
      );
    });
  });

  describe('GitHub SSO and Auth Config', () => {
    it('returns 503 PROVIDER_UNAVAILABLE when GitHub client credentials are not configured', async () => {
      const origId = env.GITHUB_CLIENT_ID;
      (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = undefined;

      const res = await request(app).post('/api/v1/auth/github').send({
        code: 'any-github-code',
      });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');

      (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = origId;
    });

    it('returns both Google and GitHub client ids in /auth/config', async () => {
      const origGoogle = env.GOOGLE_CLIENT_ID;
      const origGithub = env.GITHUB_CLIENT_ID;

      (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = 'google-123';
      (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = 'github-456';

      const res = await request(app).get('/api/v1/auth/config');
      expect(res.status).toBe(200);
      expect(res.body.googleClientId).toBe('google-123');
      expect(res.body.githubClientId).toBe('github-456');

      (env as { GOOGLE_CLIENT_ID?: string }).GOOGLE_CLIENT_ID = origGoogle;
      (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = origGithub;
    });
  });
});
