/**
 * Deterministic candidate extraction for the Track B source scraper. No AI: every candidate is
 * text that literally appears in the document, with the page/section it came from. Two kinds:
 *  - normative_sentence: a sentence carrying a requirement keyword (RFC 2119 / 8174 style). When a
 *    document uses the upper-case convention, only upper-case keywords count.
 *  - parameter_row: a row of a specification table ("Min Typ Max Unit" header) whose number of
 *    values matches the header exactly. A row with missing cells is skipped, never guessed
 *    (contract §8: do not infer missing min/typ/max values).
 * A reviewer turns candidates into records; nothing here decides engineering meaning.
 */

export interface DocPage {
  /** 1-based PDF page; null for HTML/plain text. */
  page: number | null;
  text: string;
}

export interface ParameterValues {
  label: string;
  min: number | null;
  typ: number | null;
  max: number | null;
  unit_original: string;
  columns: string[];
}

export interface ExtractedCandidate {
  kind: 'normative_sentence' | 'parameter_row';
  keyword: string | null;
  locator: string;
  section: string | null;
  excerpt: string;
  values: ParameterValues | null;
  suggestedRecordType: string;
}

export interface ExtractionStats {
  pages: number;
  sentencesScanned: number;
  normative: number;
  parameterRows: number;
  ambiguousRowsSkipped: number;
  duplicatesSkipped: number;
  truncated: boolean;
  upperCaseConvention: boolean;
}

const UPPER_KEYWORDS = /\b(MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED|SHOULD NOT|SHOULD|NOT RECOMMENDED|RECOMMENDED)\b/;
const LOWER_KEYWORDS = /\b(must not|must|shall not|shall|should not|should|is required|are required|it is recommended|is recommended|are recommended|is not recommended)\b/i;
const KEYWORD_RANK = ['MUST NOT', 'SHALL NOT', 'MUST', 'SHALL', 'REQUIRED', 'SHOULD NOT', 'NOT RECOMMENDED', 'SHOULD', 'RECOMMENDED'];

/** Sections that are publication boilerplate, not engineering content. */
const SKIP_SECTION = /status of this memo|copyright notice|table of contents|^contents$|acknowledg|^references$|normative references|informative references|authors?'? addresses|iana considerations|revision history|legal|disclaimer|trademarks?|important notice/i;
const BOILERPLATE_SENTENCE =
  /"MUST"|key words .* are to be interpreted|BCP ?14|copyright|all rights reserved|this document is subject to|trust legal provisions|internet-draft|warrant|liabilit|indemnif|intellectual property|terms of (sale|use)|customers? (should|must|are) .*(safeguards|responsible|solely)|is provided "as is"|important notice|export control/i;

const HARDWARE_WORDS = /\b(resistors?|capacitors?|terminat\w*|pull-?ups?|pull-?downs?|traces?|layout|PCB|ground(ing)?|decoupl\w*|bypass|ferrite|inductors?|TVS|ESD|shield\w*|impedance|cables?|connectors?|stub|twisted pair)\b/i;

const UNITS = [
  'V', 'mV', 'µV', 'uV', 'kV', 'Vpp', 'mVpp', 'A', 'mA', 'µA', 'uA', 'nA', 'Ω', 'kΩ', 'MΩ', 'ohm', 'ohms', 'W', 'mW', 'µW', 'Hz', 'kHz', 'MHz', 'GHz',
  's', 'ms', 'µs', 'us', 'ns', 'ps', '°C', 'pF', 'nF', 'µF', 'uF', 'nH', 'µH', 'uH', 'dB', 'dBm', 'bps', 'kbps', 'Mbps', 'bit/s', 'kbit/s', 'Mbit/s', '%', 'ppm', 'LSB', 'V/µs', 'V/us',
];
const UNIT_RE = UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
const NUM = '[-−+]?\\d+(?:\\.\\d+)?';
const REFERENCE_TAIL = /(\b(table|figure|fig\.?|note|notes|section|equation|eq\.?|see|at|to|from|of|with|per|and|or|pin|pins)|[=<>≤≥±~(,])$/i;
const CELL = `(?:${NUM}|[–—-])`;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
/** "29", "Page 29", "29 of 43", "- 29 -": page numbers, never content. */
const PAGE_NUMBER_LINE = /^\s*[-–]?\s*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*[-–]?\s*$/i;
const toNumber = (cell: string): number | null => (/^[–—-]$/.test(cell) ? null : Number(cell.replace('−', '-')));

/** "3.2.1 Bus termination" / "3.2.1. Bus termination" — short title-case lines with a section number. */
const NUMBERED_HEADING = /^(\d{1,2}(?:\.\d{1,3}){0,4})\.?\s{1,4}([A-Z][^.!?]{1,90})$/;

function headingOf(line: string): string | null {
  const t = line.trim();
  if (t.startsWith('## ')) return clean(t.slice(3)) || null;
  const m = NUMBERED_HEADING.exec(t);
  // A numbered list item ("2. In a piggybacked response, the …") is not a heading: headings are
  // short and have no clause punctuation.
  if (m && m[2]!.split(/\s+/).length <= 10 && !/[,;]/.test(m[2]!) && !/\d\s*$/.test(m[2]!)) return `${m[1]} ${clean(m[2]!)}`;
  if (/^appendix [a-z0-9]+[.:]?\s+[A-Z]/i.test(t) && t.length <= 90) return clean(t);
  return null;
}

/** Column order from a table header line, e.g. ["min","typ","max"]; null when it is not one. */
function tableColumns(line: string): string[] | null {
  if (line.length > 200) return null;
  const tokens: Array<[string, number]> = [];
  for (const [key, re] of [
    ['min', /\bmin(?:imum)?\.?\b/i],
    ['typ', /\btyp(?:ical)?\.?\b|\bnom(?:inal)?\.?\b/i],
    ['max', /\bmax(?:imum)?\.?\b/i],
  ] as const) {
    const m = re.exec(line);
    if (m) tokens.push([key, m.index]);
  }
  if (!tokens.some(([k]) => k === 'min' || k === 'max') || tokens.length < 2) return null;
  return tokens.sort((a, b) => a[1] - b[1]).map(([k]) => k);
}

function parameterRow(line: string, columns: string[]): { values: ParameterValues } | { ambiguous: true } | null {
  const flat = clean(line.replace(/\|/g, ' '));
  const unitMatch = new RegExp(`\\s(${UNIT_RE})$`).exec(flat);
  if (!unitMatch) return null;
  const beforeUnit = flat.slice(0, unitMatch.index);
  const cells = new RegExp(`(?:\\s(${CELL}))+$`).exec(beforeUnit);
  if (!cells) return null;
  const values = cells[0].trim().split(/\s+/);
  const label = clean(beforeUnit.slice(0, cells.index));
  if (!/[A-Za-z]{3}/.test(label) || label.length > 160) return null;
  if (values.length !== columns.length) return { ambiguous: true };
  // "… See Table 1 750 900 mV": the first number belongs to a reference or an open condition
  // ("= 5", "at", "to"), not to the min column. Such rows are never mapped.
  if (REFERENCE_TAIL.test(label)) return { ambiguous: true };
  const out: ParameterValues = { label, min: null, typ: null, max: null, unit_original: unitMatch[1]!, columns };
  columns.forEach((col, i) => {
    out[col as 'min' | 'typ' | 'max'] = toNumber(values[i]!);
  });
  if (out.min === null && out.typ === null && out.max === null) return null;
  return { values: out };
}

function strongestKeyword(sentence: string, upperOnly: boolean): string | null {
  const found = new Set<string>();
  const upper = new RegExp(UPPER_KEYWORDS.source, 'g');
  for (const m of sentence.matchAll(upper)) found.add(m[1]!);
  if (!upperOnly) {
    const lower = new RegExp(LOWER_KEYWORDS.source, 'gi');
    for (const m of sentence.matchAll(lower)) {
      const k = m[1]!.toLowerCase();
      found.add(
        k.includes('not recommended') ? 'NOT RECOMMENDED' : k.includes('recommended') ? 'RECOMMENDED' : k.includes('required') ? 'REQUIRED' : k.toUpperCase()
      );
    }
  }
  return KEYWORD_RANK.find((k) => found.has(k)) ?? null;
}

const suggestType = (keyword: string, sentence: string) =>
  HARDWARE_WORDS.test(sentence) ? 'DESIGN_RULE' : /MUST|SHALL|REQUIRED/.test(keyword) ? 'CONSTRAINT' : 'RULE';

/** Sentences of a paragraph (keeps "e.g." / "i.e." / decimal numbers / "Fig. 3" intact). */
export function splitSentences(paragraph: string): string[] {
  const protectedText = paragraph.replace(/\b(e\.g|i\.e|etc|vs|Fig|Figs|Eq|No|approx|min|max|typ|Sec|Ref)\./gi, (m) => m.replace('.', ''));
  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z("“[])/)
    .map((s) => clean(s.replace(//g, '.')))
    .filter(Boolean);
}

export function extractCandidates(pages: DocPage[], options: { maxCandidates?: number } = {}): { candidates: ExtractedCandidate[]; stats: ExtractionStats } {
  const max = options.maxCandidates ?? 400;
  const all = pages.map((p) => p.text).join('\n');
  // RFC 8174: when a document uses the upper-case convention, lower-case words are ordinary English.
  const upperCaseConvention = (all.match(new RegExp(UPPER_KEYWORDS.source, 'g')) ?? []).length >= 3;
  const stats: ExtractionStats = { pages: pages.length, sentencesScanned: 0, normative: 0, parameterRows: 0, ambiguousRowsSkipped: 0, duplicatesSkipped: 0, truncated: false, upperCaseConvention };
  const candidates: ExtractedCandidate[] = [];
  const seen = new Set<string>();
  // Running headers/footers ("Shelby, et al. Standards Track [Page 12]", "www.ti.com") repeat on
  // every page; dropped so they never split or pollute a sentence.
  // A line with a requirement keyword is never treated as one.
  const shape = (line: string) => clean(line).replace(/\d+/g, '#');
  const seenOn = new Map<string, { count: number; pages: Set<number> }>();
  pages.forEach((p, index) => {
    for (const line of p.text.split('\n')) {
      const key = shape(line);
      if (key.length < 8 || key.length > 140) continue;
      const entry = seenOn.get(key) ?? { count: 0, pages: new Set<number>() };
      entry.count += 1;
      entry.pages.add(index);
      seenOn.set(key, entry);
    }
  });
  const isRunningLine = (line: string) => {
    const entry = seenOn.get(shape(line));
    if (!entry || UPPER_KEYWORDS.test(line) || LOWER_KEYWORDS.test(line)) return false;
    return pages.length > 1 ? entry.pages.size >= 3 : entry.count >= 4;
  };
  let section: string | null = null;
  let paragraphIndex = 0;

  const locatorOf = (page: number | null) =>
    [page !== null ? `p. ${page}` : null, section ? `§ ${section}` : null, page === null && !section ? `paragraph ${paragraphIndex}` : null].filter(Boolean).join(', ');
  const push = (c: ExtractedCandidate) => {
    const key = c.excerpt.toLowerCase();
    if (seen.has(key)) {
      stats.duplicatesSkipped += 1;
      return;
    }
    if (candidates.length >= max) {
      stats.truncated = true;
      return;
    }
    seen.add(key);
    candidates.push(c);
    if (c.kind === 'parameter_row') stats.parameterRows += 1;
    else stats.normative += 1;
  };

  for (const p of pages) {
    let buffer: string[] = [];
    let columns: string[] | null = null;
    let tableLinesLeft = 0;

    const flush = () => {
      if (buffer.length === 0) return;
      const paragraph = buffer.join(' ').replace(/(\w)- (\w)/g, '$1$2');
      buffer = [];
      paragraphIndex += 1;
      if (section && SKIP_SECTION.test(section.replace(/^[\d.]+\s*/, ''))) return;
      for (const sentence of splitSentences(paragraph)) {
        stats.sentencesScanned += 1;
        if (sentence.length < 30 || sentence.length > 600 || BOILERPLATE_SENTENCE.test(sentence)) continue;
        const keyword = strongestKeyword(sentence, upperCaseConvention);
        if (!keyword) continue;
        push({ kind: 'normative_sentence', keyword, locator: locatorOf(p.page), section, excerpt: sentence, values: null, suggestedRecordType: suggestType(keyword, sentence) });
      }
    };

    for (const raw of p.text.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) {
        flush();
        continue;
      }
      if (isRunningLine(line) || PAGE_NUMBER_LINE.test(line)) continue;
      const heading = headingOf(line);
      if (heading) {
        flush();
        section = heading.slice(0, 200);
        columns = null;
        continue;
      }
      const header = tableColumns(line);
      if (header) {
        flush();
        columns = header;
        tableLinesLeft = 80;
        continue;
      }
      if (columns && tableLinesLeft > 0) {
        tableLinesLeft -= 1;
        const row = parameterRow(line, columns);
        if (row && 'ambiguous' in row) {
          stats.ambiguousRowsSkipped += 1;
          continue;
        }
        if (row) {
          flush();
          push({ kind: 'parameter_row', keyword: null, locator: `${locatorOf(p.page)}${locatorOf(p.page) ? ', ' : ''}table row`, section, excerpt: clean(line.replace(/\|/g, ' ')), values: row.values, suggestedRecordType: 'CONSTRAINT' });
          continue;
        }
      }
      buffer.push(line.trim());
    }
    flush();
  }
  return { candidates, stats };
}

// --- HTML to structured text ---------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', deg: '°', micro: 'µ', mu: 'µ', Omega: 'Ω', ohm: 'Ω', plusmn: '±', times: '×', le: '≤', ge: '≥', minus: '−', shy: '',
};
export const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n] ?? NAMED_ENTITIES[n.toLowerCase()] ?? m);

/** Inline markup is removed without a space, so "<a>4</a>. Title" stays "4. Title". */
const INLINE_TAG = /<\/?(a|span|b|strong|i|em|code|sup|sub|small|abbr|cite|q|u|s|mark|font|tt|var|samp|kbd)\b[^>]*>/gi;
const headingLine = (inner: string) => `\n\n## ${decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()}\n\n`;

/** Visible text of an HTML page with headings marked "## " so sections can be located. */
export function htmlToStructuredText(html: string): { title: string | null; text: string } {
  // <title>, else the first h1 (the "htmlized" RFC pages are a bare <pre> with <span class="h1">).
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ??
    /<span[^>]*class="h1"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1];
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe|template|head|nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner: string) => headingLine(inner))
      .replace(/<span[^>]*class="h[1-6]"[^>]*>([\s\S]*?)<\/span>/gi, (_, inner: string) => headingLine(inner))
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/table|\/section|\/pre|\/dd|\/dt)\b[^>]*>/gi, '\n')
      .replace(/<(p|div|li|tr|table|section|pre|dd|dt)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(INLINE_TAG, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title ? clean(decodeEntities(title.replace(/<[^>]+>/g, ' '))) || null : null, text };
}
