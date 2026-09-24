/**
 * Read-only report: scores the datasheet ingestion pipeline against the 20-item ingestion test
 * checklist across every component in the database.
 *
 *   npx tsx scripts/verify-ingestion.ts              # catalog summary
 *   npx tsx scripts/verify-ingestion.ts --part ADS1115   # one part, with sample values
 *
 * Only components ingested by the current pipeline (they carry _provenance.documentId) are scored;
 * components still holding data from an older run are listed separately so nothing is hidden.
 */
import { prisma } from '../src/db/prisma.js';

type Specs = Record<string, any>;
const has = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '' && !(typeof v === 'object' && Object.keys(v as object).length === 0));
// Deep, key-order-independent serialization. (A JSON.stringify key-array replacer would silently drop
// nested keys, making any two objects with the same top-level keys compare equal.)
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

const CANONICAL = new Set(['V', 'mA', 'MHz', 'ns', 'Ω', 'pF', 'mW', '°C']);
const CONVERTIBLE = /^[pnµμukmMG]?(?:A|V|W|F|Hz|s|Ω)$/;

const unitViolations = (s: Specs): number => {
  const units: string[] = [];
  for (const g of [s.recommendedOperating, s.absoluteMaxRatings]) for (const k of ['voltage', 'current', 'temperature']) if (g?.[k]?.unit) units.push(g[k].unit);
  for (const list of [s.dcCharacteristics, s.powerModes]) for (const r of list ?? []) if (r.unit) units.push(r.unit);
  for (const g of s.timing ?? []) for (const r of g.parameters ?? []) if (r.unit) units.push(r.unit);
  return units.filter((u) => CONVERTIBLE.test(u) && !CANONICAL.has(u)).length;
};

const rowsWithPage = (list: any[] | undefined) => (list ?? []).filter((r) => typeof r.sourcePage === 'number').length;

interface Check {
  n: string;
  name: string;
  test: (s: Specs) => boolean;
  note: string;
}

const CHECKS: Check[] = [
  { n: '1', name: 'Document identity (part, maker, title, revision)', test: (s) => has(s.documentTitle) && has(s._revision?.label ?? s._revision?.date), note: 'title needs a PDF Title; label needs "(Rev. X)" / printed rev' },
  { n: '1b', name: '  ... with a PRINTED revision date', test: (s) => s._revision?.dateSource === 'printed', note: 'not every maker prints one (Espressif prints a version, no date)' },
  { n: '2', name: 'Page structure (section outline)', test: (s) => has(s.sectionOutline), note: '' },
  { n: '2b', name: '  ... footnotes captured', test: (s) => has(s.footnotes), note: 'only "(n) text" style footnotes' },
  { n: '3', name: 'Pin data', test: (s) => has(s.pins), note: '' },
  { n: '4', name: 'Electrical limits (abs-max AND recommended, distinct)', test: (s) => has(s.absoluteMaxRatings) && has(s.recommendedOperating) && stable(s.absoluteMaxRatings) !== stable(s.recommendedOperating), note: '' },
  { n: '5', name: 'DC characteristics', test: (s) => has(s.dcCharacteristics), note: 'absent when the datasheet has no such table' },
  { n: '6', name: 'Timing characteristics', test: (s) => has(s.timing), note: 'absent for parts with no timing table (LDOs, passives...)' },
  { n: '7', name: 'Power data by mode', test: (s) => has(s.powerModes), note: 'absent when no consumption table exists' },
  { n: '8', name: 'Interfaces', test: (s) => has(s.interfaces), note: '' },
  { n: '9', name: 'Register maps', test: (s) => has(s.registers), note: 'only digital parts; MCU maps live in the TRM' },
  { n: '10', name: 'Package / mechanical', test: (s) => has(s.packages), note: '' },
  { n: '11', name: 'Ordering info (orderable SKUs)', test: (s) => has(s.orderingInfo?.orderableSkus), note: 'only if the datasheet has an ordering section' },
  { n: '14', name: 'Figure / table captions', test: (s) => has(s.figureCaptions), note: '' },
  { n: '15', name: 'Traceability (document id + per-section pages)', test: (s) => String(s._provenance?.documentId ?? '').startsWith('sha256:') && has(s._provenance?.sections), note: '' },
  { n: 'A1', name: 'Architect: features', test: (s) => has(s.features), note: '' },
  { n: 'A2', name: 'Architect: cautions / constraints', test: (s) => has(s.cautions), note: 'keyword heuristic' },
];

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${String(Math.round((n / d) * 100)).padStart(3)}%`);
const line = (label: string, n: number, d: number, note = '') => console.log(`${label.padEnd(58)} ${String(n).padStart(3)}/${String(d).padEnd(3)} ${pct(n, d)}  ${note}`);

const partArg = process.argv.includes('--part') ? process.argv[process.argv.indexOf('--part') + 1] : undefined;

const all = await prisma.component.findMany({ select: { id: true, partNumber: true, manufacturer: true, specs: true } });
const isNew = (s: Specs | null) => String(s?._provenance?.documentId ?? '').startsWith('sha256:');
const current = all.filter((c) => isNew(c.specs as Specs));
const legacy = all.filter((c) => !isNew(c.specs as Specs));

if (partArg) {
  const c = all.find((x) => x.partNumber?.toLowerCase() === partArg.toLowerCase());
  if (!c) {
    console.log(`No component "${partArg}"`);
    process.exit(1);
  }
  const s = (c.specs ?? {}) as Specs;
  console.log(`\n${c.partNumber} (${c.manufacturer}) — ${isNew(s) ? 'current pipeline' : 'LEGACY data (not re-ingested)'}\n`);
  for (const chk of CHECKS) console.log(`${chk.test(s) ? 'PASS' : 'miss'}  ${chk.n.padEnd(3)} ${chk.name}`);
  console.log('\nRevision      :', JSON.stringify(s._revision));
  console.log('Title         :', s.documentTitle);
  console.log('Abs max       :', JSON.stringify(s.absoluteMaxRatings));
  console.log('Recommended   :', JSON.stringify(s.recommendedOperating));
  console.log('Pins          :', s.pins?.length, JSON.stringify(s.pins?.slice(0, 2)));
  console.log('Power modes   :', JSON.stringify(s.powerModes?.slice(0, 3)));
  console.log('DC rows       :', s.dcCharacteristics?.length, JSON.stringify(s.dcCharacteristics?.slice(0, 2)));
  console.log('Timing        :', JSON.stringify(s.timing?.[0]?.parameters?.slice(0, 2)));
  console.log('Interfaces    :', JSON.stringify(s.interfaces?.slice(0, 2)));
  console.log('Registers     :', s.registers?.length, JSON.stringify(s.registers?.[0]));
  console.log('Packages      :', JSON.stringify(s.packages));
  console.log('SKUs          :', s.orderingInfo?.orderableSkus?.length, JSON.stringify(s.orderingInfo?.orderableSkus?.slice(0, 2)));
  console.log('Cautions      :', JSON.stringify(s.cautions?.slice(0, 2)));
  console.log('Provenance    :', JSON.stringify(s._provenance?.sections));
  console.log('Unit violations:', unitViolations(s));
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`\nCatalog: ${all.length} components — ${current.length} on the CURRENT pipeline, ${legacy.length} still LEGACY (not re-ingested; scored separately below)\n`);
console.log('── Spec-level checklist items (current-pipeline parts only) ──');
for (const chk of CHECKS) line(`${chk.n.padEnd(3)} ${chk.name}`, current.filter((c) => chk.test((c.specs ?? {}) as Specs)).length, current.length, chk.note);

const viol = current.reduce((n, c) => n + unitViolations((c.specs ?? {}) as Specs), 0);
const unverified = current.reduce((n, c) => {
  const s = (c.specs ?? {}) as Specs;
  return n + [...(s.dcCharacteristics ?? []), ...(s.timing ?? []).flatMap((g: any) => g.parameters ?? [])].filter((r: any) => r.unitUnverified).length;
}, 0);
console.log(`\n13  Units normalized: ${viol === 0 ? 'PASS' : 'FAIL'} — ${viol} rows still in a non-canonical unit (want 0); ${unverified} DC/timing rows flagged unitUnverified (info)`);

const pinRows = current.reduce((n, c) => n + ((c.specs as Specs)?.pins?.length ?? 0), 0);
const pinPaged = current.reduce((n, c) => n + rowsWithPage((c.specs as Specs)?.pins), 0);
const regRows = current.reduce((n, c) => n + ((c.specs as Specs)?.registers?.length ?? 0), 0);
const regPaged = current.reduce((n, c) => n + rowsWithPage((c.specs as Specs)?.registers), 0);
console.log(`15  Per-fact page attribution: pins ${pinPaged}/${pinRows}, registers ${regPaged}/${regRows} rows carry a real sourcePage`);

console.log('\n── Chunk-level items (all stored chunks) ──');
const [cs] = await prisma.$queryRaw<any[]>`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE page_number IS NOT NULL)::int AS paged,
         count(*) FILTER (WHERE chunk_metadata ? 'section')::int AS sectioned,
         count(*) FILTER (WHERE chunk_metadata ? 'documentId' AND chunk_metadata ? 'sourceUrl')::int AS traced,
         count(*) FILTER (WHERE chunk_metadata->>'isTable' = 'true')::int AS tables,
         count(*) FILTER (WHERE chunk_metadata->>'isTable' = 'true' AND chunk_metadata ? 'cells' AND chunk_metadata ? 'html')::int AS tables_full,
         count(*) FILTER (WHERE chunk_metadata->>'isTable' = 'true' AND (chunk_metadata->>'pageEnd')::int > page_number)::int AS tables_multipage,
         count(*) FILTER (WHERE length(chunk_text) < 150)::int AS tiny,
         round(avg(length(chunk_text)))::int AS avg_len
  FROM datasheet_chunks`;
line('2   Chunks with a real page number', cs.paged, cs.total, '(all ingested chunks, incl. legacy)');
line('2   Chunks with a section heading', cs.sectioned, cs.total, 'legacy chunks have none until re-ingested');
line('15  Chunks with document id + source URL', cs.traced, cs.total, 'legacy chunks have none until re-ingested');
line('19  Table chunks with BOTH cells and html', cs.tables_full, cs.tables);
console.log(`12  Tables merged across pages: ${cs.tables_multipage} multi-page tables stored`);
console.log(`18  Chunking: avg ${cs.avg_len} chars, ${cs.tiny}/${cs.total} under 150 chars (${pct(cs.tiny, cs.total).trim()}) — target avg near 800+, tiny share low`);

console.log('\n── Revision / conflict (16, 17) ──');
const acts = await prisma.$queryRaw<any[]>`SELECT action, count(*)::int n FROM audit_log WHERE action IN ('COMPONENT_REVISION_ARCHIVED','INGEST_REVISION_CONFLICT_SKIPPED','INGEST_REVISION_CONFLICT_UNRESOLVED') GROUP BY 1 ORDER BY 1`;
for (const a of acts) console.log(`    ${a.action.padEnd(38)} ${a.n}`);
const review = current.filter((c) => (c.specs as Specs)?._revision?.needsReview);
console.log(`    components flagged needsReview            ${review.length}${review.length ? ' → ' + review.map((c) => c.partNumber).join(', ') : ''}`);

console.log('\n── Failure bucket (20) — most recent ingestion failure per datasheet ──');
const fails = await prisma.$queryRaw<any[]>`
  SELECT DISTINCT ON (metadata->>'datasheetUrl') metadata->>'datasheetUrl' AS url, metadata->>'failureBucket' AS bucket, created_at
  FROM audit_log WHERE action = 'INGEST_DATASHEET_AUTOMATED' AND metadata->>'status' IN ('FAILED','SUCCESS')
  ORDER BY metadata->>'datasheetUrl', created_at DESC`;
const stillFailing = fails.filter((f) => f.bucket);
const byBucket: Record<string, number> = {};
for (const f of stillFailing) byBucket[f.bucket] = (byBucket[f.bucket] ?? 0) + 1;
console.log(Object.keys(byBucket).length ? Object.entries(byBucket).map(([b, n]) => `    ${b.padEnd(20)} ${n}`).join('\n') : '    none — every datasheet\'s latest attempt succeeded');

console.log('\n── Not yet on the current pipeline ──');
if (legacy.length === 0) console.log('    none');
else {
  const byMaker: Record<string, string[]> = {};
  for (const c of legacy) (byMaker[c.manufacturer ?? '?'] ??= []).push(c.partNumber ?? '?');
  for (const [m, parts] of Object.entries(byMaker)) console.log(`    ${m}: ${parts.length} — ${parts.join(', ')}`);
}
console.log('');
await prisma.$disconnect();
process.exit(0);
