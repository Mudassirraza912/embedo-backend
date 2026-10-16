import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { env } from '../../src/config/env.js';

describe('Auth Google Account Linking Flow', () => {
  const app = createApp();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prompts with ACCOUNT_LINK_REQUIRED when an existing password account is found without linkAccount confirmation', async () => {
    const mockEmail = 'engineer@example.com';
    const mockGoogleSub = 'google-sub-12345';

    // Mock Google tokeninfo endpoint
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        aud: env.GOOGLE_CLIENT_ID || 'mock-client-id',
        iss: 'https://accounts.google.com',
        sub: mockGoogleSub,
        email: mockEmail,
        email_verified: 'true',
      }),
    } as Response);

    // No existing Google authIdentity
    jest.spyOn(prisma.user, 'findFirst')
      .mockResolvedValueOnce(null) // by authIdentity
      .mockResolvedValueOnce({    // by email (existing password user)
        id: 'user-existing-1',
        email: mockEmail,
        hashedPassword: '$2a$12$someHashedPassword',
        suspendedAt: null,
        deletedAt: null,
        role: 'user',
      } as never);

    const res = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: 'valid-google-id-token' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    expect(res.body.error.details.email).toBe(mockEmail);
    expect(res.body.error.message).toContain('Would you like to link your Google account');
  });

  it('successfully links Google identity and signs in when linkAccount: true is provided', async () => {
    const mockEmail = 'engineer@example.com';
    const mockGoogleSub = 'google-sub-12345';

    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        aud: env.GOOGLE_CLIENT_ID || 'mock-client-id',
        iss: 'https://accounts.google.com',
        sub: mockGoogleSub,
        email: mockEmail,
        email_verified: 'true',
      }),
    } as Response);

    const existingUser = {
      id: 'user-existing-1',
      email: mockEmail,
      hashedPassword: '$2a$12$someHashedPassword',
      suspendedAt: null,
      deletedAt: null,
      role: 'user',
    };

    jest.spyOn(prisma.user, 'findFirst')
      .mockResolvedValueOnce(null) // by authIdentity
      .mockResolvedValueOnce(existingUser as never); // by email

    jest.spyOn(prisma.authIdentity, 'findFirst').mockResolvedValueOnce(null);
    const createIdentitySpy = jest.spyOn(prisma.authIdentity, 'create').mockResolvedValueOnce({
      id: 'auth-id-1',
      userId: existingUser.id,
      provider: 'google',
      providerUserId: mockGoogleSub,
      createdAt: new Date(),
    } as never);

    jest.spyOn(prisma.refreshToken, 'create').mockResolvedValueOnce({
      id: 'rt-1',
      userId: existingUser.id,
    } as never);

    const res = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: 'valid-google-id-token', linkAccount: true });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body.user.email).toBe(mockEmail);
    expect(createIdentitySpy).toHaveBeenCalledWith({
      data: {
        userId: existingUser.id,
        provider: 'google',
        providerUserId: mockGoogleSub,
      },
    });
  });
});
