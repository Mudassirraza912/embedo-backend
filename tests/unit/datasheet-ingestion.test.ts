import { describe, it, expect } from '@jest/globals';
import { deepStripControl, normalizeRatingsGroup, locateSection, isTableOfContentsPage, extractTables, extractFigureCaptions, datasheetIngestionService } from '../../src/modules/components/datasheet-ingestion.service.js';

/** Builds a synthetic multi-hundred-page document — big enough that a naive front-matter
 * excerpt (the old 16,000-character slice) would never reach the target heading. */
function buildPages(count: number, headingOnPage?: number, headingText = 'Absolute Maximum Ratings'): Array<{ num: number; text: string }> {
  const pages: Array<{ num: number; text: string }> = [];
  for (let i = 1; i <= count; i++) {
    const filler = `Page ${i} of the datasheet. Feature description and general notes repeated to pad page length. `.repeat(20);
    const text = i === headingOnPage ? `${headingText}\nStress ratings only; exceeding these may cause permanent damage.\nVDD: -0.3V to 4.0V\n${filler}` : filler;
    pages.push({ num: i, text });
  }
  return pages;
}

describe('locateSection', () => {
  it('finds a heading far beyond any front-matter slice (page 300 of 350)', () => {
    const pages = buildPages(350, 300);
    // A 16,000-char front-matter excerpt over ~90-char pages would cover roughly the first 170
    // pages — nowhere near page 300. This proves locateSection is not size-limited the way the
    // old single front-matter extraction call was.
    const found = locateSection(pages, [/absolute\s+maximum\s+rating/i]);
    expect(found).not.toBeNull();
    expect(found?.pageStart).toBe(300);
  });

  it('finds a heading on page 1 just as reliably as page 300', () => {
    const pages = buildPages(50, 1);
    const found = locateSection(pages, [/absolute\s+maximum\s+rating/i]);
    expect(found?.pageStart).toBe(1);
  });

  it('includes trailing pages, since rating tables commonly run onto the next page', () => {
    const pages = buildPages(20, 10);
    const found = locateSection(pages, [/absolute\s+maximum\s+rating/i], { trailingPages: 2 });
    expect(found?.pageStart).toBe(10);
    expect(found?.pageEnd).toBe(12);
  });

  it('returns null (not an error) when the heading is absent — most short datasheets have no separate section', () => {
    const pages = buildPages(10);
    expect(locateSection(pages, [/absolute\s+maximum\s+rating/i])).toBeNull();
  });

  it('matches manufacturer heading variants (ST/TI/Espressif/etc. all phrase it slightly differently)', () => {
    const variants = ['Absolute Maximum Ratings', 'ABSOLUTE MAXIMUM RATING', 'Maximum Ratings'];
    for (const heading of variants) {
      const pages = buildPages(5, 3, heading);
      const found = locateSection(pages, [/absolute\s+maximum\s+rating/i, /maximum\s+ratings?\b/i]);
      expect(found?.pageStart).toBe(3);
    }
  });

  it('caps returned text length so one huge section cannot blow the extraction call input size', () => {
    const pages = [{ num: 1, text: 'Absolute Maximum Ratings\n' + 'x'.repeat(50_000) }];
    const found = locateSection(pages, [/absolute\s+maximum\s+rating/i], { maxChars: 6000 });
    expect(found?.text.length).toBeLessThanOrEqual(6000);
  });

  it('skips a Table of Contents entry that matches the same heading pattern (real bug: TI ADS1115 ToC line "5.3 Recommended Operating Conditions.......4" was matched instead of the real section on a later page)', () => {
    const pages = [
      { num: 1, text: 'Table of Contents\n5.3 Recommended Operating Conditions.........................4\n' },
      { num: 2, text: 'Some other section, not the one we want.' },
      { num: 3, text: 'Filler page.' },
      { num: 4, text: 'Recommended Operating Conditions\nVDD: 2.0V to 5.5V typ 3.3V\n' },
    ];
    const found = locateSection(pages, [/recommended\s+operating\s+condition/i]);
    expect(found?.pageStart).toBe(4);
    expect(found?.text).toContain('VDD');
  });
});

describe('extractTables (serialization + multi-page continuity)', () => {
  const header = ['Parameter', 'Min', 'Max'];
  it('merges a table that is last on page 1 and first on page 2, dropping the repeated header', () => {
    const out = extractTables([
      { num: 1, tables: [[header, ['a', '1', '2']]] },
      { num: 2, tables: [[header, ['b', '3', '4']]] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pageStart).toBe(1);
    expect(out[0].pageEnd).toBe(2);
    expect(out[0].rows).toEqual([header, ['a', '1', '2'], ['b', '3', '4']]);
  });

  it('does NOT merge unrelated same-width tables when a diagram/other table sits between them on the next page', () => {
    const out = extractTables([
      { num: 1, tables: [[header, ['a', '1', '2']]] },
      { num: 2, tables: [[['x'], ['y']], [header, ['b', '3', '4']]] },
    ]);
    expect(out).toHaveLength(2);
  });

  it('drops noise detections (single column / mostly empty) that come from diagrams', () => {
    const out = extractTables([{ num: 1, tables: [[[''], ['']], [['', ''], ['', '']]] }]);
    expect(out).toHaveLength(0);
  });

  it('serializes both a faithful pipe text and escaped HTML', () => {
    const [t] = extractTables([{ num: 1, tables: [[['A', 'B'], ['1 < 2', '&']]] }]);
    expect(t.text).toBe('A | B\n1 < 2 | &');
    expect(t.html).toContain('<td>1 &lt; 2</td>');
    expect(t.html).toContain('<td>&amp;</td>');
  });
});

describe('extractFigureCaptions', () => {
  it('captures TI-style section-numbered captions with the real page number', () => {
    const caps = extractFigureCaptions([{ num: 37, text: 'body\nFigure 10-1. ADS1115 Power-Supply Decoupling\nwww.ti.com' }]);
    expect(caps).toEqual([{ caption: 'Figure 10-1. ADS1115 Power-Supply Decoupling', pageNumber: 37 }]);
  });
  it('captures plain-numbered captions', () => {
    expect(extractFigureCaptions([{ num: 2, text: 'Figure 3: Block diagram of the core' }])).toHaveLength(1);
  });
});

describe('chunkText semantic packing', () => {
  it('packs small sections together instead of emitting one tiny chunk per heading', () => {
    const section = (n: number) => `${n}.1 Section Heading Number ${n}\n` + 'text '.repeat(30);
    const text = Array.from({ length: 12 }, (_, i) => section(i + 1)).join('\n');
    const chunks = datasheetIngestionService.chunkText(text, 1200, 200);
    expect(chunks.length).toBeLessThan(6);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1200);
  });
  it('still windows an oversized single section', () => {
    const chunks = datasheetIngestionService.chunkText('word '.repeat(1000), 1200, 200);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('isTableOfContentsPage (structural)', () => {
  const espContents = ['Contents', '5 Electrical Characteristics 54', '5.1 Absolute Maximum Ratings 54', '5.2 Recommended Operating Conditions 54', '5.3 VDD_SPI Output Characteristics 55', '5.4 DC Characteristics (3.3 V, 25 °C) 55', '5.5 ADC Characteristics 56', '5.6 Current Consumption 56', '6 RF Characteristics 59'].join('\n');
  it('detects an Espressif-style "Contents" page without the phrase "Table of Contents"', () => {
    expect(isTableOfContentsPage(espContents)).toBe(true);
  });
  it('detects list-of-tables pages', () => {
    const lot = ['List of Tables', ...Array.from({ length: 8 }, (_, i) => `2-${i + 1} Pin Overview ${16 + i}`)].join('\n');
    expect(isTableOfContentsPage(lot)).toBe(true);
  });
  it('does not flag a real ratings page', () => {
    const real = '5.1 Absolute Maximum Ratings\nParameter Min Max Unit\nVDD33 -0.3 3.6 V\nTstore -40 150 °C\nCautions: stresses beyond these may cause damage';
    expect(isTableOfContentsPage(real)).toBe(false);
  });
  it('locateSection skips a headed-"Contents" page and lands on the real section', () => {
    const found = locateSection(
      [{ num: 8, text: espContents }, { num: 54, text: '5.1 Absolute Maximum Ratings\nVDD33 -0.3 3.6 V' }],
      [/absolute\s+maximum\s+rating/i]
    );
    expect(found?.pageStart).toBe(54);
  });
});

describe('locateSection heading-line preference', () => {
  it('prefers a real heading page over an earlier prose cross-reference', () => {
    const pages = [
      { num: 26, text: 'Power pins are described below. See Recommended Operating Conditions for limits on the supply.\n' + 'x '.repeat(50) },
      { num: 54, text: '5.2 Recommended Operating Conditions\nVDD33 3.0 3.3 3.6 V' },
    ];
    expect(locateSection(pages, [/recommended\s+operating\s+condition/i])?.pageStart).toBe(54);
  });
  it('falls back to a prose mention when no heading line exists', () => {
    const pages = [{ num: 3, text: 'The limits are given under Recommended Operating Conditions in this document.' }];
    expect(locateSection(pages, [/recommended\s+operating\s+condition/i])?.pageStart).toBe(3);
  });
});

describe('normalizeRatingsGroup (units + sanity)', () => {
  it('converts µA (micro sign) and μA (Greek mu) to mA — never to amps', () => {
    const a = normalizeRatingsGroup({ current: { max: 300, unit: 'µA' } });
    const b = normalizeRatingsGroup({ current: { max: 300, unit: '\u03bcA' } });
    expect(a?.current?.max).toBeCloseTo(0.3);
    expect(b?.current?.max).toBeCloseTo(0.3);
    expect(b?.current?.unit).toBe('mA');
  });
  it('converts mV to V and A to mA and Fahrenheit/Kelvin to Celsius', () => {
    expect(normalizeRatingsGroup({ voltage: { max: 3300, unit: 'mV' } })?.voltage?.max).toBeCloseTo(3.3);
    expect(normalizeRatingsGroup({ current: { max: 0.5, unit: 'A' } })?.current?.max).toBeCloseTo(500);
    expect(normalizeRatingsGroup({ temperature: { max: 212, unit: '°F' } })?.temperature?.max).toBeCloseTo(100);
    expect(normalizeRatingsGroup({ temperature: { min: 273.15, unit: 'K' } })?.temperature?.min).toBeCloseTo(0);
  });
  it('drops a typ that merely copies max (row printed only Min/Max)', () => {
    const out = normalizeRatingsGroup({ voltage: { min: 2, typ: 5.5, max: 5.5, unit: 'V' } });
    expect(out?.voltage?.typ).toBeUndefined();
    expect(out?.voltage?.max).toBe(5.5);
  });
  it('keeps a genuine typ strictly between min and max', () => {
    expect(normalizeRatingsGroup({ voltage: { min: 3, typ: 3.3, max: 3.6, unit: 'V' } })?.voltage?.typ).toBe(3.3);
  });
  it('drops ranges that are only a unit label, and empty groups entirely', () => {
    expect(normalizeRatingsGroup({ current: { unit: 'mA' }, voltage: { unit: 'V' } })).toBeUndefined();
  });
});

describe('locateSection ordered patterns', () => {
  const pages = [
    { num: 54, text: '5 Electrical Characteristics\n5.1 Absolute Maximum Ratings\nrows' },
    { num: 55, text: '5.4 DC Characteristics (3.3 V, 25 C)\nCIN pin capacitance 2 pF' },
  ];
  it('by default the earliest page matching any pattern wins (chapter title beats the table)', () => {
    expect(locateSection(pages, [/dc\s+characteristics/i, /electrical\s+characteristics/i])?.pageStart).toBe(54);
  });
  it('ordered:true honours pattern priority, so the specific heading wins', () => {
    expect(locateSection(pages, [/dc\s+characteristics/i, /electrical\s+characteristics/i], { ordered: true })?.pageStart).toBe(55);
  });
  it('ordered:true falls through to a later pattern when the first has no match', () => {
    expect(locateSection(pages, [/nonexistent/i, /absolute\s+maximum/i], { ordered: true })?.pageStart).toBe(54);
  });
});

describe('locateSection heading-line prefix rule', () => {
  it('does not treat "ADC characteristics" inside a prose sentence as a DC characteristics heading', () => {
    const pages = [
      { num: 49, text: 'For ADC characteristics, please refer to Section 5.5 ADC Characteristics.' },
      { num: 55, text: '5.4 DC Characteristics (3.3 V, 25 C)\nCIN 2 pF' },
    ];
    expect(locateSection(pages, [/\bdc\s+characteristics/i])?.pageStart).toBe(55);
  });
  it('accepts a "Table 5-4." caption prefix as a heading line', () => {
    expect(locateSection([{ num: 7, text: 'Table 5-4. DC Characteristics (3.3 V)\nrows' }], [/\bdc\s+characteristics/i])?.pageStart).toBe(7);
  });
});

describe('control-character safety (Postgres rejects 0x00)', () => {
  it('extractTables strips NUL from cells, text and html', () => {
    const [t] = extractTables([{ num: 1, tables: [[['A\u0000', 'B'], ['x\u0000y', '1\u0001']]] }]);
    expect(JSON.stringify(t)).not.toContain('\\u0000');
    expect(t.text.includes('\u0000')).toBe(false);
    expect(t.html.includes('\u0000')).toBe(false);
  });
  it('deepStripControl cleans nested strings, keys and arrays but keeps numbers and newlines', () => {
    const out = deepStripControl({ 'k\u0000ey': ['a\u0000b', { n: 5, t: 'l1\nl2' }], ok: true });
    expect(JSON.stringify(out).includes('\\u0000')).toBe(false);
    expect(out).toEqual({ key: ['ab', { n: 5, t: 'l1\nl2' }], ok: true });
  });
});

describe('downloadAndParsePdf with a pre-downloaded buffer (manual browser download path)', () => {
  it('rejects a non-PDF (e.g. a saved bot-block HTML page) as MALFORMED_PDF without touching the network', async () => {
    await expect(datasheetIngestionService.downloadAndParsePdf('https://www.st.com/x.pdf', Buffer.from('<HTML><BODY>Access Denied</BODY></HTML>'))).rejects.toMatchObject({
      details: { failureBucket: 'MALFORMED_PDF' },
    });
  });
  it('rejects an empty buffer', async () => {
    await expect(datasheetIngestionService.downloadAndParsePdf('https://www.st.com/x.pdf', Buffer.alloc(0))).rejects.toMatchObject({ details: { failureBucket: 'MALFORMED_PDF' } });
  });
});
