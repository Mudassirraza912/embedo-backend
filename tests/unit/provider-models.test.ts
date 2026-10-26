import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';
import { selectability, syncProviderModels } from '../../src/modules/ai/provider-models.service.js';

describe('selectability', () => {
  it('offers OpenAI chat models and every Claude model', () => {
    for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'o3', 'o4-mini', 'chatgpt-4o-latest', 'gpt-4o-2024-08-06']) {
      expect([id, selectability('openai', id).selectable]).toEqual([id, true]);
    }
    for (const id of ['claude-opus-4-1', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-haiku-20240307']) {
      expect(selectability('anthropic', id).selectable).toBe(true);
    }
  });

  it('keeps out OpenAI models the chat path cannot call, with a reason', () => {
    const cases: Array<[string, RegExp]> = [
      ['text-embedding-3-small', /Embedding/],
      ['gpt-4o-mini-tts', /Audio/],
      ['gpt-4o-realtime-preview', /Audio or realtime/],
      ['gpt-4o-transcribe', /Audio/],
      ['whisper-1', /Audio/],
      ['tts-1', /Audio/],
      ['dall-e-3', /Image/],
      ['gpt-image-1', /Image/],
      ['omni-moderation-latest', /Moderation/],
      ['gpt-4o-search-preview', /Search/],
      ['o1-pro', /Responses API only/],
      ['o3-pro-2025-06-10', /Responses API only/],
      ['gpt-5-pro', /Responses API only/],
      ['codex-mini-latest', /Responses API only/],
      ['o3-deep-research', /Responses API only/],
      ['computer-use-preview', /Responses API only/],
      ['gpt-3.5-turbo-instruct', /Legacy/],
      ['davinci-002', /Legacy/],
      ['ft:gpt-4o-mini:org::abc', /Fine-tuned/],
    ];
    for (const [id, reason] of cases) {
      const r = selectability('openai', id);
      expect([id, r.selectable]).toEqual([id, false]);
      expect(r.reason).toMatch(reason);
    }
  });
});

describe('syncProviderModels', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockDb(known: string[]) {
    jest.spyOn(prisma.aiProviderModel, 'findMany').mockResolvedValue(known.map((modelId) => ({ modelId })) as never);
    const upsert = jest.fn(async (_args: unknown) => ({}));
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 0 }));
    jest.spyOn(prisma, '$transaction').mockImplementation((async (fn: (tx: unknown) => unknown) => fn({ aiProviderModel: { upsert, updateMany } })) as never);
    return { upsert, updateMany };
  }

  it('stores every listed model, marks the chat ones selectable, reports new ones and retires missing ones', async () => {
    jest.spyOn(modelProviderService, 'isConfigured').mockImplementation((p) => p === 'openai');
    jest.spyOn(modelProviderService, 'listModels').mockResolvedValue([
      { id: 'gpt-4o', displayName: null, createdAt: new Date('2024-05-13T00:00:00Z') },
      { id: 'gpt-5-mini', displayName: null, createdAt: new Date('2025-08-07T00:00:00Z') },
      { id: 'text-embedding-3-small', displayName: null, createdAt: null },
    ]);
    const { upsert, updateMany } = mockDb(['gpt-4o', 'gpt-4-old']);
    const [openai, anthropic] = await syncProviderModels(new Date('2026-10-26T18:00:00Z'));
    expect(openai).toMatchObject({ provider: 'openai', status: 'ok', listed: 3, selectable: 2, newModels: ['gpt-5-mini', 'text-embedding-3-small'] });
    expect(anthropic).toMatchObject({ provider: 'anthropic', status: 'skipped' });
    const rows = upsert.mock.calls.map((c) => (c[0] as { create: { modelId: string; selectable: boolean; excludedReason: string | null } }).create);
    expect(rows.find((r) => r.modelId === 'gpt-5-mini')).toMatchObject({ selectable: true, excludedReason: null });
    expect(rows.find((r) => r.modelId === 'text-embedding-3-small')).toMatchObject({ selectable: false, excludedReason: 'Embedding model' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { provider: 'openai', modelId: { notIn: ['gpt-4o', 'gpt-5-mini', 'text-embedding-3-small'] }, available: true },
      data: { available: false },
    });
  });

  it('keeps the last list when the provider call fails or returns nothing', async () => {
    jest.spyOn(modelProviderService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(modelProviderService, 'listModels').mockImplementation(async (p) => {
      if (p === 'openai') throw new Error('401 invalid key');
      return [];
    });
    const tx = jest.spyOn(prisma, '$transaction');
    const res = await syncProviderModels();
    expect(res.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(tx).not.toHaveBeenCalled();
  });
});
