import { z } from 'zod';
import { MAX_SUPPORT_ATTACHMENT_BYTES, SUPPORT_ATTACHMENT_CONTENT_TYPES, SUPPORT_SUBCATEGORIES } from './support.constants.js';
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

export const supportAttachmentParamSchema = z.object({
  id: z.string().uuid('Invalid case UUID format'),
  attachmentId: z.string().uuid('Invalid attachment UUID format'),
});

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded size is checked here (not just the string length) so the real stored size matches the DB CHECK. */
export const addSupportAttachmentSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.enum(SUPPORT_ATTACHMENT_CONTENT_TYPES),
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_SUPPORT_ATTACHMENT_BYTES * 4) / 3) + 1024, 'File is too large.')
      .refine((v) => BASE64_RE.test(v), 'Not valid base64 data.')
      .refine((v) => Buffer.from(v, 'base64').length <= MAX_SUPPORT_ATTACHMENT_BYTES, `File exceeds ${Math.floor(MAX_SUPPORT_ATTACHMENT_BYTES / 1024 / 1024)}MB.`)
      .refine((v) => Buffer.from(v, 'base64').length > 0, 'File is empty.'),
  })
  .strict();

export type AddSupportAttachmentInput = z.infer<typeof addSupportAttachmentSchema>;
