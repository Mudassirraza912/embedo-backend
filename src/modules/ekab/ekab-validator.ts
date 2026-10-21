import {
  ACCESS_STATES,
  CONFIDENCES,
  DOMAINS,
  GAP_SEVERITIES,
  GAP_STATUSES,
  GAP_TYPES,
  isDomainId,
  LIFECYCLE_STATUSES,
  ORIGINS,
  oneOf,
  QA_STATUSES,
  RECORD_TYPES,
  RELATIONSHIP_TYPES,
  RELEASE_STATUSES,
  SOURCE_TYPES,
  SUPPORT_TYPES,
  SUPPORTED_SCHEMA_VERSIONS,
  TRUST_STATES,
} from './ekab.constants.js';

/**
 * Track B release validator (contract §13 gates, §19 TB-VAL-001…012, Appendix A). Pure: no DB, no
 * network, no AI. The caller passes the record ids already in EKAB so cross-release references
 * resolve. Issues are scoped:
 *  - `release`: the release cannot be ingested at all (REJECTED, reason retained);
 *  - `record`: only that record is QUARANTINED; the rest of the release can still be staged.
 * Supporting files are read leniently (field-name variants) but every required fact must be there.
 */

export type Severity = 'error' | 'warning';
export interface ValidationIssue {
  rule: string;
  severity: Severity;
  scope: 'release' | 'record';
  recordId?: string;
  path: string;
  message: string;
}

export interface ReleasePackage {
  canonical: unknown;
  sourceManifest?: unknown;
  gapRegistry?: unknown;
  qaReport?: unknown;
  completionReport?: unknown;
}

export interface Applicability {
  appliesTo: unknown[];
  excludes: unknown[];
  conditions: unknown[];
}

export interface NormRecord {
  index: number;
  recordId: string;
  recordRevision: number | null;
  recordType: string | null;
  domainId: string | null;
  topic: string | null;
  title: string | null;
  statement: string | null;
  origin: string | null;
  trustState: string | null;
  confidence: string | null;
  lifecycle: string | null;
  versionReleaseId: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  applicability: Applicability;
  content: Record<string, unknown>;
  evidenceRefs: string[];
  relationshipRefs: string[];
  tags: string[];
  qa: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface NormEvidence {
  evidenceId: string | null;
  sourceId: string;
  sourceType: string | null;
  publisher: string | null;
  title: string | null;
  documentId: string | null;
  revision: string | null;
  url: string | null;
  locator: string | null;
  retrievedAt: string | null;
  supportType: string | null;
  accessState: string | null;
  raw: Record<string, unknown>;
}

export interface NormRelationship {
  relationshipId: string;
  type: string | null;
  fromRecordId: string | null;
  toRecordId: string | null;
  targetConcept: string | null;
  conditions: unknown;
  raw: Record<string, unknown>;
}

export interface NormGap {
  gapId: string;
  domainId: string | null;
  batchId: string | null;
  topic: string | null;
  question: string | null;
  gapType: string | null;
  severity: string | null;
  status: string | null;
  sourceRefs: string[];
  resolutionRecordRefs: string[];
  notes: string | null;
  raw: Record<string, unknown>;
}

export interface NormHandoff {
  handoffId: string;
  sourceDomain: string | null;
  targetDomain: string | null;
  sourceRecordRefs: string[];
  question: string | null;
  reason: string | null;
  priority: string | null;
  blocking: boolean;
  status: string | null;
  resolutionRecordRefs: string[];
  raw: Record<string, unknown>;
}

export interface ReleaseCounts {
  records: number;
  verified: number;
  conditional: number;
  derived: number;
  unresolved: number;
  relationships: number;
  handoffs: number;
}

export interface NormRelease {
  schemaVersion: string | null;
  releaseId: string;
  domainId: string | null;
  domainName: string | null;
  batchId: string | null;
  releaseStatus: string | null;
  generatedAt: string | null;
  producer: Record<string, unknown> | null;
  governance: Record<string, unknown> | null;
  sourceSnapshotId: string | null;
  declaredCounts: Record<string, unknown> | null;
  records: NormRecord[];
  relationships: NormRelationship[];
  handoffs: NormHandoff[];
  evidence: NormEvidence[];
  gaps: NormGap[];
  hasManifest: boolean;
  hasGapRegistry: boolean;
  hasQaReport: boolean;
  hasCompletionReport: boolean;
}

export interface ValidationResult {
  /** null only when the canonical JSON has no usable release_id (nothing can be stored). */
  release: NormRelease | null;
  issues: ValidationIssue[];
  /** true when any release-scoped error exists: the release must be REJECTED. */
  rejected: boolean;
  /** recordId -> record-scoped errors. These records are loaded QUARANTINED. */
  quarantined: Map<string, ValidationIssue[]>;
  counts: ReleaseCounts;
}

export interface ValidationContext {
  /** record_ids already stored in EKAB (any release), for cross-release references. */
  knownRecordIds?: ReadonlySet<string>;
}

// --- small readers -----------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const first = (o: Obj, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return null;
};
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => x !== null) : str(v) ? [str(v)!] : []);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A supporting file may be the array itself or an object wrapping it under one of these keys. */
function listIn(file: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(file)) return file;
  if (!isObj(file)) return null;
  for (const k of keys) if (Array.isArray(file[k])) return file[k] as unknown[];
  return null;
}

/** ISO 8601 date-time (TB-VAL-012). UTC (Z or +00:00) is required for a clean pass. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isUtc = (v: string) => /(Z|[+-]00:00)$/.test(v);

/** Credential shapes that must never enter EKAB (TB-VAL-010). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['OpenAI-style API key', /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['password assignment', /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"'<>]{6,}/i],
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

// --- normalisation -----------------------------------------------------------------------------

function normApplicability(v: unknown): Applicability {
  const o = isObj(v) ? v : {};
  return { appliesTo: arr(o['applies_to']), excludes: arr(o['excludes']), conditions: arr(o['conditions']) };
}

function normRecord(raw: Obj, index: number): NormRecord | null {
  const recordId = str(raw['record_id']);
  if (!recordId) return null;
  const version = isObj(raw['version']) ? raw['version'] : {};
  const rev = raw['record_revision'];
  return {
    index,
    recordId,
    recordRevision: typeof rev === 'number' && Number.isInteger(rev) ? rev : typeof rev === 'string' && /^\d+$/.test(rev) ? Number(rev) : null,
    recordType: str(raw['record_type']),
    domainId: str(raw['domain_id']),
    topic: str(raw['topic']),
    title: str(raw['title']),
    statement: str(raw['normalized_statement']),
    origin: str(raw['origin']),
    trustState: str(raw['trust_state']),
    confidence: str(raw['confidence']),
    lifecycle: str(version['status']) ?? str(raw['lifecycle_status']),
    versionReleaseId: str(version['release_id']),
    supersedes: str(version['supersedes']),
    supersededBy: str(version['superseded_by']),
    applicability: normApplicability(raw['applicability']),
    content: isObj(raw['content']) ? raw['content'] : {},
    evidenceRefs: strList(raw['evidence_refs']),
    relationshipRefs: strList(raw['relationship_refs']),
    tags: strList(raw['tags']),
    qa: isObj(raw['qa']) ? raw['qa'] : {},
    raw,
  };
}

function normEvidence(raw: Obj): NormEvidence | null {
  const sourceId = first(raw, 'source_id', 'sourceId');
  const evidenceId = first(raw, 'evidence_id', 'evidenceId', 'id');
  if (!sourceId && !evidenceId) return null;
  return {
    evidenceId,
    sourceId: sourceId ?? evidenceId!,
    sourceType: first(raw, 'source_type', 'sourceType'),
    publisher: first(raw, 'publisher', 'authority', 'organization'),
    title: first(raw, 'title'),
    documentId: first(raw, 'document_id', 'documentId'),
    revision: first(raw, 'revision', 'version', 'date'),
    url: first(raw, 'url', 'repository_ref', 'repositoryRef'),
    locator: first(raw, 'locator'),
    retrievedAt: first(raw, 'retrieved_at', 'retrievedAt'),
    supportType: first(raw, 'support_type', 'supportType'),
    accessState: first(raw, 'access_state', 'rights_state', 'rights_access_state', 'accessState'),
    raw,
  };
}

function normRelationship(raw: Obj): NormRelationship | null {
  const relationshipId = first(raw, 'relationship_id', 'relationshipId');
  if (!relationshipId) return null;
  return {
    relationshipId,
    type: first(raw, 'type', 'relationship_type'),
    fromRecordId: first(raw, 'from_record_id', 'from'),
    toRecordId: first(raw, 'to_record_id', 'to'),
    targetConcept: first(raw, 'target_concept'),
    conditions: raw['conditions'] ?? raw['applicability'] ?? null,
    raw,
  };
}

function normGap(raw: Obj, fallbackDomain: string | null, fallbackBatch: string | null): NormGap | null {
  const gapId = first(raw, 'gap_id', 'gapId', 'id');
  if (!gapId) return null;
  return {
    gapId,
    domainId: first(raw, 'domain_id') ?? fallbackDomain,
    batchId: first(raw, 'batch_id') ?? fallbackBatch,
    topic: first(raw, 'topic'),
    question: first(raw, 'question'),
    gapType: first(raw, 'gap_type', 'type'),
    severity: first(raw, 'severity'),
    status: first(raw, 'status'),
    sourceRefs: strList(raw['source_refs']),
    resolutionRecordRefs: strList(raw['resolution_record_refs']),
    notes: first(raw, 'notes'),
    raw,
  };
}

function normHandoff(raw: Obj): NormHandoff | null {
  const handoffId = first(raw, 'handoff_id', 'handoffId');
  if (!handoffId) return null;
  return {
    handoffId,
    sourceDomain: first(raw, 'source_domain'),
    targetDomain: first(raw, 'target_domain'),
    sourceRecordRefs: strList(raw['source_record_refs']),
    question: first(raw, 'question'),
    reason: first(raw, 'reason'),
    priority: first(raw, 'priority'),
    blocking: raw['blocking'] === true,
    status: first(raw, 'status'),
    resolutionRecordRefs: strList(raw['resolution_record_refs']),
    raw,
  };
}

export function computeCounts(records: NormRecord[], relationships: number, handoffs: number): ReleaseCounts {
  return {
    records: records.length,
    verified: records.filter((r) => r.trustState === 'VERIFIED').length,
    conditional: records.filter((r) => r.trustState === 'CONDITIONAL').length,
    derived: records.filter((r) => r.origin === 'DERIVED').length,
    unresolved: records.filter((r) => r.trustState === 'UNRESOLVED').length,
    relationships,
    handoffs,
  };
}

/** Track C, or a registered B-domain, may receive a handoff. */
const isHandoffTarget = (v: string | null) => v !== null && (isDomainId(v) || /^(C|TRACK[_ ]?C|[A-E])$/i.test(v));

// --- the validator -----------------------------------------------------------------------------

export function validateRelease(pkg: ReleasePackage, ctx: ValidationContext = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const quarantined = new Map<string, ValidationIssue[]>();
  const known = ctx.knownRecordIds ?? new Set<string>();
  const releaseError = (rule: string, path: string, message: string) => issues.push({ rule, severity: 'error', scope: 'release', path, message });
  const releaseWarning = (rule: string, path: string, message: string) => issues.push({ rule, severity: 'warning', scope: 'release', path, message });
  const recordError = (rule: string, recordId: string, path: string, message: string) => {
    const issue: ValidationIssue = { rule, severity: 'error', scope: 'record', recordId, path, message };
    issues.push(issue);
    quarantined.set(recordId, [...(quarantined.get(recordId) ?? []), issue]);
  };
  const empty = computeCounts([], 0, 0);

  const c = pkg.canonical;
  if (!isObj(c)) {
    releaseError('TB-VAL-001', 'canonical', 'The canonical file must be one JSON object (the release envelope).');
    return { release: null, issues, rejected: true, quarantined, counts: empty };
  }
  const releaseId = str(c['release_id']);
  if (!releaseId) {
    releaseError('TB-VAL-002', 'release_id', 'release_id is missing.');
    return { release: null, issues, rejected: true, quarantined, counts: empty };
  }

  // TB-VAL-001 schema version
  const schemaVersion = str(c['schema_version']);
  if (!oneOf(SUPPORTED_SCHEMA_VERSIONS, schemaVersion)) {
    releaseError('TB-VAL-001', 'schema_version', `schema_version "${schemaVersion ?? ''}" is not supported (accepted: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}).`);
  }

  // TB-VAL-002 release / batch / domain identity
  const domainId = str(c['domain_id']);
  const batchId = str(c['batch_id']);
  const domainName = str(c['domain_name']);
  if (!isDomainId(domainId)) releaseError('TB-VAL-002', 'domain_id', `domain_id "${domainId ?? ''}" is not a registered domain (B1–B10).`);
  if (!batchId) releaseError('TB-VAL-002', 'batch_id', 'batch_id is missing.');
  if (c['track'] !== undefined && str(c['track']) !== 'B') releaseError('TB-VAL-002', 'track', `track must be "B" (got "${str(c['track']) ?? ''}").`);
  if (isDomainId(domainId)) {
    const expected = DOMAINS[domainId];
    if (domainName && domainName.toLowerCase() !== expected.name.toLowerCase()) {
      releaseWarning('TB-VAL-002', 'domain_name', `domain_name "${domainName}" differs from the registered name "${expected.name}".`);
    }
    const prefix = /^(B\d+)\./.exec(releaseId)?.[1];
    if (prefix && prefix !== domainId) releaseError('TB-VAL-002', 'release_id', `release_id ${releaseId} names ${prefix} but domain_id is ${domainId}.`);
    if (!releaseId.startsWith(`${domainId}.${expected.code}.`)) {
      releaseWarning('TB-VAL-002', 'release_id', `release_id does not follow the recommended pattern ${domainId}.${expected.code}.vX.Y.Z.`);
    }
  }
  const releaseStatus = str(c['release_status']);
  if (!oneOf(RELEASE_STATUSES, releaseStatus)) releaseError('SCHEMA', 'release_status', `release_status "${releaseStatus ?? ''}" is not one of ${RELEASE_STATUSES.join(', ')}.`);

  const generatedAt = str(c['generated_at']);
  if (!generatedAt || !ISO_DATE_TIME.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    releaseError('TB-VAL-012', 'generated_at', 'generated_at must be an ISO 8601 date-time (UTC, e.g. 2026-10-21T00:00:00Z).');
  } else if (!isUtc(generatedAt)) {
    releaseWarning('TB-VAL-012', 'generated_at', 'generated_at is not in UTC.');
  }

  const producer = isObj(c['producer']) ? c['producer'] : null;
  if (!producer || !str(producer['provider']) || !str(producer['model'])) {
    releaseError('SCHEMA', 'producer', 'producer must name the worker provider and model (contract §4.1).');
  }
  const governance = isObj(c['governance']) ? c['governance'] : null;
  if (!governance) releaseError('SCHEMA', 'governance', 'governance is missing.');
  else {
    const qa = str(governance['qa_status']);
    if (qa && !oneOf(QA_STATUSES, qa)) releaseError('SCHEMA', 'governance.qa_status', `qa_status "${qa}" is not one of ${QA_STATUSES.join(', ')}.`);
    const approvedAt = str(governance['approved_at']);
    if (approvedAt && !approvedAt.startsWith('<') && (!ISO_DATE_TIME.test(approvedAt) || Number.isNaN(Date.parse(approvedAt)))) {
      releaseError('TB-VAL-012', 'governance.approved_at', 'governance.approved_at must be an ISO 8601 date-time.');
    }
  }
  const declaredCounts = isObj(c['counts']) ? c['counts'] : null;
  if (!Array.isArray(c['records'])) releaseError('SCHEMA', 'records', 'records must be an array.');

  // --- evidence (manifest file, or an evidence list inside the canonical JSON) ---
  const manifestList =
    listIn(pkg.sourceManifest, ['evidence', 'sources', 'entries', 'items', 'source_manifest']) ??
    listIn(c, ['evidence', 'source_manifest', 'sources']);
  const hasManifest = manifestList !== null;
  if (!hasManifest) releaseError('PACKAGE', 'sourceManifest', 'The Source / Evidence Manifest is missing (a required deliverable, contract §3).');
  const evidence: NormEvidence[] = [];
  const badEvidence = new Map<string, string>();
  (manifestList ?? []).forEach((e, i) => {
    const ev = isObj(e) ? normEvidence(e) : null;
    if (!ev) {
      releaseError('SCHEMA', `sourceManifest[${i}]`, 'Evidence entry has no source_id / evidence_id.');
      return;
    }
    evidence.push(ev);
    const problems: string[] = [];
    if (!oneOf(SOURCE_TYPES, ev.sourceType)) problems.push(`source_type "${ev.sourceType ?? ''}" is not allowed`);
    if (!ev.publisher) problems.push('publisher/authority is missing');
    if (!ev.title && !ev.documentId) problems.push('title/document_id is missing');
    if (!ev.locator) problems.push('locator is missing (page, section, table, clause…)');
    if (!oneOf(SUPPORT_TYPES, ev.supportType)) problems.push(`support_type "${ev.supportType ?? ''}" is not allowed`);
    if (!oneOf(ACCESS_STATES, ev.accessState)) problems.push(`access/rights state "${ev.accessState ?? ''}" is not allowed`);
    if (ev.retrievedAt && !(ISO_DATE_TIME.test(ev.retrievedAt) || ISO_DATE.test(ev.retrievedAt))) problems.push('retrieved_at is not ISO 8601 (TB-VAL-012)');
    if (problems.length > 0) badEvidence.set(ev.evidenceId ?? ev.sourceId, problems.join('; '));
    if (!ev.revision && (ev.sourceType === 'STANDARD' || ev.sourceType === 'DATASHEET' || ev.sourceType === 'REFERENCE_MANUAL')) {
      releaseWarning('SCHEMA', `sourceManifest[${i}]`, `${ev.evidenceId ?? ev.sourceId}: versioned source without revision/version/date.`);
    }
  });
  const evidenceKeys = new Map<string, NormEvidence>();
  for (const ev of evidence) {
    if (ev.evidenceId) evidenceKeys.set(ev.evidenceId, ev);
    if (!evidenceKeys.has(ev.sourceId)) evidenceKeys.set(ev.sourceId, ev);
  }

  // --- records ---
  const records: NormRecord[] = [];
  const seenRecords = new Set<string>();
  arr(c['records']).forEach((r, i) => {
    const rec = isObj(r) ? normRecord(r, i) : null;
    if (!rec) {
      releaseError('TB-VAL-003', `records[${i}]`, 'Record has no record_id, so it cannot be addressed or quarantined.');
      return;
    }
    if (seenRecords.has(rec.recordId)) {
      releaseError('TB-VAL-003', `records[${i}].record_id`, `record_id ${rec.recordId} appears more than once in this release.`);
      return;
    }
    seenRecords.add(rec.recordId);
    records.push(rec);
  });

  // --- relationships / handoffs / gaps (ids unique; refs resolve) ---
  const relationships: NormRelationship[] = [];
  const seenRel = new Set<string>();
  arr(c['relationships']).forEach((r, i) => {
    const rel = isObj(r) ? normRelationship(r) : null;
    if (!rel) return releaseError('TB-VAL-003', `relationships[${i}]`, 'Relationship has no relationship_id.');
    if (seenRel.has(rel.relationshipId)) return releaseError('TB-VAL-003', `relationships[${i}]`, `relationship_id ${rel.relationshipId} is duplicated.`);
    seenRel.add(rel.relationshipId);
    relationships.push(rel);
  });
  const resolvesRecord = (id: string | null) => id !== null && (seenRecords.has(id) || known.has(id));
  for (const rel of relationships) {
    const where = `relationships.${rel.relationshipId}`;
    const owner = rel.fromRecordId && seenRecords.has(rel.fromRecordId) ? rel.fromRecordId : null;
    const fail = (rule: string, message: string) => (owner ? recordError(rule, owner, where, message) : releaseError(rule, where, message));
    if (!oneOf(RELATIONSHIP_TYPES, rel.type)) fail('SCHEMA', `type "${rel.type ?? ''}" is not one of ${RELATIONSHIP_TYPES.join(', ')}.`);
    if (!resolvesRecord(rel.fromRecordId)) fail('TB-VAL-007', `from_record_id ${rel.fromRecordId ?? '(missing)'} does not resolve.`);
    if (!rel.toRecordId && !rel.targetConcept) fail('SCHEMA', 'needs to_record_id or target_concept.');
    if (rel.toRecordId && !resolvesRecord(rel.toRecordId)) fail('TB-VAL-007', `to_record_id ${rel.toRecordId} does not resolve.`);
  }

  const handoffs: NormHandoff[] = [];
  const seenHandoffs = new Set<string>();
  arr(c['cross_domain_handoffs']).forEach((h, i) => {
    const ho = isObj(h) ? normHandoff(h) : null;
    const where = `cross_domain_handoffs[${i}]`;
    if (!ho) return releaseError('TB-VAL-003', where, 'Handoff has no handoff_id.');
    if (seenHandoffs.has(ho.handoffId)) return releaseError('TB-VAL-003', where, `handoff_id ${ho.handoffId} is duplicated.`);
    seenHandoffs.add(ho.handoffId);
    handoffs.push(ho);
    if (ho.sourceDomain !== domainId) releaseError('TB-VAL-002', where, `source_domain ${ho.sourceDomain ?? '(missing)'} must be the release domain ${domainId ?? ''}.`);
    if (!isHandoffTarget(ho.targetDomain)) releaseError('SCHEMA', where, `target_domain ${ho.targetDomain ?? '(missing)'} is not a B-domain or Track C.`);
    if (!ho.question) releaseError('SCHEMA', where, 'question is missing.');
    if (!ho.reason) releaseError('SCHEMA', where, 'reason is missing.');
    if (!ho.status) releaseError('SCHEMA', where, 'status is missing.');
    for (const ref of ho.sourceRecordRefs) if (!resolvesRecord(ref)) releaseError('TB-VAL-007', where, `source_record_refs: ${ref} does not resolve.`);
  });

  const gapList = listIn(pkg.gapRegistry, ['gaps', 'entries', 'items', 'gap_conflict_registry']) ?? listIn(c, ['gaps', 'gap_conflict_registry']);
  const hasGapRegistry = gapList !== null;
  if (!hasGapRegistry) releaseWarning('PACKAGE', 'gapRegistry', 'The Gap / Conflict Registry is missing; it is required before promotion (contract §3, §11).');
  const gaps: NormGap[] = [];
  const seenGaps = new Set<string>();
  (gapList ?? []).forEach((g, i) => {
    const gap = isObj(g) ? normGap(g, domainId, batchId) : null;
    const where = `gapRegistry[${i}]`;
    if (!gap) return releaseError('TB-VAL-003', where, 'Gap has no gap_id.');
    if (seenGaps.has(gap.gapId)) return releaseError('TB-VAL-003', where, `gap_id ${gap.gapId} is duplicated.`);
    seenGaps.add(gap.gapId);
    gaps.push(gap);
    if (!gap.topic && !gap.question) releaseError('SCHEMA', where, `${gap.gapId}: topic/question is missing.`);
    if (!oneOf(GAP_TYPES, gap.gapType)) releaseError('SCHEMA', where, `${gap.gapId}: gap_type "${gap.gapType ?? ''}" is not allowed.`);
    if (!oneOf(GAP_SEVERITIES, gap.severity)) releaseError('SCHEMA', where, `${gap.gapId}: severity "${gap.severity ?? ''}" is not allowed.`);
    if (!oneOf(GAP_STATUSES, gap.status)) releaseError('SCHEMA', where, `${gap.gapId}: status "${gap.status ?? ''}" is not allowed.`);
    if (gap.status === 'RESOLVED' && gap.resolutionRecordRefs.length === 0) releaseError('SCHEMA', where, `${gap.gapId}: a RESOLVED gap must name its resolution records.`);
    for (const ref of gap.resolutionRecordRefs) if (!resolvesRecord(ref)) releaseError('TB-VAL-007', where, `${gap.gapId}: resolution record ${ref} does not resolve.`);
  });

  if (pkg.qaReport === undefined || pkg.qaReport === null) releaseWarning('PACKAGE', 'qaReport', 'The QA Report is missing; it is required before promotion.');
  if (pkg.completionReport === undefined || pkg.completionReport === null) {
    releaseWarning('PACKAGE', 'completionReport', 'The Completion / Change Report is missing; it is required before promotion.');
  }

  // --- per-record rules ---
  const supersededTargets = new Set(records.map((r) => r.supersedes).filter((s): s is string => s !== null));
  const supersedesRelTargets = new Set(relationships.filter((r) => r.type === 'SUPERSEDES' && r.toRecordId).map((r) => r.toRecordId!));
  for (const r of records) {
    const p = `records[${r.index}]`;
    const id = r.recordId;
    if (r.recordRevision === null || r.recordRevision < 1) recordError('SCHEMA', id, `${p}.record_revision`, 'record_revision must be a positive integer.');
    if (!oneOf(RECORD_TYPES, r.recordType)) recordError('SCHEMA', id, `${p}.record_type`, `record_type "${r.recordType ?? ''}" is not allowed.`);
    if (r.domainId !== domainId) recordError('TB-VAL-002', id, `${p}.domain_id`, `domain_id ${r.domainId ?? '(missing)'} differs from the release domain ${domainId ?? ''}.`);
    if (!r.statement) recordError('SCHEMA', id, `${p}.normalized_statement`, 'normalized_statement is missing.');
    if (!oneOf(ORIGINS, r.origin)) recordError('SCHEMA', id, `${p}.origin`, `origin "${r.origin ?? ''}" is not SOURCE_BASED or DERIVED.`);
    if (!oneOf(TRUST_STATES, r.trustState)) recordError('SCHEMA', id, `${p}.trust_state`, `trust_state "${r.trustState ?? ''}" is not allowed.`);
    if (!oneOf(CONFIDENCES, r.confidence)) recordError('SCHEMA', id, `${p}.confidence`, `confidence "${r.confidence ?? ''}" is not HIGH, MEDIUM or LOW.`);
    if (!isObj(r.raw['applicability'])) recordError('SCHEMA', id, `${p}.applicability`, 'applicability is missing.');
    if (!isObj(r.raw['content'])) recordError('SCHEMA', id, `${p}.content`, 'content is missing.');
    if (!Array.isArray(r.raw['evidence_refs'])) recordError('SCHEMA', id, `${p}.evidence_refs`, 'evidence_refs must be an array.');
    if (!isObj(r.raw['version'])) recordError('SCHEMA', id, `${p}.version`, 'version is missing.');
    else {
      if (r.versionReleaseId !== releaseId) recordError('TB-VAL-002', id, `${p}.version.release_id`, `version.release_id ${r.versionReleaseId ?? '(missing)'} is not this release (${releaseId}).`);
      if (!oneOf(LIFECYCLE_STATUSES, r.lifecycle)) recordError('SCHEMA', id, `${p}.version.status`, `version.status "${r.lifecycle ?? ''}" is not ACTIVE, SUPERSEDED or RETIRED.`);
    }

    // TB-VAL-004
    if (r.origin === 'SOURCE_BASED' && r.trustState === 'VERIFIED' && r.evidenceRefs.length === 0) {
      recordError('TB-VAL-004', id, `${p}.evidence_refs`, 'A VERIFIED source-based record needs at least one evidence_ref.');
    }
    // TB-VAL-005 + §6.2 forbidden transformations
    if (r.recordType === 'DERIVED_MODEL' && r.origin !== 'DERIVED') recordError('TB-VAL-005', id, `${p}.origin`, 'A DERIVED_MODEL record must have origin DERIVED.');
    if (r.origin === 'DERIVED') {
      if (r.trustState === 'VERIFIED') recordError('TB-VAL-005', id, `${p}.trust_state`, 'A derived record cannot be VERIFIED (contract §6.2); use CONDITIONAL.');
      const expression = str(r.content['expression']) ?? str(r.content['model']);
      const inputs = arr(r.content['variables']).length + arr(r.content['inputs']).length;
      const assumptions = arr(r.content['assumptions']).length;
      if (!expression) recordError('TB-VAL-005', id, `${p}.content.expression`, 'A derived record needs a machine-readable expression/model.');
      if (inputs === 0 && assumptions === 0) recordError('TB-VAL-005', id, `${p}.content`, 'A derived record needs source-backed inputs or explicit assumptions.');
      if (r.content['uncertainty'] === undefined || r.content['uncertainty'] === null || r.content['uncertainty'] === '') {
        recordError('TB-VAL-005', id, `${p}.content.uncertainty`, 'A derived record must state its uncertainty.');
      }
      for (const v of arr(r.content['variables'])) {
        const ref = isObj(v) ? str(v['input_record_id']) : null;
        if (ref && !resolvesRecord(ref)) recordError('TB-VAL-007', id, `${p}.content.variables`, `input_record_id ${ref} does not resolve.`);
      }
      for (const v of arr(r.content['inputs'])) {
        const ref = isObj(v) ? str(v['record_id']) : null;
        if (ref && !resolvesRecord(ref)) recordError('TB-VAL-007', id, `${p}.content.inputs`, `input record ${ref} does not resolve.`);
      }
    }
    // TB-VAL-006
    if (r.trustState === 'CONDITIONAL' && r.applicability.conditions.length === 0 && r.applicability.excludes.length === 0) {
      recordError('TB-VAL-006', id, `${p}.applicability.conditions`, 'A CONDITIONAL record must state at least one condition or limitation.');
    }
    // TB-VAL-007 references
    for (const ref of r.evidenceRefs) {
      const ev = evidenceKeys.get(ref);
      if (!ev) {
        if (hasManifest) recordError('TB-VAL-007', id, `${p}.evidence_refs`, `evidence_ref ${ref} is not in the source manifest.`);
      } else if (badEvidence.has(ev.evidenceId ?? ev.sourceId)) {
        recordError('SCHEMA', id, `${p}.evidence_refs`, `evidence ${ref} is incomplete: ${badEvidence.get(ev.evidenceId ?? ev.sourceId)}.`);
      }
    }
    for (const ref of r.relationshipRefs) if (!seenRel.has(ref)) recordError('TB-VAL-007', id, `${p}.relationship_refs`, `relationship ${ref} is not in this release.`);
    if (r.supersedes && !resolvesRecord(r.supersedes)) recordError('TB-VAL-007', id, `${p}.version.supersedes`, `supersedes ${r.supersedes}, which is not in EKAB or this release.`);
    if (r.supersedes === id) recordError('TB-VAL-008', id, `${p}.version.supersedes`, 'A record cannot supersede itself.');
    // TB-VAL-008
    if (r.lifecycle === 'SUPERSEDED') {
      const successor = (r.supersededBy && resolvesRecord(r.supersededBy)) || supersededTargets.has(id) || supersedesRelTargets.has(id);
      if (!successor) recordError('TB-VAL-008', id, `${p}.version`, 'A SUPERSEDED record must identify its successor.');
    }
    // TB-VAL-009
    if ((r.trustState === 'UNRESOLVED' || r.trustState === 'REJECTED') && (r.qa['production_trusted'] === true || r.qa['production_eligible'] === true || r.tags.includes('production_trusted'))) {
      recordError('TB-VAL-009', id, `${p}.qa`, `${r.trustState} records must not be marked production-trusted.`);
    }
  }

  // Identifier lengths the store can hold (ids are never truncated: that would change identity).
  const tooLong = (kind: string, ids: string[], max: number) => {
    for (const id of ids) if (id.length > max) releaseError('TB-VAL-003', kind, `${kind} "${id.slice(0, 40)}…" is longer than ${max} characters.`);
  };
  if (releaseId.length > 80) releaseError('TB-VAL-002', 'release_id', 'release_id is longer than 80 characters.');
  if (batchId && batchId.length > 120) releaseError('TB-VAL-002', 'batch_id', 'batch_id is longer than 120 characters.');
  tooLong('record_id', records.map((r) => r.recordId), 120);
  tooLong('relationship_id', relationships.map((r) => r.relationshipId), 120);
  tooLong('gap_id', gaps.map((g) => g.gapId), 120);
  tooLong('handoff_id', handoffs.map((h) => h.handoffId), 120);
  tooLong('source_id', evidence.flatMap((e) => [e.sourceId, ...(e.evidenceId ? [e.evidenceId] : [])]), 160);

  // TB-VAL-010 secrets anywhere in the package
  const secrets = findSecrets(JSON.stringify([pkg.canonical, pkg.sourceManifest ?? null, pkg.gapRegistry ?? null, pkg.qaReport ?? null, pkg.completionReport ?? null]));
  if (secrets.length > 0) releaseError('TB-VAL-010', 'package', `Possible secrets found (${secrets.join(', ')}). Remove them before submitting.`);

  // TB-VAL-011 counts
  const counts = computeCounts(records, relationships.length, handoffs.length);
  if (!declaredCounts) releaseError('TB-VAL-011', 'counts', 'counts is missing.');
  else {
    const conditionalExcludingDerived = records.filter((r) => r.trustState === 'CONDITIONAL' && r.origin !== 'DERIVED').length;
    for (const key of Object.keys(counts) as Array<keyof ReleaseCounts>) {
      const declared = declaredCounts[key];
      const actual = counts[key];
      // "conditional" is accepted with or without the derived records (both readings of §6 exist).
      const ok = typeof declared === 'number' && (declared === actual || (key === 'conditional' && declared === conditionalExcludingDerived));
      if (!ok) releaseError('TB-VAL-011', `counts.${key}`, `counts.${key} says ${declared === undefined ? '(missing)' : String(declared)} but the payload has ${actual}.`);
    }
  }

  const release: NormRelease = {
    schemaVersion,
    releaseId,
    domainId,
    domainName,
    batchId,
    releaseStatus,
    generatedAt,
    producer,
    governance,
    sourceSnapshotId: str(c['source_snapshot_id']),
    declaredCounts,
    records,
    relationships,
    handoffs,
    evidence,
    gaps,
    hasManifest,
    hasGapRegistry,
    hasQaReport: pkg.qaReport !== undefined && pkg.qaReport !== null,
    hasCompletionReport: pkg.completionReport !== undefined && pkg.completionReport !== null,
  };
  const rejected = issues.some((i) => i.scope === 'release' && i.severity === 'error');
  return { release, issues, rejected, quarantined, counts };
}
