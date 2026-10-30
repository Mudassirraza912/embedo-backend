import { z } from 'zod';
import { SUPPORT_SUBCATEGORIES } from './support.constants.js';
import { SESSION_TYPES } from '../sessions/session-type.js';

export const MAX_SUPPORT_SUBJECT_CHARS = 200;
export const MAX_SUPPORT_DESCRIPTION_CHARS = 4000;

export const createSupportCaseSchema = z
  .object({
    subcategory: z.enum(SUPPORT_SUBCATEGORIES),
    subject: z.string().trim().min(3, 'Subject must be at least 3 characters long').max(MAX_SUPPORT_SUBJECT_CHARS),
    description: z.string().trim().min(10, 'Please describe the issue in at least 10 characters').max(MAX_SUPPORT_DESCRIPTION_CHARS),
    // Required only for a guest submission; a signed-in caller's account email is used instead.
    // Never treated as verified -- there is no verification flow for it yet.
    guestContactEmail: z.string().trim().email('Enter a valid email address').max(255).optional(),
    mode: z.enum(SESSION_TYPES).optional(),
    // The project/run this report is about, if any. Ownership is checked server-side before it is
    // ever stored, never trusted from the client alone.
    sessionId: z.string().uuid('Invalid session UUID format').optional(),
    // Client-generated, kept across a retry so a dropped response never creates a duplicate case.
    clientRequestId: z.string().trim().min(8).max(100).optional(),
  })
  .strict();

export type CreateSupportCaseInput = z.infer<typeof createSupportCaseSchema>;

export const supportCaseIdParamSchema = z.object({
  id: z.string().uuid('Invalid case UUID format'),
});
