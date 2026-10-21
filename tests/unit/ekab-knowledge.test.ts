import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { citationLine, ekabKnowledgeService, topicsForCheck, topicsInText } from '../../src/modules/ekab/ekab-knowledge.service.js';

type Row = Record<string, unknown>;
const row = (over: Row): Row => ({
  id: `pk-${String(over['recordId'])}`,
  recordRevision: 1,
  releaseId: 'B1.COMM.v0.1.0',
  domainId: 'B1',
  recordType: 'DESIGN_RULE',
  title: null,
  topic: null,
  tags: [],
  origin: 'SOURCE_BASED',
  confidence: 'HIGH',
  applicability: { applies_to: [], conditions: [], excludes: [] },
  evidence: [{ locator: 'p. 26, § 11.2.1.1', sourceRevision: 'Rev. O', source: { title: 'Fixture datasheet', publisher: 'Fixture', url: 'https://example.com/ds.pdf' } }],
  ...over,
});

const ROWS = [
  row({ recordId: 'B1-T-CAN-1', trustState: 'CONDITIONAL', confidence: 'HIGH', normalizedStatement: 'TEST: CAN bus termination statement A.', applicability: { applies_to: [], conditions: ['bus longer than 1 m'], excludes: [] } }),
  row({ recordId: 'B1-T-CAN-2', trustState: 'VERIFIED', confidence: 'MEDIUM', normalizedStatement: 'TEST: terminate the CAN bus at both ends (statement B).' }),
  row({ recordId: 'B1-T-I2C-1', trustState: 'VERIFIED', normalizedStatement: 'TEST: I2C pull-up statement.' }),
  row({ recordId: 'B1-T-VERB', trustState: 'VERIFIED', normalizedStatement: 'TEST: you can terminate a cable anywhere.' }),
];

/** Only promoted, usable records reach Prototype; citations keep trust state and conditions. */
describe('EKAB knowledge for Prototype', () => {
  beforeEach(() => ekabKnowledgeService.resetCache());
  afterEach(() => jest.restoreAllMocks());
  const withRecords = (rows: Row[]) => {
    jest.spyOn(prisma.ekabRelease, 'aggregate').mockResolvedValue({ _count: { _all: rows.length > 0 ? 1 : 0 }, _max: { decidedAt: new Date('2026-10-21T00:00:00Z') } } as never);
    return jest.spyOn(prisma.ekabRecord, 'findMany').mockResolvedValue(rows as never);
  };

  it('maps checks to topics without mistaking the word "can"', () => {
    expect(topicsForCheck({ ruleType: 'protocol_compatibility', message: 'CAN bus: A, B share CAN_H / CAN_L (multidrop). Terminate both ends of the bus with 120 Ω.' })).toEqual(['can_termination']);
    expect(topicsForCheck({ ruleType: 'required_power_rail', message: 'The boost converter can not run from 12 V.' })).toEqual(['power_rail', 'boost']);
    expect(topicsInText('which pull-up should the I2C bus use?')).toEqual(['i2c_pullup']);
    expect(topicsInText('you can terminate it')).toEqual([]);
  });

  it('attaches the strongest records to each check and to the boards on that bus', async () => {
    withRecords(ROWS);
    const bench = {
      instances: [{ instanceId: 'mcu' }, { instanceId: 'can1' }, { instanceId: 'bme1' }],
      nets: [
        { class: 'can', members: [{ instanceId: 'can1' }] },
        { class: 'i2c', members: [{ instanceId: 'mcu' }, { instanceId: 'bme1' }] },
      ],
      compatibility: {
        results: [
          { ruleType: 'protocol_compatibility', message: 'CAN bus: X share CAN_H / CAN_L (multidrop). Terminate both ends of the bus with 120 Ω.', instanceIds: ['can1'] } as { ruleType: string; message: string; instanceIds: string[]; knowledgeRefs?: string[] },
          { ruleType: 'record_evidence', message: 'Facts from AI knowledge.', instanceIds: ['bme1'] } as { ruleType: string; message: string; instanceIds: string[]; knowledgeRefs?: string[] },
        ],
      },
    };
    const k = await ekabKnowledgeService.forBench(bench);
    // VERIFIED beats CONDITIONAL even at lower confidence; the "can" verb record never matches.
    expect(bench.compatibility.results[0]!.knowledgeRefs).toEqual(['B1-T-CAN-2', 'B1-T-CAN-1']);
    expect(bench.compatibility.results[1]!.knowledgeRefs).toBeUndefined();
    expect(k?.byInstance).toEqual({ can1: ['B1-T-CAN-2'], mcu: ['B1-T-I2C-1'], bme1: ['B1-T-I2C-1'] });
    expect(k?.records.map((r) => r.recordId).sort()).toEqual(['B1-T-CAN-1', 'B1-T-CAN-2', 'B1-T-I2C-1']);
    expect(k?.records.find((r) => r.recordId === 'B1-T-CAN-1')).toMatchObject({ trustState: 'CONDITIONAL', conditions: ['bus longer than 1 m'] });
  });

  it('writes CONDITIONAL records with their conditions and a source', () => {
    const line = citationLine({
      recordId: 'B1-T-CAN-1',
      revision: 2,
      releaseId: 'x',
      domainId: 'B1',
      recordType: 'RULE',
      title: null,
      statement: 'TEST statement.',
      trustState: 'CONDITIONAL',
      origin: 'SOURCE_BASED',
      confidence: 'HIGH',
      appliesTo: [],
      conditions: ['bus longer than 1 m'],
      excludes: ['CAN FD'],
      sources: [{ title: 'Fixture datasheet', publisher: null, locator: 'p. 26', url: null, revision: 'Rev. O' }],
    });
    expect(line).toBe('- [B1-T-CAN-1 r2, CONDITIONAL, only when: bus longer than 1 m; not CAN FD] TEST statement. (Source: Fixture datasheet, Rev. O, p. 26)');
  });

  it('gives nothing (and reads no records) when no release has been promoted', async () => {
    const findMany = withRecords([]);
    expect(await ekabKnowledgeService.forBench({ instances: [], nets: [], compatibility: { results: [] } })).toBeNull();
    expect(await ekabKnowledgeService.forText('CAN bus termination')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('never fails the caller when the knowledge base is unavailable', async () => {
    jest.spyOn(prisma.ekabRelease, 'aggregate').mockRejectedValue(new Error('db down'));
    expect(await ekabKnowledgeService.forText('CAN bus termination')).toEqual([]);
  });

  it('reloads only when the promoted set changes', async () => {
    const findMany = withRecords(ROWS);
    await ekabKnowledgeService.forText('CAN termination');
    await ekabKnowledgeService.forText('I2C pull-up');
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
