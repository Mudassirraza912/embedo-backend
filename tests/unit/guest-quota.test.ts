import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { redis } from '../../src/db/redis.js';
import { limitsService, DEFAULT_LIMITS } from '../../src/modules/limits/limits.service.js';
import { guestQuotaService } from '../../src/modules/limits/guest-quota.service.js';
import { AppError } from '../../src/common/errors/AppError.js';

const guestLimits = { plan: 'guest', limits: DEFAULT_LIMITS.guest } as Awaited<ReturnType<typeof limitsService.forGuest>>;

describe('guestQuotaService — per-IP guest messages across tabs (1.5.4)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('allows a guest under the limit', async () => {
    jest.spyOn(limitsService, 'forGuest').mockResolvedValue(guestLimits);
    jest.spyOn(redis, 'get').mockResolvedValue('2');
    jest.spyOn(redis, 'ttl').mockResolvedValue(3600);
    await expect(guestQuotaService.assertAvailable('203.0.113.7')).resolves.toBeUndefined();
  });

  it('blocks once the IP has used its allowance, whichever tab/session it comes from, and says when it resets', async () => {
    jest.spyOn(limitsService, 'forGuest').mockResolvedValue(guestLimits);
    jest.spyOn(redis, 'get').mockResolvedValue(String(DEFAULT_LIMITS.guest.messagesPerSession));
    jest.spyOn(redis, 'ttl').mockResolvedValue(7200);
    const err = await guestQuotaService.assertAvailable('203.0.113.7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('GUEST_QUOTA_EXCEEDED');
    const resetAt = Date.parse(((err as AppError).details as { resetAt: string }).resetAt);
    expect(resetAt - Date.now()).toBeGreaterThan(7100 * 1000);
  });

  it('starts the 24-hour window on the first message only', async () => {
    const incr = jest.spyOn(redis, 'incr').mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const expire = jest.spyOn(redis, 'expire').mockResolvedValue(1);
    await guestQuotaService.consume('203.0.113.7');
    await guestQuotaService.consume('203.0.113.7');
    expect(incr).toHaveBeenCalledTimes(2);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith('quota:guest:messages:203.0.113.7', 86400);
  });

  it('never locks guests out when Redis is unavailable', async () => {
    jest.spyOn(limitsService, 'forGuest').mockResolvedValue(guestLimits);
    jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    jest.spyOn(redis, 'ttl').mockRejectedValue(new Error('redis down'));
    await expect(guestQuotaService.assertAvailable('203.0.113.7')).resolves.toBeUndefined();
  });
});
