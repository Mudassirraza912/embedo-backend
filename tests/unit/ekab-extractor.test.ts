import { describe, it, expect } from '@jest/globals';
import { extractCandidates, htmlToStructuredText, splitSentences } from '../../src/modules/ekab/scrape/ekab-extractor.js';

/** The scraper's extraction is deterministic: verbatim text + locator, never inferred values. */
describe('Track B deterministic candidate extraction', () => {
  it('finds upper-case requirement sentences and ignores lower-case words in an RFC-style document', () => {
    const text = [
      '1. Introduction',
      '',
      'The key words "MUST", "MUST NOT", "REQUIRED", "SHALL" in this document are to be interpreted as described in BCP 14.',
      '',
      '3.2. Message Format',
      '',
      'A sender MUST NOT generate a message larger than the negotiated size. Receivers should be lenient here in general practice.',
      'A server SHOULD send a response within the timeout configured by the client application.',
      '',
      '9. References',
      '',
      'Implementations MUST cite this reference in their documentation section always.',
    ].join('\n');
    const { candidates, stats } = extractCandidates([{ page: null, text }]);
    expect(stats.upperCaseConvention).toBe(true);
    expect(candidates.map((c) => [c.keyword, c.section])).toEqual([
      ['MUST NOT', '3.2 Message Format'],
      ['SHOULD', '3.2 Message Format'],
    ]);
    expect(candidates[0]!.excerpt).toBe('A sender MUST NOT generate a message larger than the negotiated size.');
    expect(candidates[0]!.locator).toBe('§ 3.2 Message Format');
    expect(candidates[0]!.suggestedRecordType).toBe('CONSTRAINT');
  });

  it('uses lower-case keywords in application notes and suggests DESIGN_RULE for hardware sentences', () => {
    const text = 'Layout Guidelines\n\nThe bus must be terminated at both ends with a resistor matched to the cable impedance. This chapter describes the board.';
    const { candidates, stats } = extractCandidates([{ page: 4, text }]);
    expect(stats.upperCaseConvention).toBe(false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ keyword: 'MUST', suggestedRecordType: 'DESIGN_RULE', locator: 'p. 4' });
  });

  it('maps table rows to min/typ/max only when every column is present', () => {
    const text = [
      '7.3 Electrical Characteristics',
      'PARAMETER TEST CONDITIONS MIN TYP MAX UNIT',
      'Supply voltage VCC 4.5 5 5.5 V',
      'Differential output voltage RL = 54 Ω 1.5 2 V',
      'Supply current Idle, driver enabled – 0.9 1.4 mA',
    ].join('\n');
    const { candidates, stats } = extractCandidates([{ page: 6, text }]);
    expect(stats.ambiguousRowsSkipped).toBe(1); // only two values under three columns: not guessed
    expect(candidates.map((c) => c.values)).toEqual([
      { label: 'Supply voltage VCC', min: 4.5, typ: 5, max: 5.5, unit_original: 'V', columns: ['min', 'typ', 'max'] },
      { label: 'Supply current Idle, driver enabled', min: null, typ: 0.9, max: 1.4, unit_original: 'mA', columns: ['min', 'typ', 'max'] },
    ]);
    expect(candidates[0]!.locator).toBe('p. 6, § 7.3 Electrical Characteristics, table row');
  });

  it('never reads a reference number or an open condition as a table value', () => {
    // Seen on a real datasheet: "See Table 1" must not become min = 1.
    const text = ['8.6 Electrical Characteristics', 'PARAMETER MIN TYP MAX UNIT', 'VIT+ Positive-going input threshold voltage See Table 1 750 900 mV', 'Output current VOUT = 5 1 2 V'].join('\n');
    const { candidates, stats } = extractCandidates([{ page: 7, text }]);
    expect(candidates).toEqual([]);
    expect(stats.ambiguousRowsSkipped).toBe(2);
  });

  it('drops running page headers/footers but keeps similar requirement sentences', () => {
    const page = (n: number) => `Shelby, et al. Standards Track [Page ${n}]\n\nNode ${n} must acknowledge every confirmable message it receives.\n\nRFC 7252 CoAP June 2014`;
    const { candidates } = extractCandidates([1, 2, 3, 4].map((n) => ({ page: n, text: page(n) })));
    expect(candidates).toHaveLength(4);
    expect(candidates.every((c) => !/Standards Track|June 2014/.test(c.excerpt))).toBe(true);
  });

  it('skips legal and notice boilerplate', () => {
    const text = 'To minimize the risks associated with customer products and applications, customers should provide adequate design and operating safeguards.';
    expect(extractCandidates([{ page: 15, text }]).candidates).toEqual([]);
  });

  it('keeps abbreviations and decimals inside one sentence', () => {
    expect(splitSentences('Use e.g. a 4.7 kΩ resistor. Then stop.')).toEqual(['Use e.g. a 4.7 kΩ resistor.', 'Then stop.']);
  });

  it('dedupes repeated sentences and respects the candidate cap', () => {
    const line = 'The device must be powered from a regulated supply rail at all times.';
    const r = extractCandidates([{ page: 1, text: `${line}\n\n${line}` }]);
    expect(r.candidates).toHaveLength(1);
    expect(r.stats.duplicatesSkipped).toBe(1);
    const many = Array.from({ length: 10 }, (_, i) => `Rule ${i}: the host must send frame ${i} before the timeout expires.`).join('\n\n');
    const capped = extractCandidates([{ page: null, text: many }], { maxCandidates: 3 });
    expect(capped.candidates).toHaveLength(3);
    expect(capped.stats.truncated).toBe(true);
  });

  it('turns HTML into text with marked headings and decoded entities, dropping navigation', () => {
    const html =
      '<html><head><title>RFC 0000 &ndash; Test</title></head><body><nav>Home | Docs</nav><h2>4.1 Retries</h2><p>A client MUST retry at most 3&nbsp;times.</p><table><tr><td>a</td><td>b</td></tr></table></body></html>';
    const r = htmlToStructuredText(html);
    expect(r.title).toBe('RFC 0000 – Test');
    expect(r.text).toContain('## 4.1 Retries');
    expect(r.text).toContain('A client MUST retry at most 3 times.');
    expect(r.text).not.toContain('Home');
  });
});
