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

        for (const row of rows) {
          if (row.distance > MAX_DISTANCE || !row.chunk_text) continue;
          snippets.push({
            partNumber: row.part_number ?? undefined,
            text: row.chunk_text,
            source: row.source,
            score: Number((1 - row.distance).toFixed(4)),
          });
        }
      }
    } catch (err: unknown) {
      logger.warn({ err, sessionId }, 'pgvector semantic search failed, continuing with keyword grounding only');
    }
  }

  // 2. Keyword match against the component catalog (category / manufacturer / part number / spec text)
  const terms = keywords.map((k) => k.trim()).filter((k) => k.length >= 2).slice(0, 12);
  if (terms.length > 0) {
    try {
      const components = await prisma.component.findMany({
        where: {
          OR: terms.flatMap((k) => [
            { partNumber: { contains: k, mode: 'insensitive' as const } },
            { category: { contains: k, mode: 'insensitive' as const } },
            { manufacturer: { contains: k, mode: 'insensitive' as const } },
          ]),
        },
        take: TOP_K_COMPONENTS,
        orderBy: { lastRefreshed: 'desc' },
      });

      for (const comp of components) {
        if (!comp.specs) continue;
        snippets.push({
          partNumber: comp.partNumber ?? undefined,
          text: `Component: ${comp.partNumber} (${comp.manufacturer}) - Specs: ${JSON.stringify(comp.specs).slice(0, 1200)}`,
          source: 'components_db',
        });
      }
    } catch (err: unknown) {
      logger.warn({ err, sessionId }, 'Component keyword grounding failed, proceeding with base guidelines');
    }
  }

  return { datasheetSnippets: snippets, designGuidelines: [...BASE_GUIDELINES] };
}
