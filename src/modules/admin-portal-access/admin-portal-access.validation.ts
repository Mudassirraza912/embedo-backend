import { z } from 'zod';

const expiresAt = z
  .string()
  .datetime({ offset: true })
  .refine((v) => Date.parse(v) > Date.now(), 'Expiry must be in the future')
  .nullable()
  .optional();

export const portalAccessIdParamSchema = z.object({ id: z.string().uuid() });

export const portalAccessCreateSchema = z
  .object({
    cidr: z.string().trim().min(2).max(64),
    label: z.string().trim().min(2, 'Say whose network this is').max(120),
    expiresAt,
  })
  .strict();

export const portalAccessUpdateSchema = z
  .object({
    label: z.string().trim().min(2).max(120).optional(),
    enabled: z.boolean().optional(),
    expiresAt,
  })
  .strict();

export type PortalAccessCreateBody = z.infer<typeof portalAccessCreateSchema>;
export type PortalAccessUpdateBody = z.infer<typeof portalAccessUpdateSchema>;
