import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { logger } from '../../../config/logger.js';
import { modelProviderService } from '../../ai/model-provider.service.js';
import { aiRouterService } from '../../ai/ai-router.service.js';
import { OPENAI_EMBEDDING_MODEL } from '../../ai/providers/openai.provider.js';

export interface GroundingContext {
  datasheetSnippets: Array<{
    partNumber?: string;
    text: string;
    source?: string;
    score?: number;
  }>;
  designGuidelines: string[];
}

/** Cosine distance above which a chunk is considered irrelevant and not injected into the prompt. */
const MAX_DISTANCE = 0.55;
const TOP_K_KNOWLEDGE = 3;
const TOP_K_DATASHEETS = 4;
const TOP_K_COMPONENTS = 4;

const BASE_GUIDELINES = [
  'Always provide separate power decoupling capacitors for high-frequency digital ICs.',
  'Ensure I2C buses have external pull-up resistors (typically 2.2kΩ - 4.7kΩ to 3.3V).',
  'Include ESD protection on all external exposed USB/connector lines.',
  'Ensure 3.3V buck regulator provides sufficient peak current headroom (minimum 500mA - 1A for Wi-Fi/BLE bursts).',
];

interface VectorRow {
  id: string;
  chunk_text: string;
  source: string;
  part_number: string | null;
  distance: number;
}

const SPECS_PROMPT_BUDGET = 4200;

/**
 * Stored specs now carry bulky ingestion data (figure captions, full pinout, register map, timing
 * tables, provenance). Slicing the raw JSON to a fixed length cut off whatever key came last — and
 * `figureCaptions` is written BEFORE the ratings, so a blind slice silently dropped
 * recommendedOperating/absoluteMaxRatings, the exact fields the design prompt (rule 9) depends on.
 * This builds the prompt view in priority order instead: ratings first, bulk data summarized, and
 * captions/provenance omitted.
 */
export function compactSpecsForPrompt(specs: unknown): string {
  if (!specs || typeof specs !== 'object') return '{}';
  const s = specs as Record<string, unknown>;
  const parts: Array<[string, unknown]> = [];
  const push = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) parts.push([key, value]);
  };

  for (const k of ['core', 'clockFrequency', 'sram', 'flash']) push(k, s[k]);
  push('recommendedOperating', s.recommendedOperating);
  push('absoluteMaxRatings', s.absoluteMaxRatings);
  // Per-mode current (active/sleep/...) is what a power budget needs; units are already canonical (mA).
  if (Array.isArray(s.powerModes)) {
    push(
      'powerModes',
      (s.powerModes as Array<Record<string, unknown>>)
        .slice(0, 12)
        .map((r) => {
          // mode + parameter + condition, so "active TX @21 dBm" and "active RX" stay distinguishable
          const label = [r.mode, r.parameter !== r.mode ? r.parameter : undefined].filter(Boolean).join(' ');
          const cond = typeof r.conditions === 'string' && r.conditions ? ` (${r.conditions.slice(0, 48)})` : '';
          return `${label}${cond}: typ ${r.typ ?? '-'} max ${r.max ?? '-'} ${r.unit ?? ''}${r.supplyVoltageV ? ` @${r.supplyVoltageV}V` : ''}`;
        })
    );
  }
  if (Array.isArray(s.interfaces)) {
    push(
      'interfaces',
      (s.interfaces as Array<Record<string, unknown>>)
        .slice(0, 10)
        .map((i) => [i.type, i.role, i.voltageLevel, i.maxRate, i.pullUpRequirement].filter(Boolean).join(' | '))
    );
  }
  push('packages', s.packages);
  push('hasExposedPad', s.hasExposedPad);
  push('strappingPins', s.strappingPins);
  push('peripherals', s.peripherals);
  push('decouplingRecommendations', s.decouplingRecommendations);

  if (Array.isArray(s.pins)) {
    const pins = (s.pins as Array<Record<string, unknown>>)
      .map((p) => {
        const alt = Array.isArray(p.alternateFunctions) && p.alternateFunctions.length ? `/${(p.alternateFunctions as string[]).join(',')}` : '';
        return `${p.number}:${p.name}(${p.type ?? '?'})${alt}`;
      })
      .join('; ');
    push('pins', pins);
  }
  if (Array.isArray(s.dcCharacteristics)) {
    push(
      'dcCharacteristics',
      (s.dcCharacteristics as Array<Record<string, unknown>>)
        .slice(0, 10)
        .map((r) => `${r.symbol ?? r.parameter}: ${r.min ?? ''}..${r.typ ?? ''}..${r.max ?? ''} ${r.unit ?? ''}`)
    );
  }
  if (Array.isArray(s.cautions)) push('cautions', (s.cautions as Array<{ text: string }>).slice(0, 5).map((c) => c.text));
  if (Array.isArray(s.features)) push('features', (s.features as string[]).slice(0, 8));
  if (Array.isArray(s.timing)) {
    push(
      'timing',
      (s.timing as Array<Record<string, unknown>>).map((t) => ({ protocol: t.protocol, clockFrequency: t.clockFrequency }))
    );
  }
  if (Array.isArray(s.registers)) {
    push('registers', (s.registers as Array<Record<string, unknown>>).map((r) => `${r.address}:${r.name}`).join('; '));
  }
  const ordering = s.orderingInfo as Record<string, unknown> | undefined;
  if (ordering?.baseDevicePartNumber) push('basePart', ordering.baseDevicePartNumber);
  const rev = s._revision as Record<string, unknown> | undefined;
  if (rev?.label) push('datasheetRevision', rev.label);

  // Ordered by priority: emit whole entries until the budget is spent, never a truncated one.
  const out: string[] = [];
  let used = 2;
  for (const [key, value] of parts) {
    const entry = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    if (used + entry.length + 1 > SPECS_PROMPT_BUDGET) continue;
    out.push(entry);
    used += entry.length + 1;
  }
  return `{${out.join(',')}}`;
}

/**
 * RAG Grounder: retrieves component specs, ingested datasheet chunks and curated knowledge
 * from pgvector to ground Sol-tier synthesis. Degrades gracefully to base guidelines.
 */
export async function getGroundingContext(
  keywords: string[],
  semanticQuery?: string,
  sessionId?: string
): Promise<GroundingContext> {
  const snippets: GroundingContext['datasheetSnippets'] = [];
  const semanticMatchedParts: string[] = [];

  // 1. Semantic search across knowledge_chunks AND datasheet_chunks (both populated by ingestion)
  if (semanticQuery && semanticQuery.trim().length > 0 && modelProviderService.embeddingsConfigured) {
    try {
      const embed = await modelProviderService.embedBatch([semanticQuery]);
      const embedding = embed.embeddings[0];

      void aiRouterService.recordEmbeddingUsage({
        sessionId,
        model: OPENAI_EMBEDDING_MODEL,
        inputs: 1,
        totalTokens: embed.totalTokens,
        latencyMs: embed.latencyMs,
        context: 'rag-grounding',
      });

      if (embedding && embedding.length === 1536) {
        const vectorStr = `[${embedding.join(',')}]`;

        const rows = await prisma.$queryRaw<VectorRow[]>(Prisma.sql`
          (
            SELECT kc.id, kc.chunk_text, kc.source_type AS source, NULL::varchar AS part_number,
                   (kc.embedding <=> ${vectorStr}::vector) AS distance
            FROM knowledge_chunks kc
            WHERE kc.embedding IS NOT NULL
            ORDER BY distance ASC
            LIMIT ${TOP_K_KNOWLEDGE}
          )
          UNION ALL
          (
            SELECT dc.id, dc.chunk_text, 'datasheet' AS source, c.part_number,
                   (dc.embedding <=> ${vectorStr}::vector) AS distance
            FROM datasheet_chunks dc
            LEFT JOIN components c ON c.id = dc.component_id
            WHERE dc.embedding IS NOT NULL
            ORDER BY distance ASC
            LIMIT ${TOP_K_DATASHEETS}
          )
          ORDER BY distance ASC
        `);

        const semanticPartNumbers = new Set<string>();
        for (const row of rows) {
          if (row.distance > MAX_DISTANCE || !row.chunk_text) continue;
          snippets.push({
            partNumber: row.part_number ?? undefined,
            text: row.chunk_text,
            source: row.source,
            score: Number((1 - row.distance).toFixed(4)),
          });
          if (row.part_number) semanticPartNumbers.add(row.part_number);
        }
        semanticMatchedParts.push(...semanticPartNumbers);
      }
    } catch (err: unknown) {
      logger.warn({ err, sessionId }, 'pgvector semantic search failed, continuing with keyword grounding only');
    }
  }

  // 2. Structured specs for parts already found above via semantic prose search, PLUS a keyword
  // match against the catalog (category / manufacturer / part number). These are two different
  // retrieval paths and neither one subsumes the other: a part's datasheet *prose* can match the
  // semantic query (step 1) without the structured intent's generic keywords ("data acquisition
  // module") ever matching that part's category/manufacturer/number literally, which meant the
  // structured specs — including the absoluteMaxRatings/recommendedOperating split the design
  // prompt is explicitly told to use (design-graph-builder.ts rule 9) — were silently dropped
  // for exactly the parts Sol was actually about to reference by name by name in its own prose.
  const terms = keywords.map((k) => k.trim()).filter((k) => k.length >= 2).slice(0, 12);
  const specsPartNumbers = new Set<string>([...semanticMatchedParts, ...terms]);
  try {
    const components = await prisma.component.findMany({
      where: {
        OR: [
          ...(semanticMatchedParts.length > 0 ? [{ partNumber: { in: semanticMatchedParts } }] : []),
          ...terms.flatMap((k) => [
            { partNumber: { contains: k, mode: 'insensitive' as const } },
            { category: { contains: k, mode: 'insensitive' as const } },
            { manufacturer: { contains: k, mode: 'insensitive' as const } },
          ]),
        ],
      },
      take: TOP_K_COMPONENTS + semanticMatchedParts.length,
      orderBy: { lastRefreshed: 'desc' },
    });

    for (const comp of components) {
      if (!comp.specs) continue;
      snippets.push({
        partNumber: comp.partNumber ?? undefined,
        text: `Component: ${comp.partNumber} (${comp.manufacturer}) - Specs: ${compactSpecsForPrompt(comp.specs)}`,
        source: 'components_db',
      });
    }
  } catch (err: unknown) {
    logger.warn({ err, sessionId, specsPartNumbers: [...specsPartNumbers] }, 'Component specs grounding failed, proceeding with base guidelines');
  }

  return { datasheetSnippets: snippets, designGuidelines: [...BASE_GUIDELINES] };
}
