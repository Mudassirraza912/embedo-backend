import { z } from 'zod';

export const updateProfileSchema = z.object({
  expertiseLevel: z.enum(['student', 'hobbyist', 'professional', 'expert']).optional(),
});

export const updateConsentSchema = z.object({
  dataConsent: z.boolean(),
});

export const deleteAccountSchema = z.object({
  password: z.string().optional(),
});

export const shareSettingsSchema = z.object({
  visibility: z.enum(['public', 'private']),
  expiration: z.enum(['24h', '7d', '30d', 'never']),
}).strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateConsentInput = z.infer<typeof updateConsentSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
export type ShareSettingsInput = z.infer<typeof shareSettingsSchema>;
