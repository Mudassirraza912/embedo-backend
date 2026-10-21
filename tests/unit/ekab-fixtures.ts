/**
 * A small Track B release package that follows the canonical contract, for tests only. Its
 * statements are placeholders and assert no engineering truth (the contract's own §15 examples
 * are structural in the same way).
 */

type Json = Record<string, unknown>;

export const FIXTURE_RELEASE_ID = 'B1.COMM.v0.0.1';

export function sampleRecords(): Json[] {
  const version = { release_id: FIXTURE_RELEASE_ID, status: 'ACTIVE', supersedes: null };
  return [
    {
      record_id: 'B1-COMM-T0001',
      record_revision: 1,
      record_type: 'DESIGN_RULE',
      domain_id: 'B1',
      topic: 'CAN bus termination',
      title: 'TEST FIXTURE: CAN termination rule',
      normalized_statement: 'TEST FIXTURE: placeholder rule about CAN bus termination (not engineering knowledge).',
      origin: 'SOURCE_BASED',
      trust_state: 'VERIFIED',
      confidence: 'HIGH',
      applicability: { applies_to: ['Classical CAN'], excludes: [], conditions: [] },
      content: { layer: 'PHY' },
      evidence_refs: ['SRC-EVID-T1'],
      relationship_refs: [],
      tags: ['CAN', 'termination'],
      version,
      qa: { checked: true, issues: [] },
    },
    {
      record_id: 'B1-COMM-T0002',
      record_revision: 1,
      record_type: 'CONSTRAINT',
      domain_id: 'B1',
      topic: 'I2C pull-up resistors',
      title: 'TEST FIXTURE: I2C pull-up constraint',
      normalized_statement: 'TEST FIXTURE: placeholder constraint about I2C pull-ups (not engineering knowledge).',
      origin: 'SOURCE_BASED',
      trust_state: 'CONDITIONAL',
      confidence: 'MEDIUM',
      applicability: { applies_to: ['I2C'], excludes: [], conditions: ['Standard-mode bus', { bus_capacitance_pf: { max: 400 } }] },
      content: {},
      evidence_refs: ['SRC-EVID-T2'],
      relationship_refs: [],
      tags: ['I2C', 'pull-up'],
      version,
      qa: { checked: true, issues: [] },
    },
    {
      record_id: 'B1-COMM-T0003',
      record_revision: 1,
      record_type: 'DERIVED_MODEL',
      domain_id: 'B1',
      topic: 'I2C pull-up sizing',
      title: 'TEST FIXTURE: derived pull-up estimate',
      normalized_statement: 'TEST FIXTURE: placeholder derived estimate (not engineering knowledge).',
      origin: 'DERIVED',
      trust_state: 'CONDITIONAL',
      confidence: 'MEDIUM',
      applicability: { applies_to: [], excludes: [], conditions: ['Ideal resistor, no leakage'] },
      content: {
        expression: 'r_max = t_r / (0.8473 * c_b)',
        variables: [{ name: 'c_b', unit: 'F', input_record_id: 'B1-COMM-T0002' }],
        assumptions: ['Placeholder assumption'],
        output: { quantity: 'resistance', unit: 'ohm' },
        uncertainty: { type: 'QUALITATIVE', value: 'placeholder' },
        validation: 'NOT_MEASURED',
      },
      evidence_refs: ['SRC-EVID-T2'],
      relationship_refs: ['REL-T1'],
      tags: ['I2C'],
      version,
      qa: { checked: true, issues: [] },
    },
    {
      record_id: 'B1-COMM-T0004',
      record_revision: 1,
      record_type: 'FACT',
      domain_id: 'B1',
      topic: 'RS-485 node count',
      title: 'TEST FIXTURE: unresolved fact',
      normalized_statement: 'TEST FIXTURE: placeholder fact whose evidence is restricted.',
      origin: 'SOURCE_BASED',
      trust_state: 'UNRESOLVED',
      confidence: 'LOW',
      applicability: { applies_to: [], excludes: [], conditions: [] },
      content: {},
      evidence_refs: [],
      relationship_refs: [],
      tags: ['RS-485'],
      version,
      qa: { checked: true, issues: [] },
    },
  ];
}

export function samplePackage(): {
  canonical: Json;
  sourceManifest: Json;
  gapRegistry: Json;
  qaReport: Json;
  completionReport: Json;
} {
  const records = sampleRecords();
  return {
    canonical: {
      schema_version: 'track-b-ekab-1.0',
      release_id: FIXTURE_RELEASE_ID,
      track: 'B',
      domain_id: 'B1',
      domain_name: 'Communication Intelligence',
      batch_id: 'B1-TEST-FIXTURE-001',
      release_status: 'APPROVED_FOR_INGESTION',
      generated_at: '2026-10-21T00:00:00Z',
      producer: { provider: 'internal', model: 'test-fixture', run_id: 'fixture-run-1' },
      governance: { qa_status: 'PASS', approved_by: 'B0_or_equivalent', approved_at: '2026-10-21T01:00:00Z' },
      source_snapshot_id: 'SRC-SNAPSHOT-TEST-1',
      counts: { records: 4, verified: 1, conditional: 2, derived: 1, unresolved: 1, relationships: 1, handoffs: 1 },
      records,
      relationships: [{ relationship_id: 'REL-T1', type: 'DEPENDS_ON', from_record_id: 'B1-COMM-T0003', to_record_id: 'B1-COMM-T0002' }],
      cross_domain_handoffs: [
        {
          handoff_id: 'B1-TO-B2-T1',
          source_domain: 'B1',
          target_domain: 'B2',
          source_record_refs: ['B1-COMM-T0001'],
          question: 'TEST FIXTURE: placeholder power question',
          reason: 'OUT_OF_DOMAIN',
          priority: 'NORMAL',
          blocking: false,
          status: 'OPEN',
          resolution_record_refs: [],
        },
      ],
    },
    sourceManifest: {
      evidence: [
        {
          evidence_id: 'SRC-EVID-T1',
          source_id: 'SRC-TEST-001',
          source_type: 'OFFICIAL_DOC',
          publisher: 'Embedo test fixture',
          title: 'Test fixture document (not a real source)',
          revision: 'r0',
          url: 'https://example.com/fixture.pdf',
          locator: 'Section 0',
          retrieved_at: '2026-10-21T00:00:00Z',
          support_type: 'DIRECT',
          access_state: 'PUBLIC',
        },
        {
          evidence_id: 'SRC-EVID-T2',
          source_id: 'SRC-TEST-002',
          source_type: 'APP_NOTE',
          authority: 'Embedo test fixture',
          title: 'Second test fixture document',
          version: 'r1',
          locator: 'Table 1',
          retrieved_at: '2026-10-21',
          support_type: 'SUPPORTING',
          rights_state: 'PUBLIC',
        },
      ],
    },
    gapRegistry: {
      gaps: [
        {
          gap_id: 'GAP-B1-T1',
          domain_id: 'B1',
          topic: 'RS-485 node count',
          question: 'TEST FIXTURE: placeholder restricted-standard question',
          gap_type: 'RESTRICTED_SOURCE',
          severity: 'NORMAL',
          status: 'OPEN',
          source_refs: [],
          resolution_record_refs: [],
        },
      ],
    },
    qaReport: { schema_status: 'PASS', outcome: 'PASS' },
    completionReport: { release_id: FIXTURE_RELEASE_ID, decision: 'APPROVED_FOR_INGESTION' },
  };
}

export const records = (pkg: ReturnType<typeof samplePackage>) => pkg.canonical['records'] as Json[];
