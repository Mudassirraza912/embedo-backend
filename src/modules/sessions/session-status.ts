/**
 * Session state machine. Mirrored by the `design_sessions_status_check` database constraint,
 * so adding a value here requires a migration.
 */
export const SESSION_STATUSES = [
  'PENDING',
  'PROCESSING',
  'CLARIFICATION_REQUIRED',
  'DONE',
  'FAILED',
  /** Internal, non-user session used to attribute background AI spend (never API-readable). */
  'SYSTEM',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses that occupy a free-tier "in progress" slot. */
export const IN_FLIGHT_STATUSES: SessionStatus[] = ['PENDING', 'PROCESSING', 'CLARIFICATION_REQUIRED'];

export const isSessionStatus = (value: string): value is SessionStatus =>
  (SESSION_STATUSES as readonly string[]).includes(value);
