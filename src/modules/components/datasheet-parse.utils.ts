/**
 * Pure (no I/O, no AI) helpers for datasheet ingestion. Kept separate from the ingestion service so
 * they can be unit-tested directly and so the service file does not keep growing.
 */

export interface PageText {
  num: number;
  text: string;
}

/** Structural ToC detection — contents / list-of-tables pages are dominated by "title ... page" lines. */
export function isContentsPage(text: string): boolean {
  if (/table\s+of\s+contents/i.test(text)) return true;
  const numberedTocLine = /^\d+(?:[.-]\d+)+\s+\S[^\n]{1,90}\s+\d{1,3}\s*$/;
  let hits = 0;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.length > 3 && (numberedTocLine.test(l) || /\.{4,}\s*\d{1,3}\s*$/.test(l))) hits++;
  }
  return hits >= 6;
}

// ── Revision (#1 document identity, #17 chronology) ─────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const toIso = (year: number, monthName: string, day = 1): string | undefined => {
  const m = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (m === undefined || year < 1980 || year > 2100) return undefined;
  return new Date(Date.UTC(year, m, day)).toISOString();
};

/**
 * Reads the PRINTED revision label and publication date from the first pages. The PDF's own
 * ModDate is the date the file was exported, not when the revision was published (verified: a TI
 * datasheet "REVISED DECEMBER 2024" carried a 2026 ModDate), so it must not be used to decide which
 * revision is newer. Returns only what is actually printed; never guesses.
 */
export function parsePrintedRevision(pages: PageText[], maxPages = 3): { label?: string; date?: string } {
  const head = pages.slice(0, maxPages).map((p) => p.text).join('\n');
  let label: string | undefined;
  let date: string | undefined;

  // NXP: "Rev. 4 — 21 June 2019"
  let m = head.match(/\bRev\.?\s*([A-Za-z0-9.]+)\s*[—–-]\s*(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})/);
  if (m) {
    label = `Rev. ${m[1].toUpperCase()}`;
    date = toIso(Number(m[4]), m[3], Number(m[2]));
  }
  // ST: "DS12345 - Rev 3 - April 2019"
  if (!label) {
    m = head.match(/\bRev\.?\s*([A-Za-z0-9]+)\s*[-–—]\s*([A-Za-z]{3,9})\.?\s+(\d{4})/);
    if (m) {
      label = `Rev. ${m[1].toUpperCase()}`;
      date = toIso(Number(m[3]), m[2]);
    }
  }
  // ST, date-first layout: "January 2026   DS12110 Rev 11   1/357"
  if (!label) {
    m = head.match(/([A-Za-z]{3,9})\.?\s+(\d{4})\s+(?:DS|DocID)\d{4,6}\s+Rev\.?\s*([A-Za-z0-9]+)/);
    if (m) {
      label = `Rev. ${m[3].toUpperCase()}`;
      date = toIso(Number(m[2]), m[1]);
    }
  }
  // ST label without a nearby date: "DS12110 Rev 11"
  if (!label) {
    m = head.match(/\b(?:DS|DocID)\d{4,6}\s*[-–—]?\s*Rev\.?\s*([A-Za-z0-9]+)/);
    if (m) label = `Rev. ${m[1].toUpperCase()}`;
  }
  // Maxim: "19-7740; Rev 1; 10/18" (document number; revision; month/year)
  if (!label) {
    m = head.match(/\b19-\d{4};\s*Rev\.?\s*([A-Za-z0-9]+);\s*(\d{1,2})\/(\d{2})\b/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      label = `Rev. ${m[1].toUpperCase()}`;
      date = new Date(Date.UTC(2000 + Number(m[3]), Number(m[2]) - 1, 1)).toISOString();
    }
  }
  // TI: "MAY 2009 – REVISED DECEMBER 2024" (the REVISED date is the revision's publication date)
  if (!date) {
    m = head.match(/revised\s+([A-Za-z]{3,9})\.?\s+(\d{4})/i);
    if (m) date = toIso(Number(m[2]), m[1]);
  }
  // Espressif: "ESP32-C3 Series Datasheet v2.4"
  if (!label) {
    m = head.match(/datasheet\s+v(\d+(?:\.\d+)+)/i);
    if (m) label = `v${m[1]}`;
  }
  // ADI / generic: "Rev. B" on the cover
  if (!label) {
    m = head.match(/\bRev\.?\s+([A-Z])\b/);
    if (m) label = `Rev. ${m[1]}`;
  }
  return { ...(label ? { label } : {}), ...(date ? { date } : {}) };
}

export interface RevisionInfo {
  label?: string;
  date?: string;
  dateSource?: 'printed' | 'pdf-metadata';
  fileDate?: string;
  title?: string;
}

/** Only a PRINTED date may decide chronology; a file-export date is not evidence of revision order. */
export const trustedRevisionDate = (r?: RevisionInfo | null): number | undefined => {
  if (!r?.date || r.dateSource !== 'printed') return undefined;
  const t = Date.parse(r.date);
  return Number.isNaN(t) ? undefined : t;
};

// ── Section outline + footnotes (#2) ────────────────────────────────────────────────────────────

export interface OutlineEntry {
  number: string;
  title: string;
  level: number;
  page: number;
}

export function extractOutline(pages: PageText[], cap = 500): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const heading = /^(\d+(?:\.\d+){0,3})\s+([A-Z][^\n]{2,90})$/;
  for (const page of pages) {
    if (isContentsPage(page.text)) continue;
    for (const raw of page.text.split('\n')) {
      const line = raw.trim();
      const m = heading.exec(line);
      if (!m) continue;
      const title = m[2].trim();
      // Table rows also start with "1 Something ..." — reject titles carrying several bare numbers,
      // trailing page numbers, or dotted leaders.
      const numericTokens = title.split(/\s+/).filter((t) => /^[-–−]?\d+(?:\.\d+)?$/.test(t)).length;
      const level = m[1].split('.').length;
      // Reject page furniture and table rows that merely start with a number: footers
      // ("6 Submit Document Feedback Copyright © 2024 ..."), pin rows ("5 AIN1 6 AIN2"), dotted
      // leaders, and level-1 "headings" carrying any bare number. A real heading has a lowercase word.
      if (
        /submit\s+document\s+feedback|copyright|©|product\s+folder|www\./i.test(title) ||
        // sentences/footnotes ("3 If VDD3P3_CPU is used to power ... (see Section 2.5.2 ...)")
        title.length > 70 ||
        /\(see\s|\b(?:is|are|should|must|shall|can|will)\b/.test(title) ||
        // a unit in first position means a table row ("2.4 GHz Balun +"), not a heading
        /^(?:[kMG]?Hz|[mµu]?[VAWFΩ]|mm|dB\w*|°C|ns|[mµu]s|bits?)\b/.test(title) ||
        (level === 1 && (Number(m[1]) > 20 || /_/.test(title))) ||
        numericTokens >= 2 ||
        (level === 1 && numericTokens >= 1) ||
        /\.{3,}/.test(title) ||
        /\s\d{1,3}$/.test(title) ||
        !/[a-z]{3,}/.test(title)
      ) {
        continue;
      }
      const prev = out[out.length - 1];
      if (prev && prev.number === m[1] && prev.title === title) continue;
      out.push({ number: m[1], title, level, page: page.num });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** The section a page belongs to: the last heading at or before it. */
export function sectionForPage(outline: OutlineEntry[], page: number): string | undefined {
  let found: OutlineEntry | undefined;
  for (const e of outline) {
    if (e.page <= page) found = e;
    else break;
  }
  return found ? `${found.number} ${found.title}` : undefined;
}

/** The heading on `page` that matches `re` (e.g. "5.1 Absolute Maximum Ratings"), when there is one. */
export function sectionMatching(outline: OutlineEntry[], page: number, re: RegExp): string | undefined {
  const e = outline.find((o) => o.page === page && re.test(o.title));
  return e ? `${e.number} ${e.title}` : undefined;
}

export function extractFootnotes(pages: PageText[], cap = 300): Array<{ marker: string; text: string; page: number }> {
  const out: Array<{ marker: string; text: string; page: number }> = [];
  for (const page of pages) {
    if (isContentsPage(page.text)) continue;
    for (const m of page.text.matchAll(/^\((\d{1,2})\)\s+([A-Za-z].{15,400})$/gm)) {
      out.push({ marker: m[1], text: m[2].trim(), page: page.num });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

// ── Features + cautions/constraints (Architect Mode entities) ───────────────────────────────────

export function extractFeatures(pages: PageText[], cap = 40): string[] {
  for (const page of pages.slice(0, 3)) {
    if (isContentsPage(page.text)) continue;
    const lines = page.text.split('\n').map((l) => l.trim());
    const start = lines.findIndex((l) => /^\d*\s*features\s*$/i.test(l));
    if (start === -1) continue;
    const bullets: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\d+\s+[A-Z][A-Za-z ,/&-]{2,40}$/.test(line) && bullets.length > 0) break; // next numbered section
      if (/^[•·▪◦]\s*/.test(line)) bullets.push(line.replace(/^[•·▪◦]\s*/, ''));
      else if (/^[–-]\s+/.test(line) && bullets.length) bullets.push(line);
      else if (line.length > 0 && bullets.length > 0 && !/^www\./i.test(line)) bullets[bullets.length - 1] += ` ${line}`;
      if (bullets.length >= cap) break;
    }
    const cleaned = bullets.map((b) => b.replace(/\s+/g, ' ').trim().slice(0, 240)).filter((b) => b.length > 3);
    if (cleaned.length > 0) return cleaned;
  }
  return [];
}

const STRONG_CAUTION = /\b(warning|caution|never|do not|must not|permanent damage|not recommended)\b/i;
const WEAK_CAUTION = /\b(should not|must be (?:connected|tied|grounded|pulled|left|placed)|shall be|is required to|are required to)\b/i;

/** Deterministic sentence scan — a heuristic list of design constraints, each with its real page. */
export function extractCautions(pages: PageText[], cap = 40): Array<{ text: string; page: number }> {
  const scored: Array<{ text: string; page: number; score: number }> = [];
  const seen = new Set<string>();
  for (const page of pages) {
    if (isContentsPage(page.text)) continue;
    const flat = page.text.replace(/\n(?!\n)/g, ' ').replace(/\s+/g, ' ');
    for (const sentence of flat.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const s = sentence.trim();
      if (s.length < 30 || s.length > 320 || /\.{4,}/.test(s)) continue;
      const strong = STRONG_CAUTION.test(s);
      if (!strong && !WEAK_CAUTION.test(s)) continue;
      const key = s.toLowerCase().slice(0, 90);
      if (seen.has(key)) continue;
      seen.add(key);
      scored.push({ text: s, page: page.num, score: strong ? 2 : 1 });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .slice(0, cap)
    .map(({ text, page }) => ({ text, page }));
}

// ── Per-fact page attribution (#15) ─────────────────────────────────────────────────────────────

/** The real page inside [start,end] whose text contains the needle, or undefined. */
export function attributePage(pages: PageText[], range: [number, number] | undefined, needle: string | null | undefined): number | undefined {
  if (!range || !needle || needle.trim().length < 2) return undefined;
  const n = needle.trim().toLowerCase();
  return pages.find((p) => p.num >= range[0] && p.num <= range[1] && p.text.toLowerCase().includes(n))?.num;
}

// ── Revision diff (#17: detect disagreement between revisions) ──────────────────────────────────

const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};

const TRACKED_LIMIT_KEYS = ['recommendedOperating', 'absoluteMaxRatings', 'packages'] as const;

/** Compares the fields whose disagreement matters between two revisions of the same part. */
export function diffTrackedSpecs(previous: unknown, current: unknown): Array<{ field: string; previous: string; current: string }> {
  const a = (previous ?? {}) as Record<string, unknown>;
  const b = (current ?? {}) as Record<string, unknown>;
  const out: Array<{ field: string; previous: string; current: string }> = [];
  for (const k of TRACKED_LIMIT_KEYS) {
    if (a[k] === undefined || b[k] === undefined) continue; // a field newly added/removed is not a disagreement
    if (stable(a[k]) !== stable(b[k])) out.push({ field: k, previous: stable(a[k]).slice(0, 300), current: stable(b[k]).slice(0, 300) });
  }
  const pa = Array.isArray(a.pins) ? a.pins.length : undefined;
  const pb = Array.isArray(b.pins) ? b.pins.length : undefined;
  if (pa !== undefined && pb !== undefined && pa !== pb) out.push({ field: 'pins.count', previous: String(pa), current: String(pb) });
  return out;
}

// ── Units across every table (#13) ──────────────────────────────────────────────────────────────

type Quantity = 'voltage' | 'current' | 'frequency' | 'time' | 'resistance' | 'capacitance' | 'power' | 'temperature';
const CANONICAL: Record<Quantity, string> = {
  voltage: 'V',
  current: 'mA',
  frequency: 'MHz',
  time: 'ns',
  resistance: 'Ω',
  capacitance: 'pF',
  power: 'mW',
  temperature: '°C',
};
const FACTORS: Record<string, [Quantity, number]> = {
  v: ['voltage', 1], mv: ['voltage', 1e-3], µv: ['voltage', 1e-6], uv: ['voltage', 1e-6], kv: ['voltage', 1e3],
  a: ['current', 1e3], ma: ['current', 1], µa: ['current', 1e-3], ua: ['current', 1e-3], na: ['current', 1e-6], pa: ['current', 1e-9],
  hz: ['frequency', 1e-6], khz: ['frequency', 1e-3], mhz: ['frequency', 1], ghz: ['frequency', 1e3],
  ps: ['time', 1e-3], ns: ['time', 1], µs: ['time', 1e3], us: ['time', 1e3], ms: ['time', 1e6], s: ['time', 1e9],
  pf: ['capacitance', 1], nf: ['capacitance', 1e3], µf: ['capacitance', 1e6], uf: ['capacitance', 1e6], mf: ['capacitance', 1e9],
  mw: ['power', 1], w: ['power', 1e3], µw: ['power', 1e-3], uw: ['power', 1e-3],
};
const round = (n: number) => Number(n.toPrecision(12));

/**
 * Converts a value to its canonical unit, preserving what was printed. Case matters for resistance
 * (mΩ vs MΩ vs kΩ) and Kelvin, so those are handled before lowercasing. Unrecognized units are
 * returned unchanged rather than guessed.
 */
export function normalizeQuantity(value: number, rawUnit: string | null | undefined): { value: number; unit: string; printedUnit?: string; converted: boolean } {
  if (!rawUnit) return { value, unit: '', converted: false };
  const printed = rawUnit.trim();
  const u = printed.replace(/μ/g, 'µ').replace(/Ω/g, 'Ω').replace(/\s+/g, '');

  if (/(?:Ω|ohms?)$/i.test(u)) {
    const prefix = u.replace(/(?:Ω|ohms?)$/i, '');
    const f = prefix === '' ? 1 : prefix === 'k' || prefix === 'K' ? 1e3 : prefix === 'M' ? 1e6 : prefix === 'm' ? 1e-3 : undefined;
    if (f !== undefined) return { value: round(value * f), unit: 'Ω', ...(u !== 'Ω' ? { printedUnit: printed } : {}), converted: f !== 1 };
  }
  if (u === 'K') return { value: round(value - 273.15), unit: '°C', printedUnit: printed, converted: true };
  const lower = u.toLowerCase().replace(/^°/, '');
  if (lower === 'c' || lower === '℃') return { value, unit: '°C', converted: false };
  if (lower === 'f' || lower === '℉') return { value: round((value - 32) * (5 / 9)), unit: '°C', printedUnit: printed, converted: true };

  const hit = FACTORS[lower.replace(/μ/g, 'µ')];
  if (!hit) return { value, unit: printed, converted: false };
  const [q, factor] = hit;
  return { value: round(value * factor), unit: CANONICAL[q], ...(CANONICAL[q] !== printed ? { printedUnit: printed } : {}), converted: factor !== 1 };
}

export interface MeasuredRow {
  min?: number | null;
  typ?: number | null;
  max?: number | null;
  unit?: string | null;
  printedUnit?: string;
  [k: string]: unknown;
}

/** Normalizes min/typ/max to canonical units, fixes transposed min/max, drops a typ that just copies a limit. */
export function normalizeMeasuredRow<T extends MeasuredRow>(row: T): T {
  const out: MeasuredRow = { ...row };
  // Models emit "" for fields they have nothing for; an empty string is not data.
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === 'string' && v.trim() === '') delete out[key];
  }
  let unit = row.unit ?? undefined;
  let printed: string | undefined;
  for (const k of ['min', 'typ', 'max'] as const) {
    const v = row[k];
    if (v == null) {
      delete out[k];
      continue;
    }
    const n = normalizeQuantity(v, row.unit);
    out[k] = n.value;
    if (n.unit) unit = n.unit;
    if (n.printedUnit) printed = n.printedUnit;
  }
  if (unit) out.unit = unit;
  if (printed) out.printedUnit = printed;
  // A single printed value copied into min, typ and max is one value, not a range: keep it as typ.
  if (out.min != null && out.min === out.typ && out.typ === out.max) {
    delete out.min;
    delete out.max;
  }
  if (out.min != null && out.max != null && out.min > out.max) [out.min, out.max] = [out.max, out.min];
  if (out.typ != null && out.min != null && out.max != null && out.min !== out.max && (out.typ === out.max || out.typ === out.min)) delete out.typ;
  return out as T;
}

const PLACEHOLDER = /^(?:not\s+specified|not\s+stated|not\s+applicable|n\/?a|unknown|none|null|undefined|—|–|-)$/i;

/** Removes empty and placeholder strings ("not specified", "N/A") — absence, not data. */
export function cleanStrings<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === 'string' && (v.trim() === '' || PLACEHOLDER.test(v.trim()))) delete out[key];
    else if (v === null) delete out[key];
    else if (Array.isArray(v) && v.length === 0) delete out[key];
  }
  return out as T;
}

// ── Grounding guard: a number must literally appear in the source it was extracted from ─────────

/**
 * True when the number is printed in the text (sign-insensitive, since some PDFs drop minus glyphs;
 * thousands separators and trailing zeros tolerated; "5" does not match inside "5.5"). This is the
 * defense against a model inventing plausible-looking values when a section is absent or partial.
 */
const numberPatterns = (n: number): string[] => {
  const abs = Math.abs(n);
  const forms = new Set<string>();
  for (const f of [String(abs), abs.toFixed(1), abs.toFixed(2), abs.toFixed(3), abs.toFixed(4)]) {
    forms.add(f.includes('.') ? f.replace(/0+$/, '').replace(/\.$/, '') : f);
  }
  const guard = '(?![\\d]|\\.\\d)';
  const out: string[] = [];
  for (const f of forms) {
    if (!f) continue;
    const esc = f.replace('.', '\\.');
    const tail = f.includes('.') ? '0*' : '(?:\\.0+)?';
    out.push(`(?<![\\d.])${esc}${tail}${guard}`);
    if (f.startsWith('0.')) out.push(`(?<![\\d])${f.slice(1).replace('.', '\\.')}0*${guard}`); // ".15"
  }
  return out;
};

export function numberInText(n: number, text: string): boolean {
  if (!Number.isFinite(n)) return false;
  const flat = text.replace(/(\d),(\d{3})/g, '$1$2');
  return numberPatterns(n).some((src) => new RegExp(src).test(flat));
}

// ── Unit verification: the printed unit must follow the number in the source ────────────────────

const UNIT_FAMILIES: string[][] = [
  ['nA', '\u00b5A', 'mA', 'A'],
  ['\u00b5V', 'mV', 'V', 'kV'],
  ['Hz', 'kHz', 'MHz', 'GHz'],
  ['ps', 'ns', '\u00b5s', 'ms', 's'],
  ['\u00b5W', 'mW', 'W'],
  ['pF', 'nF', '\u00b5F'],
  ['m\u03a9', '\u03a9', 'k\u03a9', 'M\u03a9'],
];

const escapeRe = (u: string) => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\u00b5/g, '[\u00b5\u03bcu]');
const unitPattern = (unit: string) => `(?<![A-Za-z\u00b5\u03bc])${escapeRe(unit)}(?![A-Za-z\u00b5\u03bc])`;

const occurrences = (n: number, flat: string): Array<{ start: number; end: number }> => {
  const seen = new Set<number>();
  const out: Array<{ start: number; end: number }> = [];
  for (const src of numberPatterns(n)) {
    for (const m of flat.matchAll(new RegExp(src, 'g'))) {
      const start = m.index ?? 0;
      if (seen.has(start)) continue;
      seen.add(start);
      out.push({ start, end: start + m[0].length });
      if (out.length >= 20) return out;
    }
  }
  return out;
};

/**
 * Which unit does the source attach to this number? Two layouts are common: the unit follows the
 * number in the row ("3.0 3.3 3.6 V"), or it is printed once in the column header ("Typ (µA)",
 * "Peak (mA)") and the rows carry bare numbers. Returns a vote per candidate unit.
 */
function unitVotes(nums: number[], units: string[], flat: string): Map<string, number> {
  const votes = new Map<string, number>();
  const vote = (u: string) => votes.set(u, (votes.get(u) ?? 0) + 1);
  for (const n of nums) {
    for (const { start, end } of occurrences(n, flat)) {
      const after = flat.slice(end, end + 45);
      let best: { unit: string; at: number } | undefined;
      for (const u of units) {
        const m = new RegExp(`^[^A-Za-z]{0,30}?${unitPattern(u)}`).exec(after);
        if (m && (!best || m[0].length < best.at)) best = { unit: u, at: m[0].length };
      }
      if (best) {
        vote(best.unit);
        continue;
      }
      const before = flat.slice(Math.max(0, start - 900), start);
      let header: { unit: string; at: number } | undefined;
      for (const u of units) {
        let at = -1;
        for (const m of before.matchAll(new RegExp(`\\(\\s*${escapeRe(u)}\\s*\\)`, 'g'))) at = m.index ?? at;
        if (at >= 0 && (!header || at > header.at)) header = { unit: u, at };
      }
      if (header) vote(header.unit);
    }
  }
  return votes;
}

/**
 * A grounded NUMBER can still carry the wrong UNIT (verified: the ADS1115 supply current is printed
 * in µA and the model labelled it mA — a 1000x error). The unit must be the one the source attaches
 * to the number (adjacent, or the nearest column header); when the printed unit gets no support and
 * exactly one other unit of the same family does, that unit is used. Otherwise the row is 'unverified'.
 */
export function resolveMeasuredUnit<T extends MeasuredRow>(row: T, sourceText: string): { row: T; status: 'verified' | 'corrected' | 'unverified' } {
  const printed = (row.unit ?? '').trim().replace(/\u03bc/g, '\u00b5');
  const nums = (['min', 'typ', 'max'] as const).map((k) => row[k]).filter((v): v is number => typeof v === 'number');
  if (!printed || nums.length === 0) return { row, status: 'unverified' };
  const flat = sourceText.replace(/(\d),(\d{3})/g, '$1$2');
  const family = UNIT_FAMILIES.find((f) => f.includes(printed)) ?? [printed];
  const votes = unitVotes(nums, family, flat);
  if ((votes.get(printed) ?? 0) > 0) return { row, status: 'verified' };
  const alternatives = [...votes.keys()].filter((u) => u !== printed);
  if (alternatives.length === 1) return { row: { ...row, unit: alternatives[0], unitCorrectedFrom: printed }, status: 'corrected' };
  return { row, status: 'unverified' };
}

/**
 * Drops any min/typ/max (and supplyVoltageV) that is not printed in the source text; returns null
 * when nothing numeric survives. Applied BEFORE unit normalization, to the numbers as printed.
 */
export function groundMeasuredRow<T extends MeasuredRow>(row: T, sourceText: string): T | null {
  const out: MeasuredRow = { ...row };
  for (const k of ['min', 'typ', 'max', 'supplyVoltageV'] as const) {
    const v = out[k];
    if (typeof v === 'number' && !numberInText(v, sourceText)) delete out[k];
  }
  return out.min == null && out.typ == null && out.max == null ? null : (out as T);
}

/**
 * Coerces a model-emitted numeric field: numbers pass; numeric strings ("3.3", "–0.3") are parsed;
 * anything else (null, "0.75 × VDD", "VDD + 0.3") becomes undefined for that field only.
 */
export function coerceNumericField(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const t = v.trim().replace(/[\u2013\u2212]/g, '-');
    return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : undefined;
  }
  return undefined;
}

/**
 * Does a saved file correspond to the datasheet whose URL filename is `wantedBase` (no extension)?
 * Tolerates what browsers and manufacturers do to filenames: ST prefixes "DS_", browsers add
 * " (1)" for repeats, case differs.
 */
export function matchesDatasheetFile(fileName: string, wantedBase: string): boolean {
  const norm = (n: string) => n.toLowerCase().replace(/\.pdf$/, '').replace(/^ds[_-]/, '').trim();
  const f = norm(fileName);
  const w = norm(wantedBase);
  return f === w || f.startsWith(`${w} (`) || f.startsWith(`${w}_`) || f.startsWith(`${w}-rev`);
}
