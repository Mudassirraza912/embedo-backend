import { z } from 'zod';
import { SESSION_TYPES } from './session-type.js';

/** architect (default) | prototype. Omitted on /discuss = keep the session's own type. */
export const sessionTypeSchema = z.enum(SESSION_TYPES);

export const sessionIdParamSchema = z.object({
  id: z.string().uuid('Invalid session UUID format'),
});

export const versionParamSchema = z.object({
  id: z.string().uuid('Invalid session UUID format'),
  version: z.string().min(1).max(30, 'Version string too long'),
});

export const createSessionSchema = z.object({
  intentText: z.string().min(3, 'Intent text must be at least 3 characters long').max(2000, 'Intent text cannot exceed 2000 characters'),
  domain: z.string().max(100).optional(),
  // Matches the VARCHAR(100) column; 200 used to pass validation and then fail the insert.
  applicationContext: z.string().max(100).optional(),
  type: sessionTypeSchema.optional(),
});

export const discussMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1, 'Message content cannot be empty').max(2000, 'Message content cannot exceed 2000 characters'),
});

export const discussSchema = z.object({
  messages: z.array(discussMessageSchema).min(1, 'At least one message is required').max(30, 'Conversation history cannot exceed 30 messages'),
  type: sessionTypeSchema.optional(),
});

export const feedbackSchema = z.object({
  aiCallId: z.string().uuid().optional(),
  action: z.enum(['accepted', 'rejected', 'modified']),
  modifications: z.record(z.unknown()).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(1000, 'Notes cannot exceed 1000 characters').optional(),
  timeToActionSeconds: z.number().int().nonnegative().optional(),
});

export const exportFormatSchema = z.enum(['kicad', 'altium', 'svg', 'json']);

export const exportSchema = z.object({
  format: exportFormatSchema,
});

export const exportDownloadQuerySchema = z.object({
  format: exportFormatSchema,
});

export const sourcingQuerySchema = z.object({
  version: z.string().min(1).max(30).optional(),
  refresh: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export const outcomeSchema = z.object({
  fabricated: z.boolean().optional(),
  workedFirstTime: z.boolean().optional(),
  iterationsToWorking: z.number().int().nonnegative().optional(),
  feedbackNotes: z.string().max(2000).optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type DiscussInput = z.infer<typeof discussSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type ExportInput = z.infer<typeof exportSchema>;
export type OutcomeInput = z.infer<typeof outcomeSchema>;

