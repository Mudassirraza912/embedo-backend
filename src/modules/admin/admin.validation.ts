import { z } from 'zod';
import { PLAN_NAMES, LIMIT_BOUNDS, type Limits } from '../limits/limits.service.js';

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

const limitInt = (key: keyof Limits) => z.number().int().min(LIMIT_BOUNDS[key][0]).max(LIMIT_BOUNDS[key][1]);

export const planParamSchema = z.object({ plan: z.enum(PLAN_NAMES) });

/** All three limits are required when replacing a plan, so a partial body can never leave one undefined. */
export const updatePlanBodySchema = z
  .object({
    messagesPerSession: limitInt('messagesPerSession'),
    maxInFlightSessions: limitInt('maxInFlightSessions'),
    sessionsPerHour: limitInt('sessionsPerHour'),
  })
  .strict();

/** A number sets a per-user override; null removes it (the user inherits the plan's value again). */
export const updateUserLimitsBodySchema = z
  .object({
    planOverride: z.enum(['free', 'paid']).nullable().optional(),
    messagesPerSession: limitInt('messagesPerSession').nullable().optional(),
    maxInFlightSessions: limitInt('maxInFlightSessions').nullable().optional(),
    sessionsPerHour: limitInt('sessionsPerHour').nullable().optional(),
  })
  .strict();

export type IngestBatchInput = z.infer<typeof ingestBatchSchema>;
export type ListComponentsQuery = z.infer<typeof listComponentsQuerySchema>;

export type UpdatePlanBody = z.infer<typeof updatePlanBodySchema>;
export type UpdateUserLimitsBody = z.infer<typeof updateUserLimitsBodySchema>;
