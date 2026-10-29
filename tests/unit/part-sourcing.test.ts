import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import { resetNexarTokenCache, nexarQuery } from '../../src/modules/sourcing/nexar.client.js';
import {
  bestUnitPrice,
  enrichBomWithSourcing,
  looksLikeMpn,
  mapNexarMatch,
  type NexarMatch,
} from '../../src/modules/sourcing/part-sourcing.service.js';
import type { BomItem } from '../../src/modules/sessions/pipeline/types.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/nexar-multimatch.json', import.meta.url), 'utf8')) as {
  data: { supMultiMatch: NexarMatch[] };
};
const stm32Match = fixture.data.supMultiMatch[0];

const bomItem = (partNumber: string, unitCostUsd = 1, qty = 1): BomItem => ({
  partNumber,
  manufacturer: 'Guess Corp',
  category: 'ic',
  description: 'part',
  qty,
  unitCostUsd,
  datasheetUrl: 'https://example.test/guess.pdf',
});

describe('mapNexarMatch', () => {
  it('maps a real Octopart match into verified sourcing data', () => {
    const info = mapNexarMatch('stm32f405rgt6', stm32Match, 'USD', new Date('2026-10-29T00:00:00Z'));
    expect(info.status).toBe('verified');
    expect(info.mpn).toBe('STM32F405RGT6');
    expect(info.manufacturer).toBe('STMicroelectronics');
    expect(info.package).toBe('LFQFP');
    expect(info.lifecycle).toBe('Production');
    expect(info.datasheetUrl).toMatch(/^http/);
    expect(info.totalAvail).toBeGreaterThan(0);
    expect(info.fetchedAt).toBe('2026-10-29T00:00:00.000Z');
    expect(info.offers[0].seller).toBe('Mouser');
    expect(info.offers[0].stock).toBeGreaterThan(0);
    expect(info.offers[0].prices[0]).toEqual(expect.objectContaining({ qty: 1, currency: 'USD' }));
    expect(info.offers.every((o) => o.prices.length > 0)).toBe(true);
  });

  it('does not accept a lookalike part as a match', () => {
    const info = mapNexarMatch('STM32F405RGT7', stm32Match, 'USD');
    expect(info.status).toBe('not_found');
    expect(info.offers).toEqual([]);
    expect(info.datasheetUrl).toBeUndefined();
  });

  it('reports a failed or missing match as unavailable, and drops offers in another currency', () => {
    expect(mapNexarMatch('STM32F405RGT6', undefined, 'USD').status).toBe('unavailable');
    expect(mapNexarMatch('STM32F405RGT6', { error: 'boom' }, 'USD').status).toBe('unavailable');
    expect(mapNexarMatch('STM32F405RGT6', stm32Match, 'EUR').offers).toEqual([]);
  });

  it('rejects non-http datasheet and buy links', () => {
    const match: NexarMatch = {
      parts: [
        {
          mpn: 'ABC1234',
          bestDatasheet: { url: 'javascript:alert(1)' },
          sellers: [
            {
              company: { name: 'Shop' },
              offers: [{ inventoryLevel: 5, clickUrl: 'javascript:alert(1)', prices: [{ quantity: 1, price: 2, currency: 'USD' }] }],
            },
          ],
        },
      ],
    };
    const info = mapNexarMatch('ABC1234', match, 'USD');
    expect(info.datasheetUrl).toBeUndefined();
    expect(info.offers[0].url).toBeNull();
  });
});

describe('bestUnitPrice and looksLikeMpn', () => {
  it('prefers in-stock offers for the unit price', () => {
    const info = mapNexarMatch('STM32F405RGT6', stm32Match, 'USD');
    const inStock = info.offers.filter((o) => o.stock > 0).map((o) => o.prices[0].price);
    expect(bestUnitPrice(info)).toBe(Math.min(...inStock));
    expect(bestUnitPrice({ ...info, offers: [] })).toBeUndefined();
  });

  it('only treats real-looking MPNs as lookup candidates', () => {
    expect(looksLikeMpn('STM32F405RGT6')).toBe(true);
    expect(looksLikeMpn('100nF 0402 capacitor')).toBe(false);
    expect(looksLikeMpn('Resistor')).toBe(false);
    expect(looksLikeMpn('R1')).toBe(false);
  });
});

describe('nexar token handling', () => {
  const original = { ...env };
  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(env, original);
  });

  it('reuses the cached token, and fetches a fresh one then retries once when Nexar answers 401', async () => {
    Object.assign(env, { NEXAR_ENABLED: true, NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: 'secret' });
    resetNexarTokenCache();
    let tokens = 0;
    let queries = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      if (String(url).includes('identity.nexar.com')) {
        tokens += 1;
        return new Response(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 86400 }), { status: 200 });
      }
      queries += 1;
      return queries === 2 ? new Response('', { status: 401 }) : new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as typeof fetch);

    await nexarQuery('q', {});
    await nexarQuery('q', {});
    expect(tokens).toBe(2);
    expect(queries).toBe(3);
  });
});

describe('enrichBomWithSourcing', () => {
  const original = { ...env };
  let fetchSpy: ReturnType<typeof jest.spyOn>;

  const nexarFetch = (matches: NexarMatch[]) =>
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      if (String(url).includes('identity.nexar.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { supMultiMatch: matches } }), { status: 200 });
    }) as typeof fetch);

  const mockDb = (opts: { used?: number; cached?: Array<{ mpnKey: string; payload: unknown; expiresAt: Date }> } = {}) => {
    jest.spyOn(prisma.partSourcing, 'aggregate').mockResolvedValue({ _sum: { lookupCount: opts.used ?? 0 } } as never);
    jest.spyOn(prisma.partSourcing, 'findMany').mockResolvedValue((opts.cached ?? []) as never);
    return jest.spyOn(prisma.partSourcing, 'upsert').mockResolvedValue({} as never);
  };

  beforeEach(() => {
    resetNexarTokenCache();
    Object.assign(env, { NEXAR_ENABLED: true, NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: 'secret', NEXAR_LOOKUP_BUDGET: 8, NEXAR_MAX_LOOKUPS_PER_VERSION: 3, NEXAR_CURRENCY: 'USD' });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    Object.assign(env, original);
  });

  it('is a no-op that labels estimates when sourcing is disabled', async () => {
    env.NEXAR_ENABLED = false;
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    const out = await enrichBomWithSourcing([bomItem('STM32F405RGT6', 9)]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out[0].priceSource).toBe('estimate');
    expect(out[0].sourcing).toBeUndefined();
  });

  it('replaces the guessed price, datasheet and manufacturer with verified data and caches it', async () => {
    const upsert = mockDb();
    fetchSpy = nexarFetch([{ ...stm32Match, reference: 'STM32F405RGT6' }]);
    const out = await enrichBomWithSourcing([bomItem('STM32F405RGT6', 99)], 'STM32F405RGT6');
    expect(out[0].sourcing?.status).toBe('verified');
    expect(out[0].priceSource).toBe('nexar');
    expect(out[0].unitCostUsd).not.toBe(99);
    expect(out[0].manufacturer).toBe('STMicroelectronics');
    expect(out[0].datasheetUrl).toMatch(/octopart/);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('spends the budget on the controller and priciest parts first, and stays within the per-version cap', async () => {
    mockDb();
    fetchSpy = nexarFetch(['MCU9999', 'PART2000', 'PART4000'].map((reference) => ({ reference, hits: 0, parts: [] })));
    const bom = [bomItem('PART1000', 1), bomItem('PART2000', 5), bomItem('PART3000', 3), bomItem('PART4000', 4), bomItem('MCU9999', 0.5)];
    const out = await enrichBomWithSourcing(bom, 'MCU9999');
    const graphqlCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('graphql'));
    const sent = JSON.parse(String((graphqlCall?.[1] as RequestInit).body)).variables.q.map((q: { mpn: string }) => q.mpn);
    expect(sent).toEqual(['MCU9999', 'PART2000', 'PART4000']);
    expect(out.find((i) => i.partNumber === 'PART1000')?.sourcing?.status).toBe('not_checked');
    expect(out.find((i) => i.partNumber === 'PART2000')?.sourcing?.status).toBe('not_found');
    expect(out.find((i) => i.partNumber === 'PART2000')?.priceSource).toBe('estimate');
  });

  it('makes no call once the lifetime budget is used up', async () => {
    mockDb({ used: 8 });
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    const out = await enrichBomWithSourcing([bomItem('PART1000')]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out[0].sourcing?.status).toBe('not_checked');
  });

  it('reuses unexpired cache rows without spending a lookup', async () => {
    const verified = mapNexarMatch('STM32F405RGT6', stm32Match, 'USD');
    const upsert = mockDb({ cached: [{ mpnKey: 'STM32F405RGT6', payload: verified, expiresAt: new Date(Date.now() + 3_600_000) }] });
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    const out = await enrichBomWithSourcing([bomItem('STM32F405RGT6')]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(out[0].sourcing?.status).toBe('verified');
  });

  it('never fails generation when Nexar errors, and does not cache the failure', async () => {
    const upsert = mockDb();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const out = await enrichBomWithSourcing([bomItem('PART1000', 2)]);
    expect(out[0].sourcing?.status).toBe('unavailable');
    expect(out[0].unitCostUsd).toBe(2);
    expect(out[0].priceSource).toBe('estimate');
    expect(upsert).not.toHaveBeenCalled();
  });
});
