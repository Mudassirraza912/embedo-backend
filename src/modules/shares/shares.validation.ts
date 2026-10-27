import { z } from 'zod';

export const createShareLinkSchema = z.object({
  targetType: z.enum(['project', 'artifact']),
}).strict();

export const shareLinkIdParamSchema = z.object({
  linkId: z.string().uuid('Invalid share link UUID'),
});

export const shareTokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid share token'),
});

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
