import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { resolveTrustedClientIp } from '../../src/modules/analytics/client-ip.js';
import { StubGeoLookupProvider, geoLookupProvider } from '../../src/modules/analytics/geo-lookup.js';
import { regionalUsageService } from '../../src/modules/analytics/regional-usage.service.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('resolveTrustedClientIp', () => {
  it('normalises an IPv4-mapped IPv6 address', () => {
    expect(resolveTrustedClientIp({ ip: '::ffff:203.0.113.7' })).toBe('203.0.113.7');
  });

  it('passes through a plain IPv4/IPv6 address unchanged', () => {
    expect(resolveTrustedClientIp({ ip: '203.0.113.7' })).toBe('203.0.113.7');
    expect(resolveTrustedClientIp({ ip: '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('never reads X-Forwarded-For itself: only req.ip (Express trust-proxy output) decides the address', () => {
    // A caller handing in a request-shaped object with a spoofed header but no matching req.ip
    // must not have the header influence the result — this function only ever looks at req.ip.
    const spoofed = { ip: '198.51.100.9', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' } };
    expect(resolveTrustedClientIp(spoofed)).toBe('198.51.100.9');
  });

  it('falls back to "unknown" when req.ip is empty', () => {
    expect(resolveTrustedClientIp({ ip: undefined as unknown as string })).toBe('unknown');
  });
});

describe('StubGeoLookupProvider', () => {
  it('always reports unknown, never a guessed country', async () => {
    const provider = new StubGeoLookupProvider();
    const result = await provider.lookup('203.0.113.7');
    expect(result).toEqual({ status: 'unknown', countryCode: null, regionCode: null, source: 'none', sourceVersion: null });
  });

  it('is the provider wired into the service by default', () => {
    expect(geoLookupProvider).toBeInstanceOf(StubGeoLookupProvider);
  });
});

describe('regionalUsageService.recordEvent', () => {
  it('stores a signed-in event under userId only, never the guest token too', async () => {
    const create = jest.spyOn(prisma.visitorRegionEvent, 'create').mockResolvedValue({} as never);
    await regionalUsageService.recordEvent({
      eventType: 'login',
      userId: 'user-1',
      anonSessionToken: 'guest-token-should-be-dropped',
      ip: '203.0.113.7',
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ eventType: 'login', userId: 'user-1', anonSessionToken: null, geoStatus: 'unknown', countryCode: null, regionCode: null, geoSource: 'none' });
  });

  it('stores a guest event under anonSessionToken only', async () => {
    const create = jest.spyOn(prisma.visitorRegionEvent, 'create').mockResolvedValue({} as never);
    await regionalUsageService.recordEvent({
      eventType: 'guest_session_init',
      anonSessionToken: 'guest-token-1',
      ip: '203.0.113.7',
    });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ eventType: 'guest_session_init', userId: null, anonSessionToken: 'guest-token-1' });
  });

  it('never stores a country/region when the geo lookup is unknown (no fabrication)', async () => {
    const create = jest.spyOn(prisma.visitorRegionEvent, 'create').mockResolvedValue({} as never);
    await regionalUsageService.recordEvent({ eventType: 'workspace_entered', mode: 'prototype', ip: '203.0.113.7' });
    const data = (create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.countryCode).toBeNull();
    expect(data.regionCode).toBeNull();
    expect(data.geoStatus).toBe('unknown');
  });

  it('swallows a write failure instead of throwing (never breaks the calling request)', async () => {
    jest.spyOn(prisma.visitorRegionEvent, 'create').mockRejectedValue(new Error('db down'));
    await expect(regionalUsageService.recordEvent({ eventType: 'login', userId: 'user-1', ip: '203.0.113.7' })).resolves.toBeUndefined();
  });
});
