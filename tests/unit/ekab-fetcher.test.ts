import { describe, it, expect, jest, afterEach } from '@jest/globals';
import dns from 'node:dns/promises';
import { parseRobots, robotsAllows, SourceBlockedError, SourceFetcher } from '../../src/modules/ekab/scrape/ekab-fetcher.js';

const domains = [
  { host: '.rfc-editor.org', publisher: 'IETF', defaultSourceType: 'STANDARD', accessState: 'PUBLIC', enabled: true },
  { host: '.ieee.org', publisher: 'IEEE', defaultSourceType: 'STANDARD', accessState: 'RESTRICTED', enabled: true },
  { host: '.ti.com', publisher: 'Texas Instruments', defaultSourceType: 'APP_NOTE', accessState: 'PUBLIC', enabled: false },
];

type Reply = { status?: number; body?: string; headers?: Record<string, string> };
function mockFetch(routes: Record<string, Reply>) {
  const calls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: '' };
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'text/html' } });
  }) as typeof fetch);
  return calls;
}

const blocked = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof SourceBlockedError ? err : null;
  }
};

/** The scraper only reads public, allowlisted documents and never works around access controls. */
describe('Track B source fetcher', () => {
  afterEach(() => jest.restoreAllMocks());
  const publicDns = () => jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '192.0.2.10', family: 4 }] as never);

  it('parses robots.txt groups and applies longest-match with Allow winning ties', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public.html\n\nUser-agent: OtherBot\nDisallow: /');
    expect(robotsAllows(rules, '/rfc/rfc9000.html')).toBe(true);
    expect(robotsAllows(rules, '/private/x.pdf')).toBe(false);
    expect(robotsAllows(rules, '/private/public.html')).toBe(true);
    expect(robotsAllows(parseRobots('User-agent: EmbedoBot\nDisallow: /docs/\n\nUser-agent: *\nDisallow:'), '/docs/a')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.pdf$'), '/a/b.pdf')).toBe(false);
  });

  it('never requests a RESTRICTED site and reports it as a restricted-source gap', async () => {
    const calls = mockFetch({});
    const err = await blocked(new SourceFetcher(domains, 0).fetch('https://standards.ieee.org/ieee/802.3/10422/'));
    expect(err?.gapType).toBe('RESTRICTED_SOURCE');
    expect(calls).toEqual([]);
  });

  it('refuses hosts that are not on the list or are disabled', async () => {
    publicDns();
    const calls = mockFetch({});
    expect((await blocked(new SourceFetcher(domains, 0).fetch('https://example.org/spec.pdf')))?.message).toMatch(/not on the source websites list/);
    expect((await blocked(new SourceFetcher(domains, 0).fetch('https://www.ti.com/lit/an/x.pdf')))?.message).toMatch(/not on the source websites list/);
    expect(calls).toEqual([]);
  });

  it('honours robots.txt', async () => {
    publicDns();
    mockFetch({ 'https://www.rfc-editor.org/robots.txt': { body: 'User-agent: *\nDisallow: /rfc/', headers: { 'content-type': 'text/plain' } } });
    const err = await blocked(new SourceFetcher(domains, 0).fetch('https://www.rfc-editor.org/rfc/rfc9000.html'));
    expect(err?.message).toMatch(/robots\.txt/);
  });

  it('treats 403 and sign-in redirects as access controls, not something to retry around', async () => {
    publicDns();
    mockFetch({
      'https://www.rfc-editor.org/robots.txt': { status: 404 },
      'https://www.rfc-editor.org/a.html': { status: 403 },
      'https://www.rfc-editor.org/b.html': { status: 302, headers: { location: '/login?next=/b.html' } },
    });
    const fetcher = new SourceFetcher(domains, 0);
    expect((await blocked(fetcher.fetch('https://www.rfc-editor.org/a.html')))?.gapType).toBe('RESTRICTED_SOURCE');
    expect((await blocked(fetcher.fetch('https://www.rfc-editor.org/b.html')))?.message).toMatch(/sign-in/);
  });

  it('reads an allowed HTML page into structured text', async () => {
    publicDns();
    mockFetch({
      'https://www.rfc-editor.org/robots.txt': { status: 404 },
      'https://www.rfc-editor.org/rfc/rfc0000.html': { body: '<html><head><title>RFC 0000</title></head><body><h2>3. Rules</h2><p>A node MUST reply.</p></body></html>' },
    });
    const doc = await new SourceFetcher(domains, 0).fetch('https://www.rfc-editor.org/rfc/rfc0000.html');
    expect(doc.title).toBe('RFC 0000');
    expect(doc.pages[0]!.text).toContain('## 3. Rules');
    expect(doc.fingerprint).toMatch(/^sha256:/);
  });
});
