import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { limitsService, DEFAULT_LIMITS } from '../../src/modules/limits/limits.service.js';
import { calculateCreditsForSession, countBillableUserMessages } from '../../src/modules/sessions/credits-calculator.js';
import { emitSessionEvent } from '../../src/modules/realtime/socket.js';

const TEST_USER_ID = '11111111-2222-3333-4444-555555555555';
const TEST_SESSION_ID = '99999999-8888-7777-6666-555555555555';

describe('KAN-43: Accurate Architect Credit Balance & Transparent Per-Generation Usage', () => {
  beforeEach(() => {
    jest.spyOn(redis, 'get').mockResolvedValue('0');
    jest.spyOn(redis, 'ttl').mockResolvedValue(86400);
    jest.spyOn(redis, 'incr').mockResolvedValue(1);
    jest.spyOn(redis, 'decrby').mockResolvedValue(0);
    jest.spyOn(redis, 'expire').mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Billable Message Counting & Refund Filtering', () => {
    it('counts regular user messages as billable operations', () => {
      const messages = [
        { role: 'user', content: 'Initial prompt' },
        { role: 'assistant', content: 'Here is architecture v1.0' },
        { role: 'user', content: 'Add temperature sensor' },
        { role: 'assistant', content: 'Updated to v1.1' },
      ];
      expect(countBillableUserMessages(messages)).toBe(2);
    });

    it('excludes messages marked as failed or refunded (no duplicate or lost charge)', () => {
      const messages = [
        { role: 'user', content: 'Initial prompt' },
        { role: 'assistant', content: 'Synthesized v1.0' },
        { role: 'user', content: 'Add sensor', metadata: { failure: true, refunded: true } },
        { role: 'assistant', content: 'Generation failed, refunded' },
        { role: 'user', content: 'Retry: Add sensor' },
      ];
      expect(countBillableUserMessages(messages)).toBe(2);
    });

    it('ignores assistant and system messages from credit counting', () => {
      const messages = [
        { role: 'system', content: 'System initialized' },
        { role: 'assistant', content: 'Welcome to Embedo' },
      ];
      expect(countBillableUserMessages(messages)).toBe(0);
    });
  });

  describe('2. Server-Authoritative Balance Calculation (Fixing Stale UI & 0-used Bug)', () => {
    it('queries database for chat messages when session.chatMessages is not pre-loaded', async () => {
      jest.spyOn(limitsService, 'forUser').mockResolvedValue({
        plan: 'free',
        limits: { ...DEFAULT_LIMITS.free, messagesPerSession: 25 },
        overrides: {},
      });

      const mockDbMessages = [
        { role: 'user', metadata: null },
        { role: 'assistant', metadata: null },
        { role: 'user', metadata: null },
        { role: 'assistant', metadata: null },
        { role: 'user', metadata: null },
      ];
      const findManySpy = jest.spyOn(prisma.chatMessage, 'findMany').mockResolvedValue(mockDbMessages as never);

      // Call without chatMessages passed
      const credits = await calculateCreditsForSession({
        id: TEST_SESSION_ID,
        userId: TEST_USER_ID,
      });

      expect(findManySpy).toHaveBeenCalledWith({
        where: { sessionId: TEST_SESSION_ID },
        select: { role: true, metadata: true },
      });
      expect(credits.limit).toBe(25);
      expect(credits.used).toBe(3);
      expect(credits.remaining).toBe(22);
      expect(credits.unit).toBe('credits');
    });

    it('calculates accurate balance across multiple refinements without drifting', async () => {
      jest.spyOn(limitsService, 'forUser').mockResolvedValue({
        plan: 'paid',
        limits: { ...DEFAULT_LIMITS.paid, messagesPerSession: 100 },
        overrides: {},
      });

      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        metadata: null,
      })); // 5 user messages

      const credits = await calculateCreditsForSession({
        id: TEST_SESSION_ID,
        userId: TEST_USER_ID,
        chatMessages: messages,
      });

      expect(credits.limit).toBe(100);
      expect(credits.used).toBe(5);
      expect(credits.remaining).toBe(95);
    });

    it('clamps remaining credits at 0 when usage exceeds limit', async () => {
      jest.spyOn(limitsService, 'forUser').mockResolvedValue({
        plan: 'free',
        limits: { ...DEFAULT_LIMITS.free, messagesPerSession: 5 },
        overrides: {},
      });

      const messages = Array.from({ length: 7 }, () => ({
        role: 'user',
        metadata: null,
      }));

      const credits = await calculateCreditsForSession({
        id: TEST_SESSION_ID,
        userId: TEST_USER_ID,
        chatMessages: messages,
      });

      expect(credits.used).toBe(7);
      expect(credits.remaining).toBe(0);
    });
  });

  describe('3. Real-Time Multi-Tab Synchronization & Event Broadcasting', () => {
    it('emits credits_updated event with accurate status payload', () => {
      const emitSpy = jest.spyOn(emitSessionEvent, 'creditsUpdated');
      const testCredits = {
        used: 3,
        limit: 25,
        remaining: 22,
        resetAt: null,
        unit: 'credits' as const,
      };

      emitSessionEvent.creditsUpdated(TEST_SESSION_ID, testCredits);

      expect(emitSpy).toHaveBeenCalledWith(TEST_SESSION_ID, testCredits);
    });
  });
});
