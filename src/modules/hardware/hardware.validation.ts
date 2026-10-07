import { z } from 'zod';

export const hardwareEntityParamSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'Invalid hardware entity id'),
});
