import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { modelProviderService } from './model-provider.service.js';
import type { ProviderModel } from './providers/types.js';

/**
 * Keeps `ai_provider_models` in step with what the OpenAI and Anthropic keys can use, so the admin
 * portal (AI Operations → Difficulty routing) offers every current model, including new ones,
 * without a code change. The worker runs it at start and every PROVIDER_MODEL_SYNC_HOURS.
 *
 * Only models the product can call through its normal path are `selectable`: Chat Completions for
 * OpenAI (with max_completion_tokens and the temperature fallback in openai.provider.ts) and the
 * Messages API for Anthropic. Everything else is stored with the reason it cannot be chosen.
 * A model missing from a successful listing is marked unavailable, never deleted.
 */

export const PROVIDER_MODEL_SYNC_HOURS = 6;
export const SYNCED_PROVIDERS = ['openai', 'anthropic'] as const;
export type SyncedProvider = (typeof SYNCED_PROVIDERS)[number];

const OPENAI_CHAT_FAMILY = /^(gpt-|chatgpt-|o\d)/i;
const OPENAI_EXCLUDED: Array<{ re: RegExp; reason: string }> = [
  // First: "deep-research" also contains "search".
  { re: /computer-use|codex|deep-research|(^|-)pro($|-)/i, reason: 'Responses API only (the product uses Chat Completions)' },
  { re: /embedding/i, reason: 'Embedding model' },
  { re: /tts|whisper|transcribe|audio|realtime/i, reason: 'Audio or realtime model' },
  { re: /dall-e|image|sora/i, reason: 'Image or video model' },
  { re: /moderation/i, reason: 'Moderation model' },
  { re: /search/i, reason: 'Search model (web search tool only)' },
  { re: /instruct|babbage|davinci/i, reason: 'Legacy completions model' },
];

/** Whether the product can call this model, and why not when it cannot. */
export function selectability(provider: SyncedProvider, id: string): { selectable: boolean; reason: string | null } {
  if (provider === 'anthropic') return { selectable: true, reason: null };
  if (id.startsWith('ft:')) return { selectable: false, reason: 'Fine-tuned model' };
  for (const rule of OPENAI_EXCLUDED) if (rule.re.test(id)) return { selectable: false, reason: rule.reason };
  if (!OPENAI_CHAT_FAMILY.test(id)) return { selectable: false, reason: 'Not a chat model' };
  return { selectable: true, reason: null };
}

const MODEL_ID = /^[A-Za-z0-9._:@-]{1,100}$/;

async function listFor(provider: SyncedProvider): Promise<ProviderModel[]> {
  return modelProviderService.listModels(provider);
}

export interface SyncSummary {
  provider: SyncedProvider;
  status: 'ok' | 'skipped' | 'failed';
  listed?: number;
  selectable?: number;
  newModels?: string[];
  reason?: string;
}

export async function syncProviderModels(now = new Date()): Promise<SyncSummary[]> {
  const out: SyncSummary[] = [];
  for (const provider of SYNCED_PROVIDERS) {
    if (!modelProviderService.isConfigured(provider)) {
      out.push({ provider, status: 'skipped', reason: 'API key not configured' });
      continue;
    }
    let models: ProviderModel[];
    try {
      models = (await listFor(provider)).filter((m) => MODEL_ID.test(m.id));
    } catch (err: unknown) {
      // Keep the last known list: a failed listing never marks models unavailable.
      out.push({ provider, status: 'failed', reason: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      continue;
    }
    if (models.length === 0) {
      out.push({ provider, status: 'failed', reason: 'The provider returned no models; keeping the last list.' });
      continue;
    }
    const known = new Set((await prisma.aiProviderModel.findMany({ where: { provider }, select: { modelId: true } })).map((m) => m.modelId));
    await prisma.$transaction(async (tx) => {
      for (const m of models) {
        const { selectable, reason } = selectability(provider, m.id);
        await tx.aiProviderModel.upsert({
          where: { provider_modelId: { provider, modelId: m.id } },
          create: { provider, modelId: m.id, displayName: m.displayName, providerCreatedAt: m.createdAt, selectable, excludedReason: reason, available: true, firstSeenAt: now, lastSeenAt: now },
          update: { displayName: m.displayName, providerCreatedAt: m.createdAt, selectable, excludedReason: reason, available: true, lastSeenAt: now },
        });
      }
      await tx.aiProviderModel.updateMany({
        where: { provider, modelId: { notIn: models.map((m) => m.id) }, available: true },
        data: { available: false },
      });
    });
    const newModels = models.map((m) => m.id).filter((id) => !known.has(id));
    out.push({ provider, status: 'ok', listed: models.length, selectable: models.filter((m) => selectability(provider, m.id).selectable).length, newModels });
  }
  logger.info({ sync: out.map((s) => ({ ...s, newModels: s.newModels?.slice(0, 20) })) }, 'Provider model lists synced');
  return out;
}

/** Runs the sync at start (after a short delay) and on an interval. Never throws. */
export function scheduleProviderModelSync(): () => void {
  const run = () =>
    void syncProviderModels().catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Provider model sync failed'));
  const first = setTimeout(run, 30_000);
  const every = setInterval(run, PROVIDER_MODEL_SYNC_HOURS * 3_600_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
