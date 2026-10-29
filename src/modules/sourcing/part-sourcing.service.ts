import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import type { BomItem, PartSourcingInfo, SourcingOffer } from '../sessions/pipeline/types.js';
import { NexarError, nexarConfigured, nexarQuery } from './nexar.client.js';

const MAX_OFFERS = 5;
const MAX_PRICE_BREAKS = 5;

const MULTI_MATCH_QUERY = `query PartSourcing($q: [SupPartMatchQuery!]!, $currency: String!) {
  supMultiMatch(queries: $q, currency: $currency) {
    reference
    hits
    error
    parts {
      mpn
      manufacturer { name }
      shortDescription
      octopartUrl
      totalAvail
      medianPrice1000 { price currency }
      bestDatasheet { url }
      specs { attribute { shortname } displayValue }
      sellers(authorizedOnly: true) {
        company { name }
        offers { sku inventoryLevel moq packaging clickUrl updated prices { quantity price currency } }
      }
    }
  }
}`;

interface NexarPart {
  mpn?: string | null;
  manufacturer?: { name?: string | null } | null;
  shortDescription?: string | null;
  octopartUrl?: string | null;
  totalAvail?: number | null;
  medianPrice1000?: { price?: number | null; currency?: string | null } | null;
  bestDatasheet?: { url?: string | null } | null;
  specs?: Array<{ attribute?: { shortname?: string | null } | null; displayValue?: string | null }> | null;
  sellers?: Array<{
    company?: { name?: string | null } | null;
    offers?: Array<{
      sku?: string | null;
      inventoryLevel?: number | null;
      moq?: number | null;
      packaging?: string | null;
      clickUrl?: string | null;
      updated?: string | null;
      prices?: Array<{ quantity?: number | null; price?: number | null; currency?: string | null }> | null;
    }> | null;
  }> | null;
}

export interface NexarMatch {
  reference?: string | null;
  hits?: number | null;
  error?: string | null;
  parts?: NexarPart[] | null;
}

export const mpnKey = (mpn: string): string => mpn.replace(/\s+/g, '').toUpperCase();

/** A line is only worth a (scarce) lookup when it looks like a real manufacturer part number. */
export const looksLikeMpn = (mpn: string): boolean => {
  const trimmed = mpn.trim();
  return trimmed.length >= 4 && trimmed.length <= 64 && /\d/.test(trimmed) && !/\s/.test(trimmed);
};

const httpsUrl = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const spec = (part: NexarPart, ...names: string[]): string | undefined => {
  for (const name of names) {
    const hit = part.specs?.find((s) => s.attribute?.shortname === name)?.displayValue;
    if (hit) return hit;
  }
  return undefined;
};

const mapOffers = (part: NexarPart, currency: string): SourcingOffer[] => {
  const offers: SourcingOffer[] = [];
  for (const seller of part.sellers ?? []) {
    const name = seller.company?.name;
    if (!name) continue;
    for (const offer of seller.offers ?? []) {
      const prices = (offer.prices ?? [])
        .filter(
          (p): p is { quantity: number; price: number; currency: string } =>
            typeof p.quantity === 'number' && typeof p.price === 'number' && p.currency === currency
        )
        .sort((a, b) => a.quantity - b.quantity)
        .slice(0, MAX_PRICE_BREAKS)
        .map((p) => ({ qty: p.quantity, price: p.price, currency: p.currency }));
      if (prices.length === 0) continue;
      offers.push({
        seller: name,
        sku: offer.sku ?? null,
        stock: Math.max(0, offer.inventoryLevel ?? 0),
        moq: offer.moq ?? null,
        packaging: offer.packaging ?? null,
        url: httpsUrl(offer.clickUrl) ?? null,
        updated: offer.updated ?? null,
        prices,
      });
    }
  }
  return offers
    .sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || a.prices[0].price - b.prices[0].price)
    .slice(0, MAX_OFFERS);
};

/**
 * Turns one Nexar match result into sourcing info. Only an exact MPN match is accepted: a
 * lookalike part would put the wrong datasheet and price next to the user's component.
 */
export function mapNexarMatch(requestedMpn: string, match: NexarMatch | undefined, currency: string, now = new Date()): PartSourcingInfo {
  const fetchedAt = now.toISOString();
  if (!match || match.error) {
    return { status: 'unavailable', source: 'nexar', reason: match?.error ?? 'No response for this part', offers: [], fetchedAt };
  }
  const wanted = mpnKey(requestedMpn);
  const part = (match.parts ?? []).find((p) => p.mpn && mpnKey(p.mpn) === wanted);
  if (!part) {
    return { status: 'not_found', source: 'nexar', reason: 'No exact manufacturer part number match', offers: [], fetchedAt };
  }
  const median = part.medianPrice1000;
  return {
    status: 'verified',
    source: 'nexar',
    mpn: part.mpn ?? requestedMpn,
    manufacturer: part.manufacturer?.name ?? undefined,
    description: part.shortDescription ?? undefined,
    lifecycle: spec(part, 'lifecyclestatus')?.replace(/\s*\(.*\)\s*$/, ''),
    package: spec(part, 'case_package', 'package'),
    octopartUrl: httpsUrl(part.octopartUrl),
    datasheetUrl: httpsUrl(part.bestDatasheet?.url),
    totalAvail: typeof part.totalAvail === 'number' ? part.totalAvail : undefined,
    medianPrice1000:
      typeof median?.price === 'number' && median.currency === currency ? { price: median.price, currency } : undefined,
    offers: mapOffers(part, currency),
    fetchedAt,
  };
}

/** Lowest single-unit price among in-stock offers, falling back to any listed offer. */
export function bestUnitPrice(info: PartSourcingInfo): number | undefined {
  const pick = (offers: SourcingOffer[]) =>
    offers.length ? Math.min(...offers.map((o) => o.prices[0].price)) : undefined;
  return pick(info.offers.filter((o) => o.stock > 0)) ?? pick(info.offers);
}

const priority = (item: BomItem, controller?: string): number => {
  if (controller && mpnKey(item.partNumber) === mpnKey(controller)) return 1_000_000;
  return (item.unitCostUsd ?? 0) * (item.qty || 1);
};

let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
};

const lookupsUsed = async (): Promise<number> => {
  const total = await prisma.partSourcing.aggregate({ _sum: { lookupCount: true } });
  return total._sum.lookupCount ?? 0;
};

const notChecked = (reason: string): PartSourcingInfo => ({
  status: 'not_checked',
  source: 'nexar',
  reason,
  offers: [],
  fetchedAt: new Date().toISOString(),
});

async function resolveSourcing(items: BomItem[], controllerPart?: string): Promise<Map<string, PartSourcingInfo>> {
  const result = new Map<string, PartSourcingInfo>();
  const candidates = new Map<string, BomItem>();
  for (const item of items) {
    const key = mpnKey(item.partNumber ?? '');
    if (!looksLikeMpn(item.partNumber ?? '')) continue;
    const existing = candidates.get(key);
    if (!existing || priority(item, controllerPart) > priority(existing, controllerPart)) candidates.set(key, item);
  }

  const keys = [...candidates.keys()];
  const now = new Date();
  const cached = keys.length ? await prisma.partSourcing.findMany({ where: { mpnKey: { in: keys } } }) : [];
  const stale: string[] = [];
  const cachedByKey = new Map(cached.map((row) => [row.mpnKey, row]));
  for (const key of keys) {
    const row = cachedByKey.get(key);
    if (row && row.expiresAt > now) result.set(key, row.payload as unknown as PartSourcingInfo);
    else stale.push(key);
  }
  if (stale.length === 0) return result;

  const toLookUp = await serialized(async () => {
    const remaining = Math.max(0, env.NEXAR_LOOKUP_BUDGET - (await lookupsUsed()));
    const allowed = Math.min(remaining, env.NEXAR_MAX_LOOKUPS_PER_VERSION);
    const ranked = stale
      .map((key) => candidates.get(key) as BomItem)
      .sort((a, b) => priority(b, controllerPart) - priority(a, controllerPart))
      .slice(0, allowed);
    return { ranked, remaining };
  });

  const selected = new Set(toLookUp.ranked.map((item) => mpnKey(item.partNumber)));
  for (const key of stale) {
    if (!selected.has(key)) {
      result.set(key, notChecked(toLookUp.remaining === 0 ? 'Lookup budget used' : 'Lookup limit reached for this version'));
    }
  }
  if (toLookUp.ranked.length === 0) return result;

  try {
    const data = await nexarQuery<{ supMultiMatch: NexarMatch[] }>(MULTI_MATCH_QUERY, {
      currency: env.NEXAR_CURRENCY,
      q: toLookUp.ranked.map((item) => ({ mpn: item.partNumber.trim(), reference: mpnKey(item.partNumber), limit: 1 })),
    });
    const byRef = new Map((data.supMultiMatch ?? []).map((m) => [m.reference ?? '', m]));
    const expiresAt = new Date(now.getTime() + env.NEXAR_CACHE_TTL_HOURS * 3_600_000);
    for (const item of toLookUp.ranked) {
      const key = mpnKey(item.partNumber);
      const info = mapNexarMatch(item.partNumber, byRef.get(key), env.NEXAR_CURRENCY, now);
      result.set(key, info);
      // Transient failures are not cached, so the part is retried rather than pinned as unavailable.
      if (info.status === 'unavailable') continue;
      await prisma.partSourcing.upsert({
        where: { mpnKey: key },
        create: { mpnKey: key, status: info.status, payload: info as never, expiresAt },
        update: { status: info.status, payload: info as never, fetchedAt: now, expiresAt, lookupCount: { increment: 1 } },
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof NexarError ? err.message : String(err) }, 'Nexar lookup failed; BOM left unverified');
    for (const item of toLookUp.ranked) {
      result.set(mpnKey(item.partNumber), {
        status: 'unavailable',
        source: 'nexar',
        reason: 'Sourcing service unavailable',
        offers: [],
        fetchedAt: now.toISOString(),
      });
    }
  }
  return result;
}

/**
 * Attaches verified distributor data (price, stock, buy links, package, lifecycle, datasheet)
 * to BOM lines. Never throws: generation must not depend on a third-party API. Anything that
 * is not verified keeps no sourcing numbers, and a model-estimated price is labelled as such.
 */
export async function enrichBomWithSourcing(bom: BomItem[], controllerPart?: string): Promise<BomItem[]> {
  if (!Array.isArray(bom) || bom.length === 0) return bom;
  const label = (item: BomItem): BomItem =>
    typeof item.unitCostUsd === 'number' ? { ...item, priceSource: 'estimate' } : item;
  if (!nexarConfigured()) return bom.map(label);

  let resolved: Map<string, PartSourcingInfo>;
  try {
    resolved = await resolveSourcing(bom, controllerPart);
  } catch (err) {
    logger.warn({ err: String(err) }, 'Part sourcing failed; continuing without it');
    return bom.map(label);
  }

  return bom.map((item) => {
    const info = resolved.get(mpnKey(item.partNumber ?? ''));
    if (!info) return label(item);
    if (info.status !== 'verified') return { ...label(item), sourcing: info };
    const price = bestUnitPrice(info);
    const priced = price !== undefined ? { ...item, unitCostUsd: Number(price.toFixed(4)), priceSource: 'nexar' as const } : label(item);
    return {
      ...priced,
      manufacturer: info.manufacturer ?? item.manufacturer,
      datasheetUrl: info.datasheetUrl ?? item.datasheetUrl,
      sourcing: info,
    };
  });
}
