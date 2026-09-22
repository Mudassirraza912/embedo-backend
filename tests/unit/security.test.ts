import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { AppError } from '../../src/common/errors/AppError.js';

describe('Security & Multi-Tenancy Hardening', () => {
  const app = createApp();

  describe('Session Ownership & IDOR Protection', () => {
    it('should allow user accessing their own session', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: 'user-123', anonSessionToken: null },
          'user-123'
        );
      }).not.toThrow();
    });

    it('should reject user accessing another user session (403 Forbidden)', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: 'user-123', anonSessionToken: null },
          'user-456'
        );
      }).toThrow(AppError);
    });

    it('should reject unauthenticated caller accessing a user session (403 Forbidden)', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: 'user-123', anonSessionToken: null },
          undefined,
          undefined
        );
      }).toThrow(AppError);
    });

    it('should allow guest accessing guest session with valid anonSessionToken', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: null, anonSessionToken: 'token-abc-123' },
          undefined,
          'token-abc-123'
        );
      }).not.toThrow();
    });

    it('should reject guest accessing guest session with wrong anonSessionToken (403 Forbidden)', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: null, anonSessionToken: 'token-abc-123' },
          undefined,
          'wrong-token'
        );
      }).toThrow(AppError);
    });

    it('should reject authenticated user accessing guest session without guest token (403 Forbidden)', () => {
      expect(() => {
        sessionsService.verifySessionOwnership(
          { userId: null, anonSessionToken: 'token-abc-123' },
          'user-789',
          undefined
        );
      }).toThrow(AppError);
    });
  });

  describe('Input Validation & Boundary Protections', () => {
    it('should reject invalid UUID session parameter with 400', async () => {
      const response = await request(app).get('/api/v1/sessions/invalid-not-a-uuid/architecture');
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject session creation with oversized intentText (> 2000 chars)', async () => {
      const longIntent = 'A'.repeat(2500);
      const response = await request(app)
        .post('/api/v1/sessions')
        .send({ intentText: longIntent });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
