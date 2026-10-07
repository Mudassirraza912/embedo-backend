import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { assertSafeOutboundUrl } from '../../../common/utils/safe-url.js';

/**
 * Fetches a vendor product page for hardware sourcing (plan E5: the product page is used for
 * identity and published specs; it is untrusted data, never instructions). Only allowlisted maker
 * and chip-vendor sites are fetched, every redirect hop is re-checked by the SSRF guard, and only
 * a fingerprint of the content is ever stored.
 */

export const DEFAULT_VENDOR_DOMAINS = [
  '.adafruit.com',
  '.sparkfun.com',
  '.seeedstudio.com',
  '.dfrobot.com',
  '.pololu.com',
  '.waveshare.com',
  '.pimoroni.com',
  '.espressif.com',
  '.raspberrypi.com',
  '.arduino.cc',
  '.st.com',
  '.nordicsemi.com',
  '.m5stack.com',
];

export const vendorDomains = (): string[] => {
  const configured = env.HARDWARE_ALLOWED_DOMAINS?.split(',').map((d) => d.trim()).filter(Boolean);
  return configured && configured.length > 0 ? configured : DEFAULT_VENDOR_DOMAINS;
};

export const isAllowedVendorUrl = (raw: string | null | undefined): boolean => {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return vendorDomains().some((d) => (d.startsWith('.') ? host.endsWith(d) || host === d.slice(1) : host === d));
  } catch {
    return false;
  }
};

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 24_000;
const MAX_REDIRECTS = 4;

/** Visible text of an HTML page, keeping row/line structure so pin tables stay readable. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table|\/section)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

export interface VendorPage {
  url: string;
  text: string;
  fingerprint: string;
  status: number;
}

export async function fetchVendorPage(rawUrl: string): Promise<VendorPage> {
  const allowedHosts = vendorDomains();
  let current = (await assertSafeOutboundUrl(rawUrl, { allowedHosts })).href;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': env.INGEST_USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        // Every hop must still be an allowlisted, public vendor host.
        current = (await assertSafeOutboundUrl(new URL(res.headers.get('location')!, current).href, { allowedHosts })).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(current).hostname}`);
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(type)) throw new Error(`not an HTML page (${type || 'no content type'})`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('page too large');
      const html = (await res.text()).slice(0, MAX_BYTES);
      const text = htmlToText(html).slice(0, MAX_TEXT);
      return {
        url: current,
        text,
        fingerprint: `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`,
        status: res.status,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too many redirects');
}
