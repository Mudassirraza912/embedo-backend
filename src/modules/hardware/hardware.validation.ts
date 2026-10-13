import { z } from 'zod';

export const hardwareEntityParamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'Invalid hardware entity id'),
});

/** One board from the admin panel: the v3.3 record JSON, its SVG text, and optionally asset.json. */
export const hardwareUploadSchema = z.object({
  record: z.record(z.unknown()),
  svg: z.string().min(20, 'svg is required').max(800_000, 'svg is too large'),
  asset: z.record(z.unknown()).optional(),
});

export const hardwareListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  reviewStatus: z.string().max(20).optional(),
  assetReadiness: z.string().max(20).optional(),
  embedded: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const hardwareGovernanceSchema = z
  .object({
    reviewStatus: z.string().max(20).optional(),
    assetReadiness: z.string().max(20).optional(),
    lifecycleStatus: z.string().max(20).optional(),
  })
  .strict();

export const proposalParamSchema = z.object({ proposalId: z.string().uuid('Invalid proposal id') });

/** A scraped / machine-sourced candidate submitted for admin review. */
export const proposalSubmitSchema = hardwareUploadSchema.extend({
  sourceType: z.enum(['vendor_agent', 'user', 'import', 'admin']).default('vendor_agent'),
  sourceReference: z.string().max(2000).optional(),
});

export const proposalListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'needs_review']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const proposalApproveSchema = z
  .object({
    reviewStatus: z.enum(['provisional', 'confirmed']).optional(),
    assetReadiness: z.enum(['catalog_only', 'metadata_ready', 'visual_ready', 'wiring_ready', 'needs_review']).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const proposalRejectSchema = z.object({ notes: z.string().trim().min(3, 'Say why it was rejected').max(2000) });

export type HardwareUploadInput = z.infer<typeof hardwareUploadSchema>;
export type ProposalSubmitInput = z.infer<typeof proposalSubmitSchema>;
export type ProposalListQuery = z.infer<typeof proposalListQuerySchema>;
export type ProposalApproveInput = z.infer<typeof proposalApproveSchema>;
export type HardwareListQuery = z.infer<typeof hardwareListQuerySchema>;
export type HardwareGovernanceInput = z.infer<typeof hardwareGovernanceSchema>;

export const hardwareBenchQuerySchema = z.object({
  controller: z.enum(['0', '1']).optional(),
});
