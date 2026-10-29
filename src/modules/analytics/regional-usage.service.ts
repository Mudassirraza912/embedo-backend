import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { geoLookupProvider } from './geo-lookup.js';

export type RegionalEventType = 'guest_session_init' | 'login' | 'workspace_entered';
export type RegionalMode = 'architect' | 'prototype';

export interface RecordRegionalEventInput {
  eventType: RegionalEventType;
  /** Server-authoritative signed-in identity. Mutually exclusive with anonSessionToken. */
  userId?: string | null;
  /** The guest's existing pseudonymous session token. Ignored when userId is set. */
  anonSessionToken?: string | null;
  mode?: RegionalMode | null;
  sessionId?: string | null;
  /** From `resolveTrustedClientIp(req)`. Only ever used for the geo lookup — never stored. */
  ip: string;
}

/**
 * Captures IP-derived regional usage events (task_two). Best-effort and non-blocking: a failure
 * here must never fail the request it was called from, so every call swallows its own errors.
 *
 * Identity rule: userId and anonSessionToken are never merged and IP is never itself stored or used
 * as an identity — only the derived geo result is persisted. See VisitorRegionEvent in
 * schema.prisma for the full column-level rationale.
 */
export const regionalUsageService = {
  async recordEvent(input: RecordRegionalEventInput): Promise<void> {
    try {
      const geo = await geoLookupProvider.lookup(input.ip);
      const signedIn = Boolean(input.userId);
      await prisma.visitorRegionEvent.create({
        data: {
          eventType: input.eventType,
          userId: signedIn ? (input.userId as string) : null,
          anonSessionToken: signedIn ? null : input.anonSessionToken ?? null,
          mode: input.mode ?? null,
          sessionId: input.sessionId ?? null,
          countryCode: geo.status === 'ok' ? geo.countryCode : null,
          regionCode: geo.status === 'ok' ? geo.regionCode : null,
          geoSource: geo.source,
          geoSourceVersion: geo.sourceVersion,
          geoStatus: geo.status,
        },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, eventType: input.eventType }, 'regional usage event not recorded');
    }
  },
};
