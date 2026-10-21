import { describe, it, expect } from '@jest/globals';
import { validateRelease, findSecrets } from '../../src/modules/ekab/ekab-validator.js';
import { promotionBlockers } from '../../src/modules/ekab/ekab-release.service.js';
import { records, samplePackage } from './ekab-fixtures.js';

type Json = Record<string, unknown>;
const rec = (pkg: ReturnType<typeof samplePackage>, i: number) => records(pkg)[i]!;
const rulesOf = (r: ReturnType<typeof validateRelease>) => [...new Set(r.issues.filter((i) => i.severity === 'error').map((i) => i.rule))];
const quarantinedBy = (r: ReturnType<typeof validateRelease>, id: string) => (r.quarantined.get(id) ?? []).map((i) => i.rule);

/** Contract §19 TB-VAL-001…012 and the §13 schema gate. */
describe('Track B release validator', () => {
  it('accepts a release that follows the contract', () => {
    const r = validateRelease(samplePackage());
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.rejected).toBe(false);
    expect(r.quarantined.size).toBe(0);
    expect(r.counts).toEqual({ records: 4, verified: 1, conditional: 2, derived: 1, unresolved: 1, relationships: 1, handoffs: 1 });
    expect(r.release?.evidence.map((e) => e.publisher)).toEqual(['Embedo test fixture', 'Embedo test fixture']); // "authority" read as publisher
  });

  it('TB-VAL-001: rejects an unsupported schema version', () => {
    const pkg = samplePackage();
    pkg.canonical['schema_version'] = 'track-b-ekab-0.9';
    const r = validateRelease(pkg);
    expect(r.rejected).toBe(true);
    expect(rulesOf(r)).toContain('TB-VAL-001');
  });

  it('TB-VAL-002: release id, domain and record domains must agree', () => {
    const pkg = samplePackage();
    pkg.canonical['release_id'] = 'B2.POWER.v1.0.0';
    expect(rulesOf(validateRelease(pkg))).toContain('TB-VAL-002');

    const pkg2 = samplePackage();
    rec(pkg2, 0)['domain_id'] = 'B2';
    const r2 = validateRelease(pkg2);
    expect(r2.rejected).toBe(false);
    expect(quarantinedBy(r2, 'B1-COMM-T0001')).toContain('TB-VAL-002');

    const pkg3 = samplePackage();
    pkg3.canonical['domain_id'] = 'B11';
    expect(validateRelease(pkg3).rejected).toBe(true);
  });

  it('TB-VAL-003: duplicate record ids reject the release', () => {
    const pkg = samplePackage();
    records(pkg).push({ ...rec(pkg, 0) });
    const r = validateRelease(pkg);
    expect(r.rejected).toBe(true);
    expect(rulesOf(r)).toContain('TB-VAL-003');
  });

  it('TB-VAL-004: a VERIFIED source-based record needs evidence', () => {
    const pkg = samplePackage();
    rec(pkg, 0)['evidence_refs'] = [];
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0001')).toContain('TB-VAL-004');
  });

  it('TB-VAL-005: derived records need expression, inputs/assumptions and uncertainty, and are never VERIFIED', () => {
    const pkg = samplePackage();
    const derived = rec(pkg, 2);
    derived['content'] = { ...(derived['content'] as Json), expression: '', uncertainty: undefined };
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0003').filter((x) => x === 'TB-VAL-005').length).toBe(2);

    const pkg2 = samplePackage();
    rec(pkg2, 2)['trust_state'] = 'VERIFIED';
    pkg2.canonical['counts'] = { ...(pkg2.canonical['counts'] as Json), verified: 2, conditional: 1 };
    expect(quarantinedBy(validateRelease(pkg2), 'B1-COMM-T0003')).toContain('TB-VAL-005');

    const pkg3 = samplePackage();
    rec(pkg3, 2)['origin'] = 'SOURCE_BASED';
    pkg3.canonical['counts'] = { ...(pkg3.canonical['counts'] as Json), derived: 0 };
    expect(quarantinedBy(validateRelease(pkg3), 'B1-COMM-T0003')).toContain('TB-VAL-005');
  });

  it('TB-VAL-006: a CONDITIONAL record must state a condition', () => {
    const pkg = samplePackage();
    rec(pkg, 1)['applicability'] = { applies_to: ['I2C'], excludes: [], conditions: [] };
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0002')).toContain('TB-VAL-006');
  });

  it('TB-VAL-007: evidence, relationship and cross-release references must resolve', () => {
    const pkg = samplePackage();
    rec(pkg, 0)['evidence_refs'] = ['SRC-EVID-MISSING'];
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0001')).toContain('TB-VAL-007');

    const pkg2 = samplePackage();
    (pkg2.canonical['relationships'] as Json[])[0]!['to_record_id'] = 'B1-COMM-OLD-9';
    expect(quarantinedBy(validateRelease(pkg2), 'B1-COMM-T0003')).toContain('TB-VAL-007');
    // …but a record already in EKAB resolves.
    expect(validateRelease(pkg2, { knownRecordIds: new Set(['B1-COMM-OLD-9']) }).quarantined.size).toBe(0);
  });

  it('TB-VAL-008: a SUPERSEDED record must name its successor', () => {
    const pkg = samplePackage();
    rec(pkg, 1)['version'] = { release_id: 'B1.COMM.v0.0.1', status: 'SUPERSEDED', supersedes: null };
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0002')).toContain('TB-VAL-008');
    rec(pkg, 0)['version'] = { release_id: 'B1.COMM.v0.0.1', status: 'ACTIVE', supersedes: 'B1-COMM-T0002' };
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0002')).not.toContain('TB-VAL-008');
  });

  it('TB-VAL-009: UNRESOLVED records cannot be marked production-trusted', () => {
    const pkg = samplePackage();
    rec(pkg, 3)['qa'] = { checked: true, production_trusted: true };
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0004')).toContain('TB-VAL-009');
  });

  it('TB-VAL-010: secrets anywhere in the package reject it', () => {
    const pkg = samplePackage();
    pkg.qaReport['note'] = 'token=ghp_' + 'a'.repeat(36);
    const r = validateRelease(pkg);
    expect(r.rejected).toBe(true);
    expect(rulesOf(r)).toContain('TB-VAL-010');
    expect(findSecrets('nothing to see')).toEqual([]);
  });

  it('TB-VAL-011: declared counts must match the payload (conditional may exclude derived)', () => {
    const pkg = samplePackage();
    pkg.canonical['counts'] = { ...(pkg.canonical['counts'] as Json), records: 5 };
    expect(rulesOf(validateRelease(pkg))).toContain('TB-VAL-011');

    const pkg2 = samplePackage();
    pkg2.canonical['counts'] = { ...(pkg2.canonical['counts'] as Json), conditional: 1 };
    expect(validateRelease(pkg2).rejected).toBe(false);
  });

  it('TB-VAL-012: timestamps must be ISO 8601', () => {
    const pkg = samplePackage();
    pkg.canonical['generated_at'] = '21/10/2026';
    expect(rulesOf(validateRelease(pkg))).toContain('TB-VAL-012');
  });

  it('requires the source manifest; other supporting files are needed before promotion', () => {
    const pkg = samplePackage();
    const r = validateRelease({ canonical: pkg.canonical });
    expect(r.rejected).toBe(true);
    expect(r.issues.filter((i) => i.rule === 'PACKAGE').map((i) => i.path).sort()).toEqual(['completionReport', 'gapRegistry', 'qaReport', 'sourceManifest']);

    const r2 = validateRelease({ canonical: pkg.canonical, sourceManifest: pkg.sourceManifest.evidence });
    expect(r2.rejected).toBe(false); // a bare evidence array is accepted
    expect(r2.issues.filter((i) => i.rule === 'PACKAGE' && i.severity === 'warning')).toHaveLength(3);
  });

  it('quarantines records citing incomplete evidence and rejects malformed gaps', () => {
    const pkg = samplePackage();
    ((pkg.sourceManifest['evidence'] as Json[])[0] as Json)['locator'] = '';
    expect(quarantinedBy(validateRelease(pkg), 'B1-COMM-T0001')).toContain('SCHEMA');

    const pkg2 = samplePackage();
    ((pkg2.gapRegistry['gaps'] as Json[])[0] as Json)['gap_type'] = 'GUESS';
    expect(validateRelease(pkg2).rejected).toBe(true);
  });

  it('cannot read a package without a release_id', () => {
    const r = validateRelease({ canonical: { schema_version: 'track-b-ekab-1.0' } });
    expect(r.release).toBeNull();
    expect(r.rejected).toBe(true);
  });
});

describe('EKAB promotion gate (Appendix C)', () => {
  const ready = {
    ingestionState: 'STAGED',
    releaseStatus: 'APPROVED_FOR_INGESTION',
    governance: { qa_status: 'PASS' },
    validationIssues: [],
    roundTrip: { passed: true },
    computedCounts: { quarantined: 0 },
  };

  it('lets a staged, approved, round-tripped release through', () => {
    expect(promotionBlockers(ready)).toEqual([]);
  });

  it('blocks without QA approval, but an admin QA approval counts', () => {
    const pending = { ...ready, releaseStatus: 'QA_PENDING', governance: {} };
    expect(promotionBlockers(pending)).toHaveLength(1);
    expect(promotionBlockers({ ...pending, governance: { ekab_approval: { qa_status: 'PASS_WITH_EXCLUSIONS' } } })).toEqual([]);
  });

  it('needs explicit acceptance of exclusions for a quarantined release', () => {
    const q = { ...ready, ingestionState: 'QUARANTINED', computedCounts: { quarantined: 2 } };
    expect(promotionBlockers(q)[0]).toMatch(/2 record\(s\) are quarantined/);
    expect(promotionBlockers(q, { acceptExclusions: true })).toEqual([]);
  });

  it('blocks on missing supporting files, failed round trip, or the wrong state', () => {
    expect(promotionBlockers({ ...ready, validationIssues: [{ rule: 'PACKAGE', message: 'The QA Report is missing' }] })).toEqual(['The QA Report is missing']);
    expect(promotionBlockers({ ...ready, roundTrip: { passed: false } })).toHaveLength(1);
    expect(promotionBlockers({ ...ready, roundTrip: null })).toHaveLength(1);
    expect(promotionBlockers({ ...ready, ingestionState: 'PROMOTED' })).toHaveLength(1);
  });
});
