import { Request } from 'express';

/**
 * Resolves the client IP the same way the rest of the product already trusts it: through Express's
 * own `trust proxy` setting (see app.ts — `app.set('trust proxy', 1)`, set specifically because the
 * API is only reachable through Nginx, see CLAUDE.md §3). With `trust proxy=1`, Express trusts
 * exactly one hop (Nginx) and derives `req.ip` from that; anything a client injects into
 * X-Forwarded-For beyond that trusted hop is already discarded before this function ever runs. This
 * module deliberately does not parse X-Forwarded-For itself — doing so would reopen the spoofing
 * hole `trust proxy` exists to close. Same trust boundary already used by the rate limiter
 * (`rate-limit.middleware.ts`) and the admin portal IP allowlist.
 */
export function resolveTrustedClientIp(req: Pick<Request, 'ip'>): string {
  const ip = req.ip;
  if (!ip) return 'unknown';
  // IPv4-mapped IPv6 form ("::ffff:1.2.3.4"): normalise like admin-portal-access.service.ts does.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
