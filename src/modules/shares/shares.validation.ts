import { z } from 'zod';

const artifactKeySchema = z.enum(['fbd', 'power', 'protocol', 'prototypeDiagram']);

export const shareTargetPreferenceSchema = z.object({
  targetType: z.enum(['artifact', 'project']),
}).strict();
export type ShareTargetPreferenceInput = z.infer<typeof shareTargetPreferenceSchema>;

export const createShareLinkSchema = z.union([
  z.object({
    targetType: z.literal('project'),
    visibility: z.enum(['public', 'private']),
    inviteeEmails: z.array(z.string().trim().email().max(320).transform((email) => email.toLowerCase()))
      .min(1).max(50).optional(),
  }).strict().superRefine((input, context) => {
    if (input.visibility === 'private' && (!input.inviteeEmails || input.inviteeEmails.length === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Private links require invited accounts' });
    }
    if (input.visibility === 'public' && input.inviteeEmails) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Public links cannot include invitees' });
    }
    if (input.inviteeEmails && new Set(input.inviteeEmails).size !== input.inviteeEmails.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Invitee email addresses must be unique' });
    }
  }),
  z.object({
    targetType: z.literal('artifact'),
    artifactKey: artifactKeySchema,
    visibility: z.enum(['public', 'private']),
    inviteeEmails: z.array(z.string().trim().email().max(320).transform((email) => email.toLowerCase()))
      .min(1).max(50).optional(),
  }).strict().superRefine((input, context) => {
    if (input.visibility === 'private' && (!input.inviteeEmails || input.inviteeEmails.length === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Private links require invited accounts' });
    }
    if (input.visibility === 'public' && input.inviteeEmails) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Public links cannot include invitees' });
    }
    if (input.inviteeEmails && new Set(input.inviteeEmails).size !== input.inviteeEmails.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['inviteeEmails'], message: 'Invitee email addresses must be unique' });
    }
  }),
]);

export const shareLinkIdParamSchema = z.object({
  linkId: z.string().uuid('Invalid share link UUID'),
});

export const shareTokenParamSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid share token'),
});

export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;
