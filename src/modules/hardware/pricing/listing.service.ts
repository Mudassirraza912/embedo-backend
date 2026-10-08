import { prisma } from '../../../db/prisma.js';
import { logger } from '../../../config/logger.js';
import { fetchVendorHtml, isAllowedVendorUrl } from '../discovery/vendor-page.js';
import { parseListing } from './listing-parser.js';

/**
 * Price and stock for library boards, read from their store pages (plan §22 commerce addendum).
 * Each listing URL is checked at most once per CACHE_TTL; a manual refresh re-checks it only when
 * the cached result is older than REFRESH_MIN, so users cannot turn the endpoint into a crawler.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_MIN_MS = 10 * 60 * 1000;
const CONCURRENCY = 4;
const LISTING_SOURCE_TYPES = ['product_page', 'retail_listing'];

export interface BoardRef {
  hardwareEntityId: string;
  vendorSku?: string | null;
}

export interface ListingOffer {
  url: string;
  store: string;
  official: boolean;
  status: 'ok' | 'not_listed' | 'error';
  price: number | null;
  currency: string | null;
  stockState: string | null;
  storeSku: string | null;
  checkedAt: string;
}

export interface BoardPricing {
  hardwareEntityId: string;
  offers: ListingOffer[];
}

type ListingRow = Awaited<ReturnType<typeof prisma.vendorListing.findMany>>[number];

const inFlight = new Map<string, Promise<ListingRow>>();

async function checkListing(url: string, hardwareEntityId: string, preferSku: string | null | undefined): Promise<ListingRow> {
  const storeHost = new URL(url).hostname.toLowerCase();
  const checkedAt = new Date();
  let data: {
    status: string;
    price: number | null;
    currency: string | null;
    stockState: string | null;
    storeSku: string | null;
    productName: string | null;
    parseMethod: string | null;
    lastError: string | null;
  };
  try {
    const page = await fetchVendorHtml(url);
    const parsed = parseListing(page.html, { preferSku });
    data = parsed
      ? {
          status: 'ok',
          price: parsed.price,
          currency: parsed.currency,
          stockState: parsed.stockState,
          storeSku: parsed.storeSku?.slice(0, 100) ?? null,
          productName: parsed.productName?.slice(0, 300) ?? null,
          parseMethod: parsed.method,
          lastError: null,
        }
      : { status: 'not_listed', price: null, currency: null, stockState: null, storeSku: null, productName: null, parseMethod: null, lastError: null };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    logger.info({ url, err: message }, 'Store listing check failed');
    data = { status: 'error', price: null, currency: null, stockState: null, storeSku: null, productName: null, parseMethod: null, lastError: message };
  }

  const row = await prisma.vendorListing.upsert({
    where: { url },
    create: { url, storeHost, hardwareEntityId, checkedAt, ...data },
    update: { storeHost, hardwareEntityId, checkedAt, ...data },
  });
  if (data.status === 'ok' && data.price != null && data.currency) {
    await prisma.listingObservation.create({
      data: { listingId: row.listingId, price: data.price, currency: data.currency, stockState: data.stockState ?? 'unknown' },
    });
  }
  return row;
}

function checkOnce(url: string, hardwareEntityId: string, preferSku: string | null | undefined): Promise<ListingRow> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const p = checkListing(url, hardwareEntityId, preferSku).finally(() => inFlight.delete(url));
  inFlight.set(url, p);
  return p;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const toOffer = (row: ListingRow, official: boolean): ListingOffer => ({
  url: row.url,
  store: row.storeHost.replace(/^www\.|^shop\./, ''),
  official,
  status: row.status as ListingOffer['status'],
  price: row.price != null ? Number(row.price) : null,
  currency: row.currency,
  stockState: row.stockState,
  storeSku: row.storeSku,
  checkedAt: row.checkedAt.toISOString(),
});

export const listingService = {
  async pricesFor(boards: BoardRef[], opts: { refresh?: boolean } = {}): Promise<BoardPricing[]> {
    const ids = [...new Set(boards.map((b) => b.hardwareEntityId))];
    if (ids.length === 0) return [];
    const skuOf = new Map(boards.map((b) => [b.hardwareEntityId, b.vendorSku ?? null]));

    const sources = await prisma.hardwareSource.findMany({
      where: { hardwareEntityId: { in: ids }, sourceType: { in: LISTING_SOURCE_TYPES }, url: { not: null } },
      select: { hardwareEntityId: true, url: true, official: true },
    });
    const links = sources.filter((s) => isAllowedVendorUrl(s.url)) as Array<{ hardwareEntityId: string; url: string; official: boolean }>;

    const cached = await prisma.vendorListing.findMany({ where: { url: { in: links.map((l) => l.url) } } });
    const byUrl = new Map(cached.map((r) => [r.url, r]));
    const now = Date.now();
    const stale = (r: ListingRow | undefined) => !r || now - r.checkedAt.getTime() > (opts.refresh ? REFRESH_MIN_MS : CACHE_TTL_MS);

    const toCheck = [...new Map(links.filter((l) => stale(byUrl.get(l.url))).map((l) => [l.url, l])).values()];
    const fresh = await mapLimited(toCheck, CONCURRENCY, (l) => checkOnce(l.url, l.hardwareEntityId, skuOf.get(l.hardwareEntityId)));
    for (const row of fresh) byUrl.set(row.url, row);

    return ids.map((id) => ({
      hardwareEntityId: id,
      offers: links
        .filter((l) => l.hardwareEntityId === id && byUrl.has(l.url))
        .map((l) => toOffer(byUrl.get(l.url)!, l.official))
        // Priced offers first, in stock before out of stock, then the official store.
        .sort(
          (a, b) =>
            Number(b.status === 'ok') - Number(a.status === 'ok') ||
            Number(b.stockState === 'in_stock') - Number(a.stockState === 'in_stock') ||
            Number(b.official) - Number(a.official)
        ),
    }));
  },
};
