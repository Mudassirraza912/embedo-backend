import crypto from 'node:crypto';
import { PDFParse } from 'pdf-parse';
import { env } from '../../../config/env.js';
import { assertSafeOutboundUrl } from '../../../common/utils/safe-url.js';
import { matchSourceDomain } from '../ekab-source-domain.service.js';
import { DocPage, htmlToStructuredText } from './ekab-extractor.js';

/**
 * Fetches one source document for the Track B scraper. Rules (contract §7.2):
 *  - only hosts on the admin's source list; RESTRICTED hosts are never requested;
 *  - robots.txt is honoured (RFC 9309), every redirect hop is re-checked by the SSRF guard;
 *  - a login page, 401/403, or paywall redirect stops the fetch: that is a gap, not something to get round;
 *  - size, time and page limits keep one document from loading the worker.
 * Only the extracted text is returned; the caller keeps passages, never the whole document.
 */

export interface AllowedDomain {
  host: string;
  publisher: string;
  defaultSourceType: string;
  accessState: string;
  enabled: boolean;
}

export interface FetchedDocument {
  finalUrl: string;
  host: string;
  status: number;
  contentType: string;
  title: string | null;
  revision: string | null;
  pages: DocPage[];
  pageCount: number;
  fingerprint: string;
}

/** The URL cannot be read for a reason the admin should see; `gapType` is what the release records. */
export class SourceBlockedError extends Error {
  constructor(
    message: string,
    public readonly gapType: 'RESTRICTED_SOURCE' | 'MISSING_SOURCE',
    public readonly httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'SourceBlockedError';
  }
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const SIGN_IN_PATH = /\/(log-?in|sign-?in|signin|sso|auth|oauth|account\/login|cas\/login|paywall|subscribe)\b/i;
const UA_TOKEN = 'embedobot';

/** PDF text can carry control characters; keep tabs and newlines, blank the rest. */
const withoutControlChars = (s: string) =>
  Array.from(s, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 && ch !== '\n' && ch !== '\t' ? ' ' : ch;
  }).join('');

// --- robots.txt (RFC 9309, the subset that matters: groups, Allow/Disallow, * and $) -------------

interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, agentToken = UA_TOKEN): RobotsRules {
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.allow.push(value);
    if (key === 'disallow' && value) current.disallow.push(value);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes('*'));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

const robotsPattern = (rule: string) =>
  new RegExp(`^${rule.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$')}`);

/** Longest matching rule wins; Allow wins a tie (RFC 9309 §2.2.2). */
export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  const best = (list: string[]) => Math.max(-1, ...list.filter((r) => robotsPattern(r).test(pathAndQuery)).map((r) => r.length));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow < 0 || allow >= disallow;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new SourceBlockedError(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 'MISSING_SOURCE', res.status);
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SourceBlockedError(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 'MISSING_SOURCE', res.status);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function timedFetch(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': env.INGEST_USER_AGENT, Accept: accept } });
  } finally {
    clearTimeout(timer);
  }
}

export class SourceFetcher {
  private robots = new Map<string, RobotsRules | 'all-disallowed'>();
  private lastRequestAt = new Map<string, number>();

  constructor(
    private readonly domains: AllowedDomain[],
    /** Pause between two requests to the same host. */
    private readonly politenessMs = 2000
  ) {}

  /** The enabled list entry for a host, or a blocked error explaining what the admin can do. */
  entryFor(hostname: string): AllowedDomain {
    const entry = matchSourceDomain(hostname, this.domains.filter((d) => d.enabled));
    if (!entry) throw new SourceBlockedError(`${hostname} is not on the source websites list (or is disabled). Add it under Source websites first.`, 'MISSING_SOURCE');
    if (entry.accessState === 'RESTRICTED') {
      throw new SourceBlockedError(`${entry.publisher} (${entry.host}) is marked RESTRICTED: its documents are behind a login or paywall, so only the reference is recorded.`, 'RESTRICTED_SOURCE');
    }
    return entry;
  }

  private async pause(host: string) {
    const wait = (this.lastRequestAt.get(host) ?? 0) + this.politenessMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt.set(host, Date.now());
  }

  private allowedHosts(): string[] {
    return this.domains.filter((d) => d.enabled && d.accessState !== 'RESTRICTED').map((d) => d.host);
  }

  private async checkRobots(url: URL) {
    let rules = this.robots.get(url.host);
    if (!rules) {
      await this.pause(url.host);
      try {
        const res = await timedFetch(`${url.protocol}//${url.host}/robots.txt`, 'text/plain,*/*;q=0.1');
        // RFC 9309 §2.3.1: 4xx = no rules; 5xx / unreachable = assume everything is disallowed.
        if (res.status >= 500) rules = 'all-disallowed';
        else if (res.ok) rules = parseRobots((await readCapped(res, 512 * 1024)).toString('utf8'));
        else rules = { allow: [], disallow: [] };
      } catch {
        rules = 'all-disallowed';
      }
      this.robots.set(url.host, rules);
    }
    if (rules === 'all-disallowed') throw new SourceBlockedError(`robots.txt of ${url.host} could not be read, so the site is treated as off-limits (RFC 9309).`, 'MISSING_SOURCE');
    if (!robotsAllows(rules, `${url.pathname}${url.search}`)) throw new SourceBlockedError(`robots.txt of ${url.host} does not allow automated reading of ${url.pathname}.`, 'MISSING_SOURCE');
  }

  async fetch(rawUrl: string): Promise<FetchedDocument> {
    let url = await assertSafeOutboundUrl(rawUrl, { allowedHosts: this.allowedHosts() }).catch((err: Error) => {
      // Explain list problems in the scraper's own words.
      this.entryFor(new URL(rawUrl).hostname);
      throw new SourceBlockedError(err.message, 'MISSING_SOURCE');
    });
    this.entryFor(url.hostname);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await this.checkRobots(url);
      await this.pause(url.host);
      let res: Response;
      try {
        res = await timedFetch(url.href, 'application/pdf,text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1');
      } catch (err) {
        throw new SourceBlockedError(`Could not reach ${url.host}: ${err instanceof Error ? err.message : String(err)}.`, 'MISSING_SOURCE');
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url);
        if (SIGN_IN_PATH.test(next.pathname)) throw new SourceBlockedError(`${url.host} redirects to a sign-in page: the document is not public.`, 'RESTRICTED_SOURCE', res.status);
        this.entryFor(next.hostname);
        url = await assertSafeOutboundUrl(next.href, { allowedHosts: this.allowedHosts() }).catch((err: Error) => {
          throw new SourceBlockedError(err.message, 'MISSING_SOURCE');
        });
        continue;
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        throw new SourceBlockedError(`${url.host} refused access (HTTP ${res.status}): login, paywall or bot protection. Not bypassed.`, 'RESTRICTED_SOURCE', res.status);
      }
      if (!res.ok) throw new SourceBlockedError(`${url.host} returned HTTP ${res.status}.`, 'MISSING_SOURCE', res.status);
      return this.read(url, res);
    }
    throw new SourceBlockedError('Too many redirects.', 'MISSING_SOURCE');
  }

  private async read(url: URL, res: Response): Promise<FetchedDocument> {
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const isPdf = contentType.includes('application/pdf') || /\.pdf$/i.test(url.pathname);
    const base = { finalUrl: url.href, host: url.host, status: res.status, contentType: contentType.split(';')[0] || 'unknown' };

    if (isPdf) {
      const buffer = await readCapped(res, Math.floor(env.INGEST_MAX_PDF_MB * 1024 * 1024));
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new SourceBlockedError('The server did not return a PDF (perhaps a cookie wall or download page).', 'MISSING_SOURCE', res.status);
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText({ first: MAX_PDF_PAGES });
        const pages = (result.pages ?? []).map((p) => ({ page: p.num, text: withoutControlChars(p.text ?? '') }));
        let title: string | null = null;
        let revision: string | null = null;
        try {
          const info = await parser.getInfo();
          const rawTitle = typeof info.info?.Title === 'string' ? info.info.Title.trim() : '';
          title = rawTitle || null;
          revision = /\(rev(?:ision)?\.?\s*([a-z0-9]+)\)/i.exec(rawTitle)?.[1]?.toUpperCase() ?? null;
        } catch {
          // metadata is optional
        }
        if (pages.every((p) => p.text.trim().length < 20)) throw new SourceBlockedError('The PDF has no extractable text (scanned images only).', 'MISSING_SOURCE', res.status);
        return { ...base, title, revision: revision ? `Rev. ${revision}` : null, pages, pageCount: result.total ?? pages.length, fingerprint: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}` };
      } catch (err) {
        if (err instanceof SourceBlockedError) throw err;
        throw new SourceBlockedError(`The PDF could not be read: ${err instanceof Error ? err.message : String(err)}.`, 'MISSING_SOURCE', res.status);
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }

    if (!/text\/html|application\/xhtml|text\/plain/.test(contentType)) throw new SourceBlockedError(`Unsupported content type "${contentType || 'none'}" (HTML, plain text and PDF are read).`, 'MISSING_SOURCE', res.status);
    const body = (await readCapped(res, MAX_HTML_BYTES)).toString('utf8');
    const fingerprint = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
    if (contentType.includes('text/plain')) return { ...base, title: null, revision: null, pages: [{ page: null, text: body }], pageCount: 1, fingerprint };
    const { title, text } = htmlToStructuredText(body);
    if (/<input[^>]+type=["']?password/i.test(body) && text.length < 4000) throw new SourceBlockedError(`${url.host} shows a sign-in form instead of the document.`, 'RESTRICTED_SOURCE', res.status);
    return { ...base, title, revision: null, pages: [{ page: null, text }], pageCount: 1, fingerprint };
  }
}
