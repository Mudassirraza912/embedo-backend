import { describe, it, expect } from '@jest/globals';
import {
  parsePrintedRevision,
  trustedRevisionDate,
  extractOutline,
  sectionForPage,
  extractFootnotes,
  extractFeatures,
  extractCautions,
  attributePage,
  diffTrackedSpecs,
  normalizeQuantity,
  normalizeMeasuredRow,
  numberInText,
  groundMeasuredRow,
  resolveMeasuredUnit,
  coerceNumericField,
  matchesDatasheetFile,
  cleanStrings,
} from '../../src/modules/components/datasheet-parse.utils.js';

describe('parsePrintedRevision', () => {
  it('TI: uses the REVISED date, not the file date', () => {
    const r = parsePrintedRevision([{ num: 1, text: 'ADS1115\nSBAS444E – MAY 2009 – REVISED DECEMBER 2024\n' }]);
    expect(r.date).toBe('2024-12-01T00:00:00.000Z');
  });
  it('Espressif: datasheet version label', () => {
    expect(parsePrintedRevision([{ num: 1, text: 'ESP32-C3 Series Datasheet v2.4' }]).label).toBe('v2.4');
  });
  it('NXP: label and full date', () => {
    const r = parsePrintedRevision([{ num: 1, text: 'TJA1051\nRev. 4 — 21 June 2019\nProduct data sheet' }]);
    expect(r.label).toBe('Rev. 4');
    expect(r.date).toBe('2019-06-21T00:00:00.000Z');
  });
  it('ST: label and month-year', () => {
    const r = parsePrintedRevision([{ num: 1, text: 'DS12345 - Rev 3 - April 2019' }]);
    expect(r.label).toBe('Rev. 3');
    expect(r.date).toBe('2019-04-01T00:00:00.000Z');
  });
  it('ST date-first layout: "January 2026  DS12110 Rev 11"', () => {
    const r = parsePrintedRevision([{ num: 1, text: 'STM32H743xI\nJanuary 2026 \tDS12110 Rev 11 \t1/357\n' }]);
    expect(r.label).toBe('Rev. 11');
    expect(r.date).toBe('2026-01-01T00:00:00.000Z');
  });
  it('older ST layout: "May 2017  DocID025056 Rev 6"', () => {
    const r = parsePrintedRevision([{ num: 1, text: 'LIS2DH12\nMay 2017 \tDocID025056 Rev 6 \t1/53' }]);
    expect(r).toEqual({ label: 'Rev. 6', date: '2017-05-01T00:00:00.000Z' });
  });
  it('Maxim: "19-7740; Rev 1; 10/18"', () => {
    const r = parsePrintedRevision([{ num: 1, text: '19-7740; Rev 1; 10/18\nMAX30102' }]);
    expect(r).toEqual({ label: 'Rev. 1', date: '2018-10-01T00:00:00.000Z' });
  });
  it('returns nothing rather than guessing when no revision is printed', () => {
    expect(parsePrintedRevision([{ num: 1, text: 'A generic datasheet with no revision text' }])).toEqual({});
  });
});

describe('trustedRevisionDate', () => {
  it('trusts printed dates only', () => {
    expect(trustedRevisionDate({ date: '2024-12-01T00:00:00.000Z', dateSource: 'printed' })).toBe(Date.parse('2024-12-01T00:00:00.000Z'));
    expect(trustedRevisionDate({ date: '2026-09-04T00:00:00.000Z', dateSource: 'pdf-metadata' })).toBeUndefined();
    expect(trustedRevisionDate({ date: '2026-09-04T00:00:00.000Z' })).toBeUndefined();
  });
});

describe('extractOutline / sectionForPage', () => {
  const pages = [
    { num: 4, text: '5 Specifications\n5.1 Absolute Maximum Ratings\nPower-supply voltage VDD to GND 0.3 7 V\n5.3 Recommended Operating Conditions' },
    { num: 5, text: '5.4 Thermal Information\n1 Allowed input voltage 0.3 3.6 V' },
  ];
  it('finds headings with levels and pages, ignoring table rows', () => {
    const o = extractOutline(pages);
    expect(o.map((e) => e.number)).toEqual(['5', '5.1', '5.3', '5.4']);
    expect(o.find((e) => e.number === '5.1')?.level).toBe(2);
    expect(o.some((e) => e.title.includes('Allowed input voltage'))).toBe(false);
  });
  it('maps a page to the section in force', () => {
    expect(sectionForPage(extractOutline(pages), 5)).toBe('5.4 Thermal Information');
    expect(sectionForPage(extractOutline(pages), 3)).toBeUndefined();
  });
});

describe('extractOutline rejects page furniture', () => {
  it('ignores footers, pin rows and standalone numbers', () => {
    const o = extractOutline([
      {
        num: 6,
        text: '6 Submit Document Feedback Copyright © 2024 Texas Instruments Incorporated\n5 AIN1 6 AIN2\n1 Allowed input voltage 0.3 3.6 V\n5.4 DC Characteristics (3.3 V, 25 °C)\n6.2 Bluetooth 5 (LE) Radio\n7 Packaging',
      },
    ]);
    expect(o.map((e) => e.number)).toEqual(['5.4', '6.2', '7']);
  });
});

describe('extractFootnotes', () => {
  it('captures (n) footnotes with their page', () => {
    const f = extractFootnotes([{ num: 4, text: '(1) Stresses beyond those listed under Absolute Maximum Ratings may cause permanent damage.\nnoise' }]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ marker: '1', page: 4 });
  });
});

describe('extractFeatures', () => {
  it('collects bullets and joins wrapped lines, stopping at the next numbered section', () => {
    const f = extractFeatures([{ num: 1, text: '1 Features\n• Ultra-small packages\n• Wide supply range: 2.0V to 5.5V\n• Low current\nconsumption: 150μA\n2 Applications\n• Portable' }]);
    expect(f).toEqual(['Ultra-small packages', 'Wide supply range: 2.0V to 5.5V', 'Low current consumption: 150μA']);
  });
});

describe('extractCautions', () => {
  it('finds constraint sentences, strongest first, with pages', () => {
    const c = extractCautions([
      { num: 9, text: 'The GPIO must be tied to ground during boot. Some neutral sentence about the part here.' },
      { num: 4, text: 'Stresses beyond those listed may cause permanent damage to the device.' },
    ]);
    expect(c[0].text).toContain('permanent damage');
    expect(c[0].page).toBe(4);
    expect(c.some((x) => x.text.includes('tied to ground'))).toBe(true);
    expect(c.some((x) => x.text.includes('neutral'))).toBe(false);
  });
});

describe('attributePage', () => {
  const pages = [{ num: 24, text: 'Address Pointer Register' }, { num: 25, text: 'Config Register bits' }];
  it('returns the real page containing the fact', () => {
    expect(attributePage(pages, [24, 26], 'config register')).toBe(25);
  });
  it('returns undefined outside the range or for weak needles', () => {
    expect(attributePage(pages, [24, 24], 'config register')).toBeUndefined();
    expect(attributePage(pages, [24, 26], 'a')).toBeUndefined();
  });
});

describe('diffTrackedSpecs', () => {
  it('reports a limit that changed between revisions', () => {
    const d = diffTrackedSpecs(
      { absoluteMaxRatings: { voltage: { max: 7 } }, pins: [1, 2] },
      { absoluteMaxRatings: { voltage: { max: 6 } }, pins: [1, 2] }
    );
    expect(d.map((x) => x.field)).toEqual(['absoluteMaxRatings']);
  });
  it('does not treat a newly added field as a disagreement, and ignores key order', () => {
    expect(diffTrackedSpecs({}, { recommendedOperating: { a: 1 } })).toEqual([]);
    expect(diffTrackedSpecs({ recommendedOperating: { a: 1, b: 2 } }, { recommendedOperating: { b: 2, a: 1 } })).toEqual([]);
  });
});

describe('normalizeQuantity', () => {
  it.each([
    [300, 'µA', 0.3, 'mA'],
    [300, 'μA', 0.3, 'mA'],
    [3300, 'mV', 3.3, 'V'],
    [400, 'kHz', 0.4, 'MHz'],
    [1.3, 'µs', 1300, 'ns'],
    [4.7, 'kΩ', 4700, 'Ω'],
    [1, 'MΩ', 1000000, 'Ω'],
    [50, 'mΩ', 0.05, 'Ω'],
    [100, 'nF', 100000, 'pF'],
    [273.15, 'K', 0, '°C'],
  ])('%d %s -> %d %s', (v, u, expected, unit) => {
    const r = normalizeQuantity(v, u);
    expect(r.value).toBeCloseTo(expected as number, 6);
    expect(r.unit).toBe(unit);
  });
  it('distinguishes mΩ from MΩ (case matters)', () => {
    expect(normalizeQuantity(1, 'mΩ').value).toBeCloseTo(0.001);
    expect(normalizeQuantity(1, 'MΩ').value).toBe(1000000);
  });
  it('leaves an unknown unit untouched instead of guessing', () => {
    expect(normalizeQuantity(5, 'LSB')).toMatchObject({ value: 5, unit: 'LSB', converted: false });
  });
  it('keeps what was printed when converting', () => {
    expect(normalizeQuantity(300, 'µA').printedUnit).toBe('µA');
  });
});

describe('normalizeMeasuredRow', () => {
  it('converts, swaps transposed min/max, and drops a typ copied from a limit', () => {
    const r = normalizeMeasuredRow({ parameter: 'tBUF', min: 1300, max: 600, unit: 'ns' });
    expect(r.min).toBe(600);
    expect(r.max).toBe(1300);
    const c = normalizeMeasuredRow({ parameter: 'Icc', min: 100, typ: 300, max: 300, unit: 'µA' });
    expect(c.typ).toBeUndefined();
    expect(c.max).toBeCloseTo(0.3);
    expect(c.unit).toBe('mA');
  });
  it('drops empty-string fields', () => {
    const r = normalizeMeasuredRow({ parameter: 'x', symbol: '', conditions: '  ', typ: 1, unit: 'V' });
    expect('symbol' in r).toBe(false);
    expect('conditions' in r).toBe(false);
  });
  it('strips null fields', () => {
    const r = normalizeMeasuredRow({ parameter: 'x', min: null, typ: 1, max: null, unit: 'V' });
    expect('min' in r).toBe(false);
    expect(r.typ).toBe(1);
  });
});

describe('numberInText (grounding)', () => {
  const text = 'Active current 240 mA. Deep-sleep 5 µA. Range 3.0 3.3 3.6 V. Limit 1,500 mA. Cap 0.15 mA. Also .25 A and 5.5 V.';
  it.each([[240, true], [5, true], [3.3, true], [3.6, true], [1500, true], [0.15, true], [0.25, true], [-3.3, true]])('%d is found', (n, expected) => {
    expect(numberInText(n, text)).toBe(expected);
  });
  it.each([[241, false], [320, false], [0.5, false], [33, false], [55, false]])('%d is not found (no partial matches)', (n, expected) => {
    expect(numberInText(n, text)).toBe(expected);
  });
  it('"5" is grounded by a standalone 5 but not by 5.5 alone', () => {
    expect(numberInText(5, 'Vdd 5.5 V')).toBe(false);
    expect(numberInText(5.5, 'Vdd 5.5 V')).toBe(true);
  });
  it('tolerates trailing zeros', () => {
    expect(numberInText(1.5, 'IDD 1.50 mA')).toBe(true);
  });
});

describe('groundMeasuredRow', () => {
  const src = 'Supply current Active 240 mA max 350 mA at 3.3 V';
  it('drops invented numbers and keeps printed ones', () => {
    const r = groundMeasuredRow({ parameter: 'Icc', min: 160, typ: 240, max: 350, supplyVoltageV: 3.3, unit: 'mA' }, src);
    expect(r?.typ).toBe(240);
    expect(r?.max).toBe(350);
    expect(r?.min).toBeUndefined();
  });
  it('returns null when nothing numeric is supported (a fully hallucinated row)', () => {
    expect(groundMeasuredRow({ parameter: 'Icc', min: 1.1, typ: 2.2, max: 3.3 }, 'no matching table here')).toBeNull();
  });
});

describe('cleanStrings', () => {
  it('removes placeholders, empties and nulls', () => {
    expect(cleanStrings({ type: 'I2C', maxRate: 'not specified', role: 'N/A', notes: '', pins: [], x: null })).toEqual({ type: 'I2C' });
  });
});

describe('extractOutline rejects footnotes and unit rows', () => {
  it('ignores sentence-footnotes and rows that start with a unit', () => {
    const o = extractOutline([
      {
        num: 5,
        text: '3 If VDD3P3_CPU is used to power VDD_SPI (see Section 2.5.2 Power Scheme), the voltage drop\n2.4 GHz Balun + Switch\n17 VDD3P3_CPU Power\n5.6 Current Consumption',
      },
    ]);
    expect(o.map((e) => e.number)).toEqual(['5.6']);
  });
});

describe('resolveMeasuredUnit', () => {
  const src = 'Supply current IDD 150 200 300 \u03bcA. Input range 3.0 3.3 3.6 V. Note: MIN NOM MAX UNIT header only 42';
  it('verifies a unit that follows the numbers', () => {
    expect(resolveMeasuredUnit({ min: 3, typ: 3.3, max: 3.6, unit: 'V' }, src).status).toBe('verified');
  });
  it('corrects mA -> µA when only µA follows the number (the ADS1115 1000x case)', () => {
    const r = resolveMeasuredUnit({ typ: 200, max: 300, unit: 'mA' }, src);
    expect(r.status).toBe('corrected');
    expect(r.row.unit).toBe('\u00b5A');
    expect(normalizeMeasuredRow(r.row).max).toBeCloseTo(0.3);
  });
  it('marks the row unverified when no unit in the family follows the number', () => {
    expect(resolveMeasuredUnit({ typ: 42, unit: 'mA' }, src).status).toBe('unverified');
  });
  it('does not treat the "A" inside "mA" or "µA" as amps', () => {
    expect(resolveMeasuredUnit({ typ: 200, unit: 'A' }, src).status).not.toBe('verified');
  });
  it('unknown-family units (LSB, Bits) verify by adjacency', () => {
    expect(resolveMeasuredUnit({ min: 7, max: 7, unit: 'LSB' }, 'DNL 7 7 LSB').status).toBe('verified');
  });
});

describe('normalizeMeasuredRow single value', () => {
  it('collapses one value copied into min/typ/max to a typ', () => {
    const r = normalizeMeasuredRow({ parameter: 'TX', min: 335, typ: 335, max: 335, unit: 'mA' });
    expect(r.typ).toBe(335);
    expect('min' in r).toBe(false);
    expect('max' in r).toBe(false);
  });
});

describe('resolveMeasuredUnit with column-header units (Espressif layout)', () => {
  const esp =
    'Table 5-7. Wi-Fi Current Consumption\nWork Mode Description Peak (mA)\nTX 802.11b, 1 Mbps, @21 dBm 335\n802.11g 285\n' +
    'Table 5-9. Current Consumption in Low-Power Modes\nMode Description Typ (\u03bcA)\nLight-sleep VDD_SPI powered down 130\nDeep-sleep RTC timer 5\n';
  it('verifies a bare-number row whose unit is the column header', () => {
    expect(resolveMeasuredUnit({ typ: 335, unit: 'mA' }, esp).status).toBe('verified');
  });
  it('corrects a row labelled mA when the header says µA', () => {
    const r = resolveMeasuredUnit({ typ: 130, unit: 'mA' }, esp);
    expect(r.status).toBe('corrected');
    expect(r.row.unit).toBe('\u00b5A');
    expect(normalizeMeasuredRow(r.row).typ).toBeCloseTo(0.13);
  });
});

describe('coerceNumericField', () => {
  it.each([[3.3, 3.3], ['3.3', 3.3], ['\u22120.3', -0.3], [' 12 ', 12]])('%p -> %p', (input, expected) => {
    expect(coerceNumericField(input)).toBe(expected);
  });
  it.each([['0.75 \u00d7 VDD'], ['VDD + 0.3'], [null], [undefined], [NaN], ['']])('%p -> undefined (field dropped, response kept)', (input) => {
    expect(coerceNumericField(input)).toBeUndefined();
  });
});

describe('matchesDatasheetFile', () => {
  it.each([
    ['DS_lsm6dsox.pdf', 'lsm6dsox', true],
    ['ds-lis2dh12.PDF', 'lis2dh12', true],
    ['ADXL345.pdf', 'adxl345', true],
    ['MAX30102 (1).pdf', 'max30102', true],
    ['MAX17048-MAX17049.pdf', 'max17048-max17049', true],
    ['DS_stm32h743vi.pdf', 'stm32wb55ce', false],
    ['lsm6dsox_extra_notes.pdf', 'lsm6ds', false],
    ['xlsm6dsox.pdf', 'lsm6dsox', false],
  ])('%s vs %s -> %s', (file, want, expected) => {
    expect(matchesDatasheetFile(file, want)).toBe(expected);
  });
});
