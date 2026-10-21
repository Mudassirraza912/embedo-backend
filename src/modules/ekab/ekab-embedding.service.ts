import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { modelProviderService } from '../ai/model-provider.service.js';
import { OPENAI_EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from '../ai/providers/openai.provider.js';
import { REASONING_TRUST_STATES } from './ekab.constants.js';

/**
 * Retrieval vectors for EKAB records (contract §14.2). The vector is a derived index: it is built
 * from the record's statement + applicability + tags, keeps the record row id (and so its
 * record_id/revision), and a re-embed happens only when that text or the model changes. Only
 * records that may reach reasoning (not quarantined; VERIFIED / CONDITIONAL) are embedded.
 */

export const EKAB_EMBEDDING_MODEL_VERSION = `openai:${OPENAI_EMBEDDING_MODEL}@${OPENAI_EMBEDDING_DIMENSIONS}`;
const BATCH = 100;

const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const toVector = (values: number[]) => `[${values.join(',')}]`;
const textOf = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export interface EmbeddableRecord {
  id: string;
  title: string | null;
  topic: string | null;
  normalizedStatement: string | null;
  applicability: unknown;
  tags: string[];
  embeddingInputHash: string | null;
  embeddingModelVersion: string | null;
}

export function recordEmbeddingText(r: Pick<EmbeddableRecord, 'title' | 'topic' | 'normalizedStatement' | 'applicability' | 'tags'>): string {
  const a = (r.applicability ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).map(textOf).join('; ') : '');
  return [
    r.title ? `${r.title}.` : null,
    r.topic ? `Topic: ${r.topic}.` : null,
    r.normalizedStatement,
    list('applies_to') ? `Applies to: ${list('applies_to')}.` : null,
    list('conditions') ? `Conditions: ${list('conditions')}.` : null,
    list('excludes') ? `Excludes: ${list('excludes')}.` : null,
    r.tags.length > 0 ? `Tags: ${r.tags.join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

export const ekabEmbeddingService = {
  get configured(): boolean {
    return modelProviderService.embeddingsConfigured;
  },

  /** Embeds the eligible records of one release (or every release when omitted) that need it. */
  async embedPending(options: { releasePk?: string; limit?: number } = {}): Promise<{ embedded: number; unchanged: number; failed: number; skipped: boolean }> {
    if (!this.configured) return { embedded: 0, unchanged: 0, failed: 0, skipped: true };
    const rows: EmbeddableRecord[] = await prisma.ekabRecord.findMany({
      where: {
        ...(options.releasePk ? { releasePk: options.releasePk } : { release: { ingestionState: { in: ['STAGED', 'QUARANTINED', 'PROMOTED'] } } }),
        quarantined: false,
        trustState: { in: [...REASONING_TRUST_STATES] },
        lifecycleStatus: 'ACTIVE',
      },
      select: { id: true, title: true, topic: true, normalizedStatement: true, applicability: true, tags: true, embeddingInputHash: true, embeddingModelVersion: true },
      orderBy: { createdAt: 'asc' },
      take: options.limit ?? 5000,
    });

    let unchanged = 0;
    const todo: Array<{ id: string; text: string; hash: string }> = [];
    for (const r of rows) {
      const text = recordEmbeddingText(r);
      const hash = sha256(`${EKAB_EMBEDDING_MODEL_VERSION}\n${text}`);
      if (r.embeddingInputHash === hash && r.embeddingModelVersion === EKAB_EMBEDDING_MODEL_VERSION) unchanged += 1;
      else todo.push({ id: r.id, text, hash });
    }

    let embedded = 0;
    let failed = 0;
    // Sequential batches: one embeddings request in flight at a time.
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        const result = await modelProviderService.embedBatch(batch.map((b) => b.text));
        for (let j = 0; j < batch.length; j++) {
          const vector = result.embeddings[j];
          if (!vector || vector.length !== OPENAI_EMBEDDING_DIMENSIONS) {
            failed += 1;
            continue;
          }
          await prisma.$executeRaw`
            UPDATE "ekab_records"
            SET "embedding" = ${toVector(vector)}::vector,
                "embedding_model_version" = ${EKAB_EMBEDDING_MODEL_VERSION},
                "embedding_input_hash" = ${batch[j]!.hash},
                "embedded_at" = NOW()
            WHERE "id" = ${batch[j]!.id}::uuid`;
          embedded += 1;
        }
      } catch (err) {
        failed += batch.length;
        logger.warn({ err, releasePk: options.releasePk }, 'EKAB record embedding batch failed');
      }
    }
    return { embedded, unchanged, failed, skipped: false };
  },

  /**
   * Nearest records to a query among those that may reach reasoning: promoted release, ACTIVE,
   * not quarantined, VERIFIED/CONDITIONAL (§18 step 8). Null when vectors are unavailable.
   */
  async rankEligible(query: string, limit: number, maxDistance = 0.55): Promise<string[] | null> {
    if (!this.configured || !query.trim()) return null;
    try {
      const result = await modelProviderService.embedBatch([query.slice(0, 4000)]);
      const vector = result.embeddings[0];
      if (!vector || vector.length !== OPENAI_EMBEDDING_DIMENSIONS) return null;
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r."id"::text AS id
        FROM "ekab_records" r
        JOIN "ekab_releases" rel ON rel."id" = r."release_pk"
        WHERE r."embedding" IS NOT NULL
          AND rel."ingestion_state" = 'PROMOTED'
          AND r."lifecycle_status" = 'ACTIVE'
          AND r."quarantined" = false
          AND r."trust_state" IN (${Prisma.join([...REASONING_TRUST_STATES])})
          -- Nearest is not the same as relevant: past this cosine distance a record is not about the question.
          AND (r."embedding" <=> ${toVector(vector)}::vector) < ${maxDistance}
        ORDER BY r."embedding" <=> ${toVector(vector)}::vector
        LIMIT ${limit}`);
      return rows.map((r) => r.id);
    } catch (err) {
      logger.warn({ err }, 'EKAB vector ranking failed; falling back to keyword ranking');
      return null;
    }
  },
};
