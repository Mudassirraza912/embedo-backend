import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors/AppError.js';

/**
 * SSRF guard for server-side fetches of user/admin supplied URLs.
 *  - https only (http allowed only when explicitly permitted)
 *  - hostname must not be localhost / private / link-local / metadata ranges
 *  - resolved A/AAAA records are checked too (DNS rebinding to internal ranges)
 *  - optional hostname allowlist
 */

const isPrivateIPv4 = (ip: string): boolean => {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
};

const isPrivateIPv6 = (ip: string): boolean => {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('::ffff:')) return isPrivateIPv4(v.slice(7));
  return false;
};

export const isPrivateAddress = (ip: string): boolean => {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true; // not an IP -> treat as unsafe
};

export interface SafeUrlOptions {
  allowHttp?: boolean;
  allowedHosts?: string[]; // exact host or suffix match (".ti.com")
}

const hostAllowed = (hostname: string, allowedHosts: string[] | undefined): boolean => {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  const h = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('.') ? h.endsWith(e) || h === e.slice(1) : h === e;
  });
};

export const assertSafeOutboundUrl = async (rawUrl: string, opts: SafeUrlOptions = {}): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'BAD_REQUEST', 'Invalid URL');
  }

  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new AppError(400, 'BAD_REQUEST', 'Only https:// URLs are allowed');
  }
  if (url.username || url.password) {
    throw new AppError(400, 'BAD_REQUEST', 'URLs with embedded credentials are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
    throw new AppError(400, 'BAD_REQUEST', 'URL host is not allowed');
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new AppError(400, 'BAD_REQUEST', 'URL host resolves to a private network');
  }
  if (!hostAllowed(hostname, opts.allowedHosts)) {
    throw new AppError(400, 'BAD_REQUEST', `URL host '${hostname}' is not on the allowlist`);
  }

  if (!net.isIP(hostname)) {
    let addresses: string[] = [];
    try {
      const results = await dns.lookup(hostname, { all: true });
      addresses = results.map((r) => r.address);
    } catch {
      throw new AppError(400, 'BAD_REQUEST', 'URL host could not be resolved');
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new AppError(400, 'BAD_REQUEST', 'URL host resolves to a private network');
    }
  }

  return url;
};
