import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { limitsService, DEFAULT_LIMITS } from '../../src/modules/limits/limits.service.js';
import { guestQuotaService } from '../../src/modules/limits/guest-quota.service.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { aiPipelineQueue } from '../../src/jobs/ai-pipeline.queue.js';

const mockRouterReply = {
  content: JSON.stringify({ mode: 'discuss', projectTitle: 'Controller', isGibberish: false, isNewProject: false, reply: 'Hello!', isAnswerToPendingQuestion: false }),
  inputTokens: 10,
  outputTokens: 10,
  cachedTokens: 0,
  latencyMs: 5,
  costUsd: 0.0001,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o-mini',
  aiCallId: 'call-1',
};

const TEST_ANON_TOKEN = 'a'.repeat(64);
const TEST_USER_UUID = '00000000-0000-0000-0000-000000000001';

describe('KAN-19: Credits-Based Usage Across Architect & Prototype Modes', () => {
  beforeEach(() => {
    jest.spyOn(redis, 'get').mockResolvedValue('0');
    jest.spyOn(redis, 'ttl').mockResolvedValue(86400);
    jest.spyOn(redis, 'incr').mockResolvedValue(1);
    jest.spyOn(redis, 'decrby').mockResolvedValue(0);
    jest.spyOn(redis, 'expire').mockResolvedValue(1);
    jest.spyOn(prisma.moderationEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as never);
    jest.spyOn(aiPipelineQueue, 'add').mockResolvedValue({} as never);
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(mockRouterReply);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Unified Credits Endpoint & Accounting', () => {
    it('returns credits object with unit="credits" for guest IP', async () => {
      jest.spyOn(limitsService, 'forGuest').mockResolvedValue({
        plan: 'guest',
        limits: DEFAULT_LIMITS.guest,
      } as never);
      jest.spyOn(redis, 'get').mockResolvedValue('2');
      jest.spyOn(redis, 'ttl').mockResolvedValue(3600);

      const credits = await sessionsService.getCredits(undefined, '192.168.1.100');

      expect(credits.unit).toBe('credits');
      expect(credits.limit).toBe(DEFAULT_LIMITS.guest.messagesPerSession);
      expect(credits.used).toBe(2);
      expect(credits.remaining).toBe(DEFAULT_LIMITS.guest.messagesPerSession - 2);
      expect(credits.resetAt).not.toBeNull();
    });

    it('returns credits object for authenticated users based on plan limits', async () => {
      jest.spyOn(limitsService, 'forUser').mockResolvedValue({
        plan: 'free',
        limits: DEFAULT_LIMITS.free,
      } as never);

      const credits = await sessionsService.getCredits(TEST_USER_UUID, '192.168.1.100');

      expect(credits.unit).toBe('credits');
      expect(credits.limit).toBe(DEFAULT_LIMITS.free.messagesPerSession);
      expect(credits.remaining).toBe(DEFAULT_LIMITS.free.messagesPerSession);
    });
  });

  describe('2. Architect Mode Credit Consumption & Enforcement', () => {
    it('consumes credit and returns updated credits on Architect session creation', async () => {
      const mockSession = {
        id: 'arch-session-1',
        title: 'Smart Controller',
        status: 'PENDING',
        applicationContext: 'hardware_synthesis',
        intentText: 'Smart temperature controller with LCD and relay',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.designSession, 'create').mockResolvedValue(mockSession as never);
      jest.spyOn(prisma.designSession, 'update').mockResolvedValue(mockSession as never);
      jest.spyOn(prisma.chatMessage, 'create').mockResolvedValue({} as never);
      const consumeSpy = jest.spyOn(guestQuotaService, 'consume').mockResolvedValue();
      jest.spyOn(redis, 'get').mockResolvedValue('1');
      jest.spyOn(redis, 'ttl').mockResolvedValue(86400);

      const result = await sessionsService.createSession(
        { intentText: 'Smart temperature controller with LCD and relay', type: 'architect' },
        undefined,
        undefined,
        '192.168.1.50'
      );

      expect(consumeSpy).toHaveBeenCalledWith('192.168.1.50');
      expect(result.credits).toBeDefined();
      expect(result.credits?.unit).toBe('credits');
      expect(result.credits?.used).toBe(1);
    });

    it('blocks Architect discuss request with GUEST_QUOTA_EXCEEDED when credit allowance is exhausted', async () => {
      const mockSession = {
        id: 'arch-session-exhausted',
        userId: null,
        anonSessionToken: TEST_ANON_TOKEN,
        title: 'Smart Controller',
        status: 'CLARIFICATION_REQUIRED',
        applicationContext: 'hardware_synthesis',
        chatMessages: Array(6).fill({ role: 'user', content: 'test turn' }),
        architecture: null,
        userFeedback: [],
        designOutcome: null,
        deletedAt: null,
      };

      jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue(mockSession as never);
      jest.spyOn(redis, 'get').mockResolvedValue('6');
      jest.spyOn(redis, 'ttl').mockResolvedValue(7200);

      await expect(
        sessionsService.discuss(
          'arch-session-exhausted',
          { messages: [{ role: 'user', content: 'Add Wi-Fi' }], type: 'architect' },
          undefined,
          TEST_ANON_TOKEN,
          '192.168.1.50'
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'GUEST_QUOTA_EXCEEDED',
        details: expect.objectContaining({ unit: 'credits', remaining: 0 }),
      });
    });
  });

  describe('3. Prototype Mode Credit Consumption & Enforcement', () => {
    it('consumes credit and returns updated credits on Prototype session creation', async () => {
      const mockSession = {
        id: 'proto-session-1',
        title: 'Pico Breadboard Kit',
        status: 'PENDING',
        applicationContext: 'rapid_prototyping',
        intentText: 'Raspberry Pi Pico with BME280 sensor breakout',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest.spyOn(prisma.designSession, 'create').mockResolvedValue(mockSession as never);
      jest.spyOn(prisma.designSession, 'update').mockResolvedValue(mockSession as never);
      jest.spyOn(prisma.chatMessage, 'create').mockResolvedValue({} as never);
      const consumeSpy = jest.spyOn(guestQuotaService, 'consume').mockResolvedValue();
      jest.spyOn(redis, 'get').mockResolvedValue('1');
      jest.spyOn(redis, 'ttl').mockResolvedValue(86400);

      const result = await sessionsService.createSession(
        { intentText: 'Raspberry Pi Pico with BME280 sensor breakout', type: 'prototype' },
        undefined,
        undefined,
        '192.168.1.55'
      );

      expect(consumeSpy).toHaveBeenCalledWith('192.168.1.55');
      expect(result.credits).toBeDefined();
      expect(result.credits?.unit).toBe('credits');
      expect(result.credits?.used).toBe(1);
    });

    it('blocks Prototype discuss request with GUEST_QUOTA_EXCEEDED when credit allowance is exhausted', async () => {
      const mockSession = {
        id: 'proto-session-exhausted',
        userId: null,
        anonSessionToken: TEST_ANON_TOKEN,
        title: 'Pico Breadboard Kit',
        status: 'CLARIFICATION_REQUIRED',
        applicationContext: 'rapid_prototyping',
        chatMessages: Array(6).fill({ role: 'user', content: 'test turn' }),
        architecture: null,
        userFeedback: [],
        designOutcome: null,
        deletedAt: null,
      };

      jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue(mockSession as never);
      jest.spyOn(redis, 'get').mockResolvedValue('6');
      jest.spyOn(redis, 'ttl').mockResolvedValue(3600);

      await expect(
        sessionsService.discuss(
          'proto-session-exhausted',
          { messages: [{ role: 'user', content: 'Connect I2C to GPIO 4 and 5' }], type: 'prototype' },
          undefined,
          TEST_ANON_TOKEN,
          '192.168.1.55'
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'GUEST_QUOTA_EXCEEDED',
        details: expect.objectContaining({ unit: 'credits', remaining: 0 }),
      });
    });
  });

  describe('4. Credit Rollback on Failure & Resilience', () => {
    it('rolls back consumed guest credit when session creation fails', async () => {
      const rollbackSpy = jest.spyOn(guestQuotaService, 'rollback').mockResolvedValue();
      jest.spyOn(prisma.designSession, 'create').mockRejectedValueOnce(new Error('Database error'));

      await expect(
        sessionsService.createSession(
          { intentText: 'Failing design brief', type: 'architect' },
          undefined,
          undefined,
          '192.168.1.70'
        )
      ).rejects.toThrow();

      expect(rollbackSpy).toHaveBeenCalledWith('192.168.1.70');
    });

    it('rolls back consumed guest credit when message persistence fails during discuss', async () => {
      const mockSession = {
        id: 'arch-session-fail',
        userId: null,
        anonSessionToken: TEST_ANON_TOKEN,
        title: 'Smart Controller',
        status: 'CLARIFICATION_REQUIRED',
        applicationContext: 'hardware_synthesis',
        chatMessages: [],
        architecture: null,
        userFeedback: [],
        designOutcome: null,
        deletedAt: null,
      };

      jest.spyOn(redis, 'get').mockResolvedValue('0');
      jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue(mockSession as never);
      jest.spyOn(prisma.chatMessage, 'create').mockRejectedValueOnce(new Error('Database write error'));
      const rollbackSpy = jest.spyOn(guestQuotaService, 'rollback').mockResolvedValue();

      await expect(
        sessionsService.discuss(
          'arch-session-fail',
          { messages: [{ role: 'user', content: 'Explain this circuit' }], type: 'architect' },
          undefined,
          TEST_ANON_TOKEN,
          '192.168.1.70'
        )
      ).rejects.toThrow('Database write error');

      expect(rollbackSpy).toHaveBeenCalledWith('192.168.1.70');
    });
  });
});
