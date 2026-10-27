import { afterEach, beforeAll, afterAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';

describe('GitHub verified email authentication', () => {
  const app = createApp();
  const originalClientId = env.GITHUB_CLIENT_ID;
  const originalClientSecret = env.GITHUB_CLIENT_SECRET;

  beforeAll(() => {
    (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = originalClientId || 'mock-client-id';
    (env as { GITHUB_CLIENT_SECRET?: string }).GITHUB_CLIENT_SECRET = originalClientSecret || 'mock-client-secret';
  });

  afterAll(() => {
    (env as { GITHUB_CLIENT_ID?: string }).GITHUB_CLIENT_ID = originalClientId;
    (env as { GITHUB_CLIENT_SECRET?: string }).GITHUB_CLIENT_SECRET = originalClientSecret;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not trust an unverified profile email when the verified-email endpoint has no verified address', async () => {
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'github-access-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123, login: 'test-user', email: 'unverified@example.test' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { email: 'unverified@example.test', primary: true, verified: false },
        ],
      } as Response);

    const response = await request(app)
      .post('/api/v1/auth/github')
      .send({ code: 'github-auth-code' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('Your GitHub account does not have a verified email address');
  });
});
