/**
 * Vocabulary of the Track B canonical output contract (Embedo Track B — Canonical Output & EKAB
 * Ingestion Contract v0.1). Every value here is also a DB CHECK constraint in the
 * `20261021100000_ekab_track_b` migration: change both together.
 */

export const SUPPORTED_SCHEMA_VERSIONS = ['track-b-ekab-1.0'] as const;

/** Appendix B: B1–B10 with their short codes (release ids look like `B1.COMM.v1.0.0`). */
export const DOMAINS = {
  B1: { name: 'Communication Intelligence', code: 'COMM' },
  B2: { name: 'Power Intelligence', code: 'POWER' },
  B3: { name: 'Firmware Intelligence', code: 'FW' },
  B4: { name: 'Sensor Intelligence', code: 'SENSOR' },
  B5: { name: 'Memory & Storage Intelligence', code: 'MEM' },
  B6: { name: 'RF & Wireless Intelligence', code: 'RF' },
  B7: { name: 'Protection & Reliability Intelligence', code: 'PROTECT' },
  B8: { name: 'Analog & Signal Intelligence', code: 'ANALOG' },
  B9: { name: 'Debug & Programming Intelligence', code: 'DEBUG' },
  B10: { name: 'Manufacturing Intelligence', code: 'MFG' },
} as const;
export type DomainId = keyof typeof DOMAINS;
export const DOMAIN_IDS = Object.keys(DOMAINS) as DomainId[];
export const isDomainId = (v: unknown): v is DomainId => typeof v === 'string' && v in DOMAINS;

/** §4.1 release_status as declared by the worker / governance. */
export const RELEASE_STATUSES = ['DRAFT', 'QA_PENDING', 'REVISION_REQUIRED', 'APPROVED_FOR_INGESTION', 'REJECTED', 'SUPERSEDED'] as const;
/** §13.1 batch QA outcome. */
export const QA_STATUSES = ['PASS', 'PASS_WITH_EXCLUSIONS', 'REVISION_REQUIRED', 'REJECTED'] as const;
/** §14 EKAB ingestion state (ours, not the worker's). */
export const INGESTION_STATES = ['RECEIVED', 'SCHEMA_VALID', 'STAGED', 'QUARANTINED', 'PROMOTED', 'REJECTED', 'SUPERSEDED'] as const;
export type IngestionState = (typeof INGESTION_STATES)[number];
/** Audit-trail states: the ingestion states plus the EKAB-side QA approval (B0 or equivalent). */
export const EVENT_STATES = [...INGESTION_STATES, 'QA_APPROVED'] as const;
export type EventState = (typeof EVENT_STATES)[number];

/** §5.2 */
export const RECORD_TYPES = [
  'FACT',
  'CONSTRAINT',
  'RULE',
  'RELATIONSHIP',
  'EQUATION',
  'DERIVED_MODEL',
  'TRADEOFF',
  'SELECTION_GUIDANCE',
  'DESIGN_RULE',
  'IMPLEMENTATION_NOTE',
  'VALIDATION_METHOD',
  'COMPATIBILITY_PREREQUISITE',
] as const;
/** §6: four independent dimensions — never collapsed into one status. */
export const ORIGINS = ['SOURCE_BASED', 'DERIVED'] as const;
export const TRUST_STATES = ['VERIFIED', 'CONDITIONAL', 'UNRESOLVED', 'REJECTED'] as const;
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const LIFECYCLE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'RETIRED'] as const;
/** Trust states that may ever reach reasoning (§6.1, §18 step 8). */
export const REASONING_TRUST_STATES = ['VERIFIED', 'CONDITIONAL'] as const;

/** §7 */
export const SOURCE_TYPES = [
  'STANDARD',
  'DATASHEET',
  'REFERENCE_MANUAL',
  'APP_NOTE',
  'REFERENCE_DESIGN',
  'OFFICIAL_DOC',
  'OFFICIAL_REPO',
  'OFFICIAL_WEB',
  'PEER_REVIEWED',
  'OTHER_APPROVED',
] as const;
export const SUPPORT_TYPES = ['DIRECT', 'SUPPORTING', 'CONFLICTING', 'DERIVATION_INPUT'] as const;
export const ACCESS_STATES = ['PUBLIC', 'LICENSED_REFERENCE_ONLY', 'RESTRICTED', 'REQUIRES_REVIEW'] as const;

/** §10 */
export const RELATIONSHIP_TYPES = [
  'DEPENDS_ON',
  'IMPLEMENTS_WITH',
  'CONSTRAINS',
  'ALTERNATIVE_TO',
  'REQUIRES_VALIDATION_WITH',
  'SUPERSEDES',
  'RELATED_TO',
] as const;

/** §11 */
export const GAP_TYPES = [
  'MISSING_SOURCE',
  'RESTRICTED_SOURCE',
  'INSUFFICIENT_EVIDENCE',
  'CONFLICTING_SOURCES',
  'OUT_OF_SCOPE',
  'NEEDS_MEASUREMENT',
  'NEEDS_HUMAN_REVIEW',
] as const;
export const GAP_SEVERITIES = ['CRITICAL', 'MAJOR', 'NORMAL', 'LOW'] as const;
export const GAP_STATUSES = ['OPEN', 'BLOCKED', 'DEFERRED', 'RESOLVED', 'ACCEPTED_LIMITATION'] as const;

export const oneOf = <T extends readonly string[]>(values: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (values as readonly string[]).includes(v);
