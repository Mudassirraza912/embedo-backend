import { z } from 'zod';
import { CONFIDENCES, DOMAIN_IDS, RECORD_TYPES, SOURCE_TYPES } from '../ekab.constants.js';

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(50);
const shortList = z.array(z.string().trim().min(1).max(300)).max(20);

/** At most 10 documents per job: a job is a review unit, and it keeps one run short. */
export const scrapeJobSchema = z.object({
  domainId: z.enum(DOMAIN_IDS as [string, ...string[]]),
  batchCode: z.string().trim().min(3).max(40),
  title: z.string().trim().max(300).optional(),
  sources: z
    .array(
      z.object({
        url: z.string().trim().url('Enter a full https:// address').max(2000).refine((u) => u.startsWith('https://'), 'Only https:// addresses are read'),
        sourceType: z.enum(SOURCE_TYPES).optional(),
        title: z.string().trim().max(500).optional(),
        documentId: z.string().trim().max(200).optional(),
        revision: z.string().trim().max(120).optional(),
      })
    )
    .min(1, 'Add at least one source URL')
    .max(10, 'At most 10 sources per scrape job'),
});
export type ScrapeJobInput = z.infer<typeof scrapeJobSchema>;

export const scrapeJobParamSchema = z.object({ jobId: z.string().uuid('Invalid scrape job id') });
export const candidateParamSchema = z.object({ candidateId: z.string().uuid('Invalid candidate id') });

export const scrapeJobListQuerySchema = z.object({ domainId: z.enum(DOMAIN_IDS as [string, ...string[]]).optional(), page, pageSize: z.coerce.number().int().min(1).max(100).default(25) });

export const candidateListQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  kind: z.enum(['normative_sentence', 'parameter_row']).optional(),
  documentPk: z.string().uuid().optional(),
  q: z.string().trim().max(100).optional(),
  page,
  pageSize,
});

/** What a reviewer may change before a candidate becomes a record. The excerpt itself never changes. */
export const candidateEditSchema = z
  .object({
    record_type: z.enum(RECORD_TYPES).optional(),
    title: z.string().trim().min(3).max(300).optional(),
    topic: z.string().trim().min(2).max(300).optional(),
    normalized_statement: z.string().trim().min(10).max(2000).optional(),
    trust_state: z.enum(['VERIFIED', 'CONDITIONAL', 'UNRESOLVED']).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    applies_to: shortList.optional(),
    conditions: shortList.optional(),
    excludes: shortList.optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .strict();
export type CandidateEdit = z.infer<typeof candidateEditSchema>;

export const candidateReviewSchema = z.object({
  status: z.enum(['accepted', 'rejected', 'pending']),
  edited: candidateEditSchema.optional(),
});

export const candidateBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  status: z.enum(['accepted', 'rejected', 'pending']),
});

export const buildReleaseSchema = z.object({
  version: z
    .string()
    .trim()
    .regex(/^\d{1,3}\.\d{1,3}\.\d{1,4}$/, 'Use a version like 0.1.0')
    .optional(),
});
