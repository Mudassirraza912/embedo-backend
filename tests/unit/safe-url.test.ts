import { describe, it, expect } from '@jest/globals';
import { assertSafeOutboundUrl, isPrivateAddress } from '../../src/common/utils/safe-url.js';

describe('SSRF guard', () => {
  it('classifies private and metadata ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '::1', '0.0.0.0']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it('rejects non-https, credentials, localhost and IP-literal private hosts', async () => {
    await expect(assertSafeOutboundUrl('http://example.com/a.pdf')).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertSafeOutboundUrl('https://user:pw@example.com/a.pdf')).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertSafeOutboundUrl('https://localhost/a.pdf')).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertSafeOutboundUrl('https://169.254.169.254/latest')).rejects.toMatchObject({ statusCode: 400 });
    await expect(assertSafeOutboundUrl('https://[::1]/a.pdf')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('enforces the host allowlist when configured', async () => {
    await expect(assertSafeOutboundUrl('https://8.8.8.8/x.pdf', { allowedHosts: ['.ti.com'] })).rejects.toMatchObject({ statusCode: 400 });
  });
});
