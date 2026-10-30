/**
 * Mirrors the DB CHECK constraints in the support_cases / support_case_events migration. Changing
 * a value here means changing the migration's CHECK constraints too (see CLAUDE.md "Vocabularies
 * and statuses" convention).
 */
export const SUPPORT_SUBCATEGORIES = ['account', 'credit', 'access', 'bug', 'other'] as const;
export type SupportSubcategory = (typeof SUPPORT_SUBCATEGORIES)[number];

export const SUPPORT_STATUSES = [
  'new',
  'open',
  'assigned',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
  'reopened',
] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

export const SUPPORT_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_EVENT_KINDS = ['customer_message', 'admin_response', 'internal_note', 'status_change', 'assignment'] as const;
export type SupportEventKind = (typeof SUPPORT_EVENT_KINDS)[number];

/** Mirrors support_case_attachments_content_type_check. */
export const SUPPORT_ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
export type SupportAttachmentContentType = (typeof SUPPORT_ATTACHMENT_CONTENT_TYPES)[number];

/** Mirrors support_case_attachments_size_check (raw bytes, before base64 encoding). */
export const MAX_SUPPORT_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Not a DB constraint -- an abuse guard so one case can't accumulate unbounded evidence. */
export const MAX_SUPPORT_ATTACHMENTS_PER_CASE = 3;
