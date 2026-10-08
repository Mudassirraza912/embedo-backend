/**
 * Reads price and stock from a store's product page (plan §22 commerce addendum). Parsing is
 * deterministic and only trusts machine-readable markup the store publishes for search engines:
 * schema.org Product JSON-LD first, then Open Graph product meta tags, then schema.org microdata.
 * No model is involved, so a price is either read from the page or reported as not listed.
 */

export const STOCK_STATES = ['in_stock', 'out_of_stock', 'preorder', 'backorder', 'discontinued', 'unknown'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export interface ParsedListing {
  price: number;
  currency: string;
  stockState: StockState;
  storeSku: string | null;
  productName: string | null;
  method: 'jsonld' | 'meta' | 'microdata';
}

type Json = Record<string, unknown>;

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const toPrice = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 && v < 1_000_000 ? Math.round(v * 100) / 100 : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[^0-9.,]/g, '');
  // "1,299.00" → 1299.00; "12,95" (comma decimal) → 12.95
  const normalised = /,\d{2}$/.test(cleaned) && !cleaned.includes('.') ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  return normalised ? toPrice(Number(normalised)) : null;
};

const toCurrency = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null);

export function toStockState(v: unknown): StockState {
  if (typeof v !== 'string') return 'unknown';
  const s = v.toLowerCase().replace(/^https?:\/\/schema\.org\//, '').replace(/[\s_-]/g, '');
  if (/^(instock|limitedavailability|instoreonly|onlineonly|available)$/.test(s)) return 'in_stock';
  if (/^(outofstock|soldout|unavailable)$/.test(s)) return 'out_of_stock';
  if (/^(preorder|presale)$/.test(s)) return 'preorder';
  if (/^backorder$/.test(s)) return 'backorder';
  if (/^discontinued$/.test(s)) return 'discontinued';
  return 'unknown';
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typeIs = (node: Json, ...types: string[]): boolean => asArray(node['@type']).some((t) => typeof t === 'string' && types.includes(t));

/** Every JSON object inside the page's ld+json blocks (handles arrays and @graph). */
function jsonLdNodes(html: string): Json[] {
  const nodes: Json[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const node = v as Json;
    nodes.push(node);
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node['hasVariant']) walk(node['hasVariant'], depth + 1);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]!.trim()), 0);
    } catch {
      // Malformed block (common on store themes); the other parsers still run.
    }
  }
  return nodes;
}

interface Offer {
  price: number;
  currency: string | null;
  stockState: StockState;
  sku: string | null;
}

function offersOf(product: Json, fallbackCurrency: string | null): Offer[] {
  const out: Offer[] = [];
  for (const raw of asArray(product['offers'])) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Json;
    const spec = (asArray(o['priceSpecification'])[0] ?? {}) as Json;
    const price = toPrice(o['price'] ?? o['lowPrice'] ?? spec['price']);
    if (price == null) continue;
    out.push({
      price,
      currency: toCurrency(o['priceCurrency'] ?? spec['priceCurrency']) ?? fallbackCurrency,
      stockState: toStockState(o['availability']),
      sku: typeof o['sku'] === 'string' || typeof o['sku'] === 'number' ? String(o['sku']) : null,
    });
  }
  return out;
}

const skuMatches = (a: string | null, want: string | null | undefined) =>
  !!a && !!want && a.replace(/[\s-]/g, '').toLowerCase() === want.replace(/[\s-]/g, '').toLowerCase();

/** Pick the offer for this board: the one whose SKU matches, else the first in-stock one, else the first. */
function pickOffer(offers: Offer[], preferSku?: string | null): Offer | null {
  return offers.find((o) => skuMatches(o.sku, preferSku)) ?? offers.find((o) => o.stockState === 'in_stock') ?? offers[0] ?? null;
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']${key.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
  return content != null ? decodeEntities(content).trim() : null;
}

export function parseListing(html: string, opts: { preferSku?: string | null } = {}): ParsedListing | null {
  // 1. schema.org Product JSON-LD
  const nodes = jsonLdNodes(html);
  const products = nodes.filter((n) => typeIs(n, 'Product', 'ProductGroup', 'IndividualProduct'));
  const metaCurrency = toCurrency(metaContent(html, 'product:price:currency') ?? metaContent(html, 'og:price:currency'));
  for (const product of products) {
    const offer = pickOffer(offersOf(product, metaCurrency), opts.preferSku);
    if (offer && offer.currency) {
      return {
        price: offer.price,
        currency: offer.currency,
        stockState: offer.stockState,
        storeSku: offer.sku ?? (product['sku'] != null ? String(product['sku']) : null),
        productName: typeof product['name'] === 'string' ? decodeEntities(product['name']).slice(0, 300) : null,
        method: 'jsonld',
      };
    }
  }

  // 2. Open Graph product tags (Shopify, Magento and most store themes)
  const metaPrice = toPrice(metaContent(html, 'product:price:amount') ?? metaContent(html, 'og:price:amount'));
  if (metaPrice != null && metaCurrency) {
    return {
      price: metaPrice,
      currency: metaCurrency,
      stockState: toStockState(metaContent(html, 'product:availability') ?? metaContent(html, 'og:availability')),
      storeSku: metaContent(html, 'product:retailer_item_id'),
      productName: metaContent(html, 'og:title'),
      method: 'meta',
    };
  }

  // 3. schema.org microdata
  const microPrice = toPrice(metaContent(html, 'price') ?? html.match(/itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1]);
  const microCurrency = toCurrency(metaContent(html, 'priceCurrency'));
  if (microPrice != null && microCurrency) {
    const availability = html.match(/itemprop\s*=\s*["']availability["'][^>]*(?:href|content)\s*=\s*["']([^"']+)["']/i)?.[1];
    return { price: microPrice, currency: microCurrency, stockState: toStockState(availability), storeSku: null, productName: null, method: 'microdata' };
  }
  return null;
}
