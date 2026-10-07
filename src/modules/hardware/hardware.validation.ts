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

export type HardwareUploadInput = z.infer<typeof hardwareUploadSchema>;
export type HardwareListQuery = z.infer<typeof hardwareListQuerySchema>;
export type HardwareGovernanceInput = z.infer<typeof hardwareGovernanceSchema>;
