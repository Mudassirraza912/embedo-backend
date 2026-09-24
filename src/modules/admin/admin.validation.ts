import { z } from 'zod';

const httpsUrl = z
  .string()
  .trim()
  .url('A valid URL is required')
  .max(2048)
  .refine((u) => u.startsWith('https://'), { message: 'Only https:// URLs are accepted' });

export const ingestUrlQuerySchema = z.object({ url: httpsUrl });
export const ingestUrlBodySchema = z.object({ url: httpsUrl });

export const ingestBatchSchema = z.object({
  vendor: z.string().trim().max(100).optional(),
  urls: z.array(httpsUrl).max(500).optional(),
  onlyPending: z.boolean().optional().default(true),
});

export const listComponentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
});

export const userIdParamSchema = z.object({
  id: z.string().uuid('Invalid user ID format'),
});

export const partNumberParamSchema = z.object({
  partNumber: z.string().trim().min(1).max(255),
});
export const revisionsQuerySchema = z.object({
  includeSnapshot: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export type IngestBatchInput = z.infer<typeof ingestBatchSchema>;
export type ListComponentsQuery = z.infer<typeof listComponentsQuerySchema>;
