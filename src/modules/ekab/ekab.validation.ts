import { z } from 'zod';
import { DOMAIN_IDS, INGESTION_STATES, SOURCE_TYPES, TRUST_STATES } from './ekab.constants.js';

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(25);
const bool = z
  .enum(['true', 'false'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true'));

export const releaseParamSchema = z.object({ releasePk: z.string().uuid('Invalid release id') });

/**
 * A Track B release package (contract §3). Only the canonical JSON is required to be readable here;
 * everything else (including missing supporting files) is judged by the validator in the worker.
 */
export const releaseUploadSchema = z.object({
  canonical: z.record(z.unknown()),
  sourceManifest: z.unknown().optional(),
  gapRegistry: z.unknown().optional(),
  qaReport: z.unknown().optional(),
  completionReport: z.unknown().optional(),
});
export type ReleaseUploadInput = z.infer<typeof releaseUploadSchema>;

export const releaseListQuerySchema = z.object({
  domainId: z.enum(DOMAIN_IDS as [string, ...string[]]).optional(),
  state: z.enum(INGESTION_STATES).optional(),
  page,
  pageSize,
});

export const recordListQuerySchema = z.object({
  trust: z.enum(TRUST_STATES).optional(),
  quarantined: bool,
  q: z.string().trim().max(100).optional(),
  page,
  pageSize,
});

export const approveQaSchema = z.object({
  qaStatus: z.enum(['PASS', 'PASS_WITH_EXCLUSIONS']),
  notes: z.string().trim().max(2000).optional(),
});

export const promoteSchema = z.object({
  notes: z.string().trim().max(2000).optional(),
  acceptExclusions: z.boolean().optional(),
});

export const rejectSchema = z.object({ notes: z.string().trim().min(3, 'Say why the release is rejected').max(2000) });

// --- scrape source allowlist ---------------------------------------------------------------------

const HOST = /^\.?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const sourceDomainParamSchema = z.object({ id: z.string().uuid('Invalid source domain id') });

export const sourceDomainCreateSchema = z.object({
  host: z
    .string()
    .trim()
    .toLowerCase()
    .transform((h) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .pipe(z.string().regex(HOST, 'Enter a host such as www.rfc-editor.org, or .ti.com for every ti.com subdomain')),
  publisher: z.string().trim().min(2).max(300),
  defaultSourceType: z.enum(SOURCE_TYPES),
  accessState: z.enum(['PUBLIC', 'LICENSED_REFERENCE_ONLY', 'RESTRICTED']),
  enabled: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type SourceDomainInput = z.infer<typeof sourceDomainCreateSchema>;

export const sourceDomainUpdateSchema = sourceDomainCreateSchema.omit({ host: true }).partial().strict();
