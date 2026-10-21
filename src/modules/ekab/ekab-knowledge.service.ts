import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { REASONING_TRUST_STATES } from './ekab.constants.js';
import { ekabEmbeddingService } from './ekab-embedding.service.js';

/**
 * Read side of EKAB for the product (contract §14.2, §16): only PROMOTED, ACTIVE, non-quarantined
 * records that are VERIFIED or CONDITIONAL ever reach Prototype. Every citation carries its trust
 * state, conditions and evidence, so a CONDITIONAL record is never shown as unconditional fact.
 *
 * Load: the usable records are cached in memory and reloaded only when the set of promoted
 * releases changes (checked with one aggregate query at most once a minute). Topic matching is
 * deterministic keyword logic; chat may add one embedding call. Any EKAB failure returns nothing,
 * so the product behaves exactly as without EKAB.
 */

export interface KnowledgeSource {
  title: string | null;
  publisher: string | null;
  locator: string | null;
  url: string | null;
  revision: string | null;
}

export interface KnowledgeCitation {
  recordId: string;
  revision: number | null;
  releaseId: string;
  domainId: string | null;
  recordType: string | null;
  title: string | null;
  statement: string;
  trustState: 'VERIFIED' | 'CONDITIONAL';
  origin: string | null;
  confidence: string | null;
  appliesTo: string[];
  conditions: string[];
  excludes: string[];
  sources: KnowledgeSource[];
}

interface CachedRecord extends KnowledgeCitation {
  id: string;
  haystack: string;
}

// --- topics --------------------------------------------------------------------------------------

/** "CAN" is matched case-sensitively so the English word "can" never counts. */
const CAN = /\bCAN(?: FD| XL)?\b|Controller Area Network/;
const RS485 = /RS-?485|EIA-?485|TIA-?485/i;
const I2C = /\bI2C\b|I²C|\bIIC\b/i;

export const TOPICS = {
  can_termination: { label: 'CAN termination', domain: 'B1', all: [CAN, /terminat/i] },
  can_transceiver: { label: 'CAN transceivers', domain: 'B1', all: [CAN, /transceiver|CANH|CANL|differential/i] },
  rs485_termination: { label: 'RS-485 termination and biasing', domain: 'B1', all: [RS485, /terminat|fail-?safe|bias/i] },
  rs485_transceiver: { label: 'RS-485 transceivers', domain: 'B1', all: [RS485, /transceiver|driver enable|\bDE\b|receiver/i] },
  i2c_pullup: { label: 'I²C pull-ups and bus capacitance', domain: 'B1', all: [I2C, /pull-?up|rise time|bus capacitance/i] },
  i2c_address: { label: 'I²C addressing', domain: 'B1', all: [I2C, /address/i] },
  spi: { label: 'SPI', domain: 'B1', all: [/\bSPI\b/, /chip select|\bCS\b|clock|mode|CPOL|CPHA/i] },
  uart: { label: 'UART', domain: 'B1', all: [/\bU(S)?ART\b|RS-?232|baud/i] },
  logic_levels: { label: 'Logic levels', domain: 'B1', all: [/logic|input|output/i, /\bV_?IH\b|\bV_?IL\b|threshold|tolerant|logic level/i] },
  level_shifting: { label: 'Level shifting', domain: 'B1', all: [/level[- ]?(shift|translat)/i] },
  bus_contention: { label: 'Bus contention', domain: 'B1', all: [/contention|bus (fight|conflict)|(two|multiple) (outputs|drivers)/i] },
  power_rail: { label: 'Supply rails', domain: 'B2', all: [/supply|\brails?\b|\bVCC\b|\bVDD\b|\bVIN\b/i, /voltage|range|regulat|decoupl|bypass/i] },
  boost: { label: 'Boost converters', domain: 'B2', all: [/\bboost\b|step-?up/i] },
  buck: { label: 'Buck converters and regulators', domain: 'B2', all: [/\bbuck\b|step-?down|\bLDO\b|linear regulator/i] },
  battery: { label: 'Batteries and charging', domain: 'B2', all: [/battery|Li-?ion|LiPo|LiFePO4|charg(er|ing)/i] },
  connector: { label: 'Connectors', domain: 'B1', all: [/STEMMA|Qwiic|connector/i] },
} as const;
export type TopicKey = keyof typeof TOPICS;
const TOPIC_KEYS = Object.keys(TOPICS) as TopicKey[];

/** Which topics a Prototype check is about (ruleType + its own message, nothing else). */
export function topicsForCheck(r: { ruleType: string; message: string }): TopicKey[] {
  const m = r.message;
  const out = new Set<TopicKey>();
  switch (r.ruleType) {
    case 'protocol_compatibility':
      if (CAN.test(m)) out.add('can_termination');
      if (RS485.test(m)) out.add('rs485_termination');
      if (I2C.test(m)) out.add('i2c_pullup');
      break;
    case 'required_host_interface':
      if (CAN.test(m)) out.add('can_transceiver');
      if (RS485.test(m)) out.add('rs485_transceiver');
      if (I2C.test(m)) out.add('i2c_pullup');
      if (/\bSPI\b/.test(m)) out.add('spi');
      if (/\bUART\b/.test(m)) out.add('uart');
      break;
    case 'logic_voltage_compatibility':
      out.add('logic_levels');
      if (/shift|BSS138|74AHCT|translat/i.test(m)) out.add('level_shifting');
      break;
    case 'bus_address_conflict':
      out.add('i2c_address');
      break;
    case 'signal_direction_conflict':
      out.add('bus_contention');
      break;
    case 'required_power_rail':
      out.add('power_rail');
      if (/boost|step-?up/i.test(m)) out.add('boost');
      if (/buck|step-?down|regulator/i.test(m)) out.add('buck');
      if (/battery|LiPo|charger|VBAT/i.test(m)) out.add('battery');
      break;
    case 'connector_family_compatibility':
      out.add('connector');
      break;
  }
  return [...out];
}

/** Topics of a bench instance from the nets it sits on. */
const NET_TOPICS: Record<string, TopicKey[]> = {
  i2c: ['i2c_pullup', 'i2c_address'],
  spi: ['spi'],
  uart: ['uart'],
  can: ['can_termination', 'can_transceiver'],
  rs485: ['rs485_termination', 'rs485_transceiver'],
  power: ['power_rail'],
};

/** Topics a piece of free text (a brief, a chat question) mentions. */
export function topicsInText(text: string): TopicKey[] {
  return TOPIC_KEYS.filter((k) => TOPICS[k].all.every((re) => re.test(text)));
}

// --- cache ---------------------------------------------------------------------------------------

const CACHE_CHECK_MS = 60_000;
let cache: { stamp: string; checkedAt: number; records: CachedRecord[] } | null = null;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);

async function activeRecords(): Promise<CachedRecord[]> {
  try {
    if (cache && Date.now() - cache.checkedAt < CACHE_CHECK_MS) return cache.records;
    const agg = await prisma.ekabRelease.aggregate({
      where: { ingestionState: { in: ['PROMOTED', 'SUPERSEDED'] } },
      _count: { _all: true },
      _max: { decidedAt: true },
    });
    const stamp = `${agg._count._all}:${agg._max.decidedAt?.toISOString() ?? ''}`;
    if (cache && cache.stamp === stamp) {
      cache.checkedAt = Date.now();
      return cache.records;
    }
    const rows =
      agg._count._all === 0
        ? []
        : await prisma.ekabRecord.findMany({
            where: {
              release: { ingestionState: 'PROMOTED' },
              lifecycleStatus: 'ACTIVE',
              quarantined: false,
              trustState: { in: [...REASONING_TRUST_STATES] },
              normalizedStatement: { not: null },
            },
            select: {
              id: true,
              recordId: true,
              recordRevision: true,
              releaseId: true,
              domainId: true,
              recordType: true,
              title: true,
              topic: true,
              tags: true,
              normalizedStatement: true,
              trustState: true,
              origin: true,
              confidence: true,
              applicability: true,
              evidence: { select: { locator: true, sourceRevision: true, source: { select: { title: true, publisher: true, url: true } } } },
            },
            orderBy: { recordId: 'asc' },
            take: 20_000,
          });
    const records: CachedRecord[] = rows.map((r) => {
      const a = (r.applicability ?? {}) as Record<string, unknown>;
      const appliesTo = strings(a['applies_to']);
      return {
        id: r.id,
        recordId: r.recordId,
        revision: r.recordRevision,
        releaseId: r.releaseId,
        domainId: r.domainId,
        recordType: r.recordType,
        title: r.title,
        statement: r.normalizedStatement!,
        trustState: r.trustState as 'VERIFIED' | 'CONDITIONAL',
        origin: r.origin,
        confidence: r.confidence,
        appliesTo,
        conditions: strings(a['conditions']),
        excludes: strings(a['excludes']),
        sources: r.evidence.map((e) => ({ title: e.source.title, publisher: e.source.publisher, locator: e.locator, url: e.source.url, revision: e.sourceRevision })),
        haystack: [r.title, r.topic, r.tags.join(' '), r.normalizedStatement, appliesTo.join(' ')].filter(Boolean).join(' \n '),
      };
    });
    cache = { stamp, checkedAt: Date.now(), records };
    return records;
  } catch (err) {
    logger.warn({ err }, 'EKAB knowledge unavailable; continuing without it');
    return [];
  }
}

const CONFIDENCE_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/** Records about one topic, strongest first: VERIFIED, then confidence, then the topic's home domain. */
function pick(records: CachedRecord[], topic: TopicKey, limit: number): CachedRecord[] {
  const t = TOPICS[topic];
  return records
    .filter((r) => t.all.every((re) => re.test(r.haystack)))
    .sort(
      (a, b) =>
        (a.trustState === 'VERIFIED' ? 0 : 1) - (b.trustState === 'VERIFIED' ? 0 : 1) ||
        (CONFIDENCE_RANK[a.confidence ?? ''] ?? 3) - (CONFIDENCE_RANK[b.confidence ?? ''] ?? 3) ||
        (a.domainId === t.domain ? 0 : 1) - (b.domainId === t.domain ? 0 : 1) ||
        a.recordId.localeCompare(b.recordId)
    )
    .slice(0, limit);
}

function pickTopics(records: CachedRecord[], topics: TopicKey[], perTopic: number, limit: number): CachedRecord[] {
  const out = new Map<string, CachedRecord>();
  for (const topic of topics) for (const r of pick(records, topic, perTopic)) if (out.size < limit) out.set(r.recordId, r);
  return [...out.values()];
}

export const toCitation = ({ id: _id, haystack: _h, ...citation }: CachedRecord): KnowledgeCitation => citation;

/** One line per record for prompts. CONDITIONAL records always carry their conditions. */
export function citationLine(c: KnowledgeCitation): string {
  const src = c.sources[0];
  const where = src ? ` (Source: ${[src.title, src.revision, src.locator].filter(Boolean).join(', ')})` : '';
  const when = c.trustState === 'CONDITIONAL' ? `, only when: ${[...c.conditions, ...c.excludes.map((e) => `not ${e}`)].join('; ') || 'see source'}` : '';
  return `- [${c.recordId} r${c.revision ?? 1}, ${c.trustState}${when}] ${c.statement}${where}`;
}

export interface BenchKnowledge {
  asOf: string;
  records: KnowledgeCitation[];
  /** instanceId → record ids relevant to that board's buses and checks. */
  byInstance: Record<string, string[]>;
}

const MAX_BENCH_RECORDS = 40;

export const ekabKnowledgeService = {
  /**
   * Snapshot of the knowledge behind a Prototype bench: each check gets `knowledgeRefs`, each
   * instance a list in `byInstance`. Stored with the version so it shows what was known then.
   */
  async forBench(bench: {
    instances: Array<{ instanceId: string }>;
    nets: Array<{ class: string; members: Array<{ instanceId: string }> }>;
    compatibility: { results: Array<{ ruleType: string; message: string; instanceIds: string[]; knowledgeRefs?: string[] }> };
  }): Promise<BenchKnowledge | null> {
    const records = await activeRecords();
    if (records.length === 0) return null;
    const included = new Map<string, CachedRecord>();
    /** Record ids to cite, within the payload's record budget. */
    const include = (rs: CachedRecord[]) => {
      const refs: string[] = [];
      for (const r of rs) {
        if (!included.has(r.recordId)) {
          if (included.size >= MAX_BENCH_RECORDS) continue;
          included.set(r.recordId, r);
        }
        refs.push(r.recordId);
      }
      return refs;
    };

    const instanceTopics = new Map<string, Set<TopicKey>>(bench.instances.map((i) => [i.instanceId, new Set<TopicKey>()]));
    for (const result of bench.compatibility.results) {
      const topics = topicsForCheck(result);
      if (topics.length === 0) continue;
      const refs = include(pickTopics(records, topics, 2, 3));
      if (refs.length > 0) result.knowledgeRefs = refs;
      for (const id of result.instanceIds) for (const t of topics) instanceTopics.get(id)?.add(t);
    }
    for (const net of bench.nets) {
      for (const t of NET_TOPICS[net.class] ?? []) for (const m of net.members) instanceTopics.get(m.instanceId)?.add(t);
    }
    const byInstance: Record<string, string[]> = {};
    for (const [instanceId, topics] of instanceTopics) {
      const refs = include(pickTopics(records, [...topics], 1, 4));
      if (refs.length > 0) byInstance[instanceId] = refs;
    }
    if (included.size === 0) return null;
    return { asOf: new Date().toISOString(), records: [...included.values()].map(toCitation), byInstance };
  },

  /** Deterministic rules for a brief (resolver / sourcing prompts). */
  async forText(text: string, limit = 8): Promise<KnowledgeCitation[]> {
    const records = await activeRecords();
    if (records.length === 0) return [];
    return pickTopics(records, topicsInText(text), 2, limit).map(toCitation);
  },

  /** For a chat question: topic matches first, then (one embedding call) the nearest records. */
  async forQuestion(question: string, limit = 5): Promise<KnowledgeCitation[]> {
    const records = await activeRecords();
    if (records.length === 0) return [];
    const byTopic = pickTopics(records, topicsInText(question), 2, limit);
    if (byTopic.length >= limit) return byTopic.map(toCitation);
    const ranked = await ekabEmbeddingService.rankEligible(question, limit);
    const byId = new Map(records.map((r) => [r.id, r]));
    const out = new Map(byTopic.map((r) => [r.recordId, r]));
    for (const id of ranked ?? []) {
      const r = byId.get(id);
      if (r && out.size < limit) out.set(r.recordId, r);
    }
    return [...out.values()].map(toCitation);
  },

  /** Test hook: forget the cache. */
  resetCache() {
    cache = null;
  },
};
