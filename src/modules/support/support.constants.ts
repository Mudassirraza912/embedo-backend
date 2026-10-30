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
