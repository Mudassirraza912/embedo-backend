import { parseListing, toStockState } from '../../src/modules/hardware/pricing/listing-parser.js';

const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe('parseListing', () => {
  it('reads a single schema.org Offer (Adafruit style, string price with trailing zeros)', () => {
    const html = `<html><head>${ld({ '@context': 'http://schema.org', '@type': 'WebSite' })}${ld({
      '@context': 'http://schema.org',
      '@type': 'Product',
      name: 'Adafruit Ultimate GPS Breakout',
      sku: 746,
      offers: { '@type': 'Offer', availability: 'http://schema.org/InStock', price: '29.9500', priceCurrency: 'USD' },
    })}</head></html>`;
    expect(parseListing(html)).toEqual({
      price: 29.95,
      currency: 'USD',
      stockState: 'in_stock',
      storeSku: '746',
      productName: 'Adafruit Ultimate GPS Breakout',
      method: 'jsonld',
    });
  });

  it('picks the variant whose SKU matches the board (Shopify multi-variant)', () => {
    const html = ld({
      '@type': 'Product',
      name: 'Raspberry Pi Pico',
      offers: [
        { '@type': 'Offer', availability: 'http://schema.org/OutOfStock', price: '3.8', priceCurrency: 'GBP', sku: 'SC0915' },
        { '@type': 'Offer', availability: 'http://schema.org/InStock', price: '4.8', priceCurrency: 'GBP', sku: 'SC0917' },
      ],
    });
    expect(parseListing(html, { preferSku: 'sc-0915' })).toMatchObject({ price: 3.8, currency: 'GBP', stockState: 'out_of_stock', storeSku: 'SC0915' });
    // Without a SKU to match, the in-stock variant wins.
    expect(parseListing(html)).toMatchObject({ price: 4.8, storeSku: 'SC0917' });
  });

  it('uses the meta currency when the offer has none, and bare availability words (Pololu/SparkFun)', () => {
    const html = `<meta property="product:price:currency" content="USD"/>${ld({
      '@type': 'Product',
      offers: [{ '@type': 'Offer', price: 16.95, availability: 'InStock' }],
    })}`;
    expect(parseListing(html)).toMatchObject({ price: 16.95, currency: 'USD', stockState: 'in_stock', method: 'jsonld' });
  });

  it('finds products inside @graph and handles AggregateOffer lowPrice', () => {
    const html = ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization' }, { '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 9.9, priceCurrency: 'eur' } }] });
    expect(parseListing(html)).toMatchObject({ price: 9.9, currency: 'EUR', stockState: 'unknown' });
  });

  it('falls back to Open Graph product meta tags when JSON-LD is missing or broken', () => {
    const html = `<script type="application/ld+json">{ not json </script>
      <meta property="product:price:amount" content="14.95"><meta property="product:price:currency" content="USD">
      <meta property="product:availability" content="out of stock"><meta property="og:title" content="BME280 &amp; friends">`;
    expect(parseListing(html)).toEqual({ price: 14.95, currency: 'USD', stockState: 'out_of_stock', storeSku: null, productName: 'BME280 & friends', method: 'meta' });
  });

  it('falls back to microdata', () => {
    const html = `<span itemprop="price" content="1,299.00"></span><meta itemprop="priceCurrency" content="USD"><link itemprop="availability" href="https://schema.org/PreOrder">`;
    expect(parseListing(html)).toMatchObject({ price: 1299, currency: 'USD', stockState: 'preorder', method: 'microdata' });
  });

  it('returns null rather than guessing when the page has no machine-readable price', () => {
    expect(parseListing('<html><body><p>Price: $9.99</p></body></html>')).toBeNull();
    expect(parseListing(ld({ '@type': 'Product', offers: { price: '0', priceCurrency: 'USD' } }))).toBeNull();
    expect(parseListing(ld({ '@type': 'Product', offers: { price: '5.00' } }))).toBeNull(); // no currency anywhere
  });
});

describe('toStockState', () => {
  it.each([
    ['https://schema.org/InStock', 'in_stock'],
    ['http://schema.org/LimitedAvailability', 'in_stock'],
    ['SoldOut', 'out_of_stock'],
    ['out_of_stock', 'out_of_stock'],
    ['BackOrder', 'backorder'],
    ['Discontinued', 'discontinued'],
    ['whatever', 'unknown'],
    [undefined, 'unknown'],
  ])('%s → %s', (input, expected) => {
    expect(toStockState(input)).toBe(expected);
  });
});
