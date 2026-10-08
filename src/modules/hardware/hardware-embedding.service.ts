import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { modelProviderService } from '../ai/model-provider.service.js';
import { OPENAI_EMBEDDING_DIMENSIONS, OPENAI_EMBEDDING_MODEL } from '../ai/providers/openai.provider.js';
import { HardwareRecord, hardwareRecordSchema } from './hardware.schema.js';

/**
 * Vector embeddings for hardware library records (plan D4). Each board is embedded from a short,
 * deterministic summary of its canonical facts — never from raw vendor text — so the same record
 * always yields the same vector and a re-embed only happens when a fact (or the model) changes.
 * Vector search narrows candidates; SQL and the allocator still decide the facts.
 */

export const EMBEDDING_MODEL_VERSION = `openai:${OPENAI_EMBEDDING_MODEL}@${OPENAI_EMBEDDING_DIMENSIONS}`;

const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

export function buildEmbeddingSummary(record: HardwareRecord): string {
  const { identity, electrical, interfaces, compatibility_hints } = record;
  const ifaces = interfaces.interfaces
    .map((i) => {
      const role = typeof (i.details as Record<string, unknown>)['role'] === 'string' ? ` ${(i.details as Record<string, unknown>)['role']}` : '';
      return `${i.type}${role}${i.addresses.length > 0 ? ` (${i.addresses.join(', ')})` : ''}`;
    })
    .join(', ');
  const ecosystem = new Set(compatibility_hints.ecosystem_tags);
  if (record.connectors.some((c) => /stemma|qwiic/i.test(c.connector_type)) && ![...ecosystem].some((t) => /stemma|qwiic/i.test(t))) {
    ecosystem.add('STEMMA QT / Qwiic');
  }
  const supply =
    electrical.supply_voltage_min_v != null || electrical.supply_voltage_max_v != null
      ? `${electrical.supply_voltage_min_v ?? '?'}–${electrical.supply_voltage_max_v ?? '?'} V`
      : 'unknown';
  return [
    `${identity.product_name} — ${identity.vendor} (${identity.group}).`,
    `Role: ${identity.prototype_role ?? 'unspecified'}. Categories: ${identity.functional_categories.join(', ') || 'none'}.`,
    identity.main_silicon ? `Main silicon: ${identity.main_silicon}.${identity.secondary_ics.length > 0 ? ` Key ICs: ${identity.secondary_ics.join('; ')}.` : ''}` : null,
    `Interfaces: ${ifaces || 'none listed'}.`,
    `Logic: ${electrical.logic_level_summary ?? 'unknown'}. Supply: ${supply}${electrical.power_source_types.length > 0 ? ` via ${electrical.power_source_types.join(', ')}` : ''}. Host: ${interfaces.host_requirement}${interfaces.required_host_interfaces.length > 0 ? ` (${interfaces.required_host_interfaces.join(', ')})` : ''}.`,
    ecosystem.size > 0 ? `Ecosystem: ${[...ecosystem].join(', ')}.` : null,
    compatibility_hints.known_incompatible_notes.length > 0 ? `Notes: ${compatibility_hints.known_incompatible_notes.join(' ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export type EmbedOutcome = 'embedded' | 'unchanged' | 'not_configured' | 'failed' | 'not_found';

const toVector = (values: number[]) => `[${values.join(',')}]`;

export const hardwareEmbeddingService = {
  get configured(): boolean {
    return modelProviderService.embeddingsConfigured;
  },

  /** Embeds one record if its summary (or the model) changed since the last embedding. */
  async embedEntity(hardwareEntityId: string, options: { force?: boolean } = {}): Promise<{ outcome: EmbedOutcome; error?: string }> {
    const row = await prisma.hardwareEntity.findUnique({
      where: { hardwareEntityId },
      select: { metadataJson: true, embeddingInputHash: true, embeddedAt: true },
    });
    if (!row) return { outcome: 'not_found' };
    const parsed = hardwareRecordSchema.safeParse(row.metadataJson);
    if (!parsed.success) return { outcome: 'failed', error: 'stored record no longer matches the v3.3 schema' };

    const summary = buildEmbeddingSummary(parsed.data);
    const inputHash = sha256(`${EMBEDDING_MODEL_VERSION}\n${summary}`);
    if (!options.force && row.embeddedAt && row.embeddingInputHash === inputHash) return { outcome: 'unchanged' };
    if (!this.configured) return { outcome: 'not_configured' };

    try {
      const result = await modelProviderService.embedBatch([summary]);
      const vector = result.embeddings[0];
      if (!vector || vector.length !== OPENAI_EMBEDDING_DIMENSIONS) throw new Error(`expected ${OPENAI_EMBEDDING_DIMENSIONS} dimensions, got ${vector?.length ?? 0}`);
      await prisma.$executeRaw`
        UPDATE "hardware_entities"
        SET "embedding" = ${toVector(vector)}::vector,
            "embedding_source_summary" = ${summary},
            "embedding_model_version" = ${EMBEDDING_MODEL_VERSION},
            "embedding_input_hash" = ${inputHash},
            "embedded_at" = NOW()
        WHERE "hardware_entity_id" = ${hardwareEntityId}`;
      return { outcome: 'embedded' };
    } catch (err) {
      logger.warn({ err, hardwareEntityId }, 'Hardware embedding failed');
      return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Embeds every record without a vector (or with a stale model). Used by the admin backfill action. */
  async embedMissing(limit = 200): Promise<Record<EmbedOutcome, number>> {
    const rows = await prisma.hardwareEntity.findMany({
      where: { OR: [{ embeddedAt: null }, { embeddingModelVersion: { not: EMBEDDING_MODEL_VERSION } }] },
      select: { hardwareEntityId: true },
      orderBy: { hardwareEntityId: 'asc' },
      take: limit,
    });
    const counts: Record<EmbedOutcome, number> = { embedded: 0, unchanged: 0, not_configured: 0, failed: 0, not_found: 0 };
    for (const row of rows) counts[(await this.embedEntity(row.hardwareEntityId)).outcome] += 1;
    return counts;
  },

  /**
   * Ranks the given boards by cosine similarity to the query. Boards without a vector are left
   * out of the ranking (the caller keeps them by other means). Returns ids, nearest first.
   */
  async rank(query: string, candidateIds: string[], limit: number): Promise<string[] | null> {
    if (!this.configured || candidateIds.length === 0 || !query.trim()) return null;
    try {
      const result = await modelProviderService.embedBatch([query.slice(0, 4000)]);
      const vector = result.embeddings[0];
      if (!vector || vector.length !== OPENAI_EMBEDDING_DIMENSIONS) return null;
      const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "hardware_entity_id" AS id
        FROM "hardware_entities"
        WHERE "embedding" IS NOT NULL AND "hardware_entity_id" IN (${Prisma.join(candidateIds)})
        ORDER BY "embedding" <=> ${toVector(vector)}::vector
        LIMIT ${limit}`);
      return rows.map((r) => r.id);
    } catch (err) {
      logger.warn({ err }, 'Hardware vector ranking failed; falling back to keyword ranking');
      return null;
    }
  },
};
