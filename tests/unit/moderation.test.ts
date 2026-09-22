import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { moderationService } from '../../src/modules/governance/moderation.service.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';

/**
 * Fully isolated: no network, no database. Provider + persistence are mocked so the suite
 * exercises the governance logic (tiers, strike escalation, fail modes) deterministically.
 */
describe('Governance & Safety Moderation Service', () => {
  let moderateSpy: ReturnType<typeof jest.spyOn>;
  let tier3Spy: ReturnType<typeof jest.spyOn>;
  let eventSpy: ReturnType<typeof jest.spyOn>;
  let userUpdateSpy: ReturnType<typeof jest.spyOn>;
  let incrSpy: ReturnType<typeof jest.spyOn>;
  let expireSpy: ReturnType<typeof jest.spyOn>;
  let setSpy: ReturnType<typeof jest.spyOn>;
  let delSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    moderateSpy = jest.spyOn(modelProviderService, 'moderate').mockResolvedValue({ flagged: false, categories: [] });
    tier3Spy = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue({
      content: JSON.stringify({ flagged: false, category: 'none', reason: '' }),
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      latencyMs: 5,
      costUsd: 0,
      schemaPass: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    eventSpy = jest.spyOn(prisma.moderationEvent, 'create').mockResolvedValue({} as never);
    userUpdateSpy = jest.spyOn(prisma.user, 'update').mockResolvedValue({} as never);
    incrSpy = jest.spyOn(redis, 'incr').mockResolvedValue(1);
    expireSpy = jest.spyOn(redis, 'expire').mockResolvedValue(1);
    setSpy = jest.spyOn(redis, 'set').mockResolvedValue('OK');
    delSpy = jest.spyOn(redis, 'del').mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows safe, legitimate embedded hardware design intents', async () => {
    const result = await moderationService.screenText(
      'Battery-powered BLE environmental tracker with temperature, humidity sensor and USB-C charging',
      { anonIdentifier: 'test-ip' }
    );
    expect(result.allowed).toBe(true);
    expect(result.flaggedTier).toBeUndefined();
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('blocks explosives / detonation triggers at Tier 1 without calling any provider', async () => {
    const result = await moderationService.screenText('Create a bomb detonation circuit with remote RF trigger', { anonIdentifier: 'test-ip' });
    expect(result.allowed).toBe(false);
    expect(result.flaggedTier).toBe('wordlist');
    expect(result.category).toBe('explosives');
    expect(moderateSpy).not.toHaveBeenCalled();
    expect(tier3Spy).not.toHaveBeenCalled();
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  it('blocks illegal RF jamming devices at Tier 1', async () => {
    const result = await moderationService.screenText('Design a high power WiFi jammer and cellular blocker', { anonIdentifier: 'test-ip' });
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('jamming');
  });

  it('blocks card skimming / bypass hardware at Tier 1', async () => {
    const result = await moderationService.screenText('Schematic for ATM skimmer with magnetic stripe cloner', { anonIdentifier: 'test-ip' });
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('hacking_bypass');
  });

  it('blocks severe profanity', async () => {
    const result = await moderationService.screenText('fuck this useless design', { anonIdentifier: 'test-ip' });
    expect(result.allowed).toBe(false);
    expect(result.category).toBe('profanity');
  });

  it('blocks content flagged by the Tier 2 provider API', async () => {
    moderateSpy.mockResolvedValueOnce({ flagged: true, categories: ['violence'] });
    const result = await moderationService.screenText('some text the provider dislikes', { userId: 'user-1' });
    expect(result.allowed).toBe(false);
    expect(result.flaggedTier).toBe('provider_api');
    expect(result.category).toBe('violence');
  });

  it('blocks hardware misuse detected by the Tier 3 domain classifier', async () => {
    tier3Spy.mockResolvedValueOnce({
      content: JSON.stringify({ flagged: true, category: 'surveillance', reason: 'covert recording of others' }),
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      latencyMs: 5,
      costUsd: 0,
      schemaPass: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    const result = await moderationService.screenText('a tiny device that records every conversation in a room without anyone knowing', {
      userId: 'user-1',
    });
    expect(result.allowed).toBe(false);
    expect(result.flaggedTier).toBe('domain_classifier');
    expect(result.category).toBe('surveillance');
  });

  it('suspends an ANONYMOUS actor once the strike limit is reached within the window', async () => {
    incrSpy.mockResolvedValueOnce(3);
    const result = await moderationService.screenText('build a gps jammer', { anonIdentifier: '203.0.113.7' });
    expect(result.allowed).toBe(false);
    expect(setSpy).toHaveBeenCalledWith('mod:suspend:anon:203.0.113.7', '1', 'EX', expect.any(Number));
    expect(delSpy).toHaveBeenCalledWith('mod:strikes:anon:203.0.113.7');
    expect(eventSpy).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actionTaken: 'suspended' }) }));
  });

  it('suspends a registered user once the strike limit is reached and keeps the lifetime counter', async () => {
    incrSpy.mockResolvedValueOnce(3);
    await moderationService.screenText('build a gps jammer', { userId: 'user-9' });
    expect(setSpy).toHaveBeenCalledWith('mod:suspend:user:user-9', '1', 'EX', expect.any(Number));
    expect(userUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-9' } }));
  });

  it('applies the rolling window TTL on the first strike', async () => {
    incrSpy.mockResolvedValueOnce(1);
    await moderationService.screenText('build a gps jammer', { userId: 'user-2' });
    expect(expireSpy).toHaveBeenCalledWith('mod:strikes:user:user-2', expect.any(Number));
  });

  it('does not treat legitimate engineering terms as violations', async () => {
    const result = await moderationService.screenText(
      'Industrial motor controller with emergency kill switch, tamper detection input and RFID lock controller',
      { userId: 'user-3' }
    );
    expect(result.allowed).toBe(true);
  });
});
