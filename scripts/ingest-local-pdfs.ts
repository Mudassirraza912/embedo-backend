/**
 * Ingest datasheets that could not be downloaded automatically (st.com / analog.com refuse
 * programmatic clients) from PDFs saved manually in a browser.
 *
 *   npm run ingest:local                      # list the PDFs still needed, with their source URLs
 *   npm run ingest:local -- ~/Downloads/ds    # ingest every matching PDF found in that folder
 *   npm run ingest:local -- ~/Downloads/ds --all   # also re-ingest components already on the current pipeline
 *
 * A component is "pending" when it has no current-pipeline data (no _provenance.documentId).
 * Files are matched by the source URL's filename (e.g. lsm6dsox.pdf); ST's "DS_" prefix and browser
 * suffixes such as "lsm6dsox (1).pdf" are tolerated. The recorded source URL stays the manufacturer's URL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../src/db/prisma.js';
import { datasheetIngestionService } from '../src/modules/components/datasheet-ingestion.service.js';
import { datasheetIngestQueue } from '../src/jobs/datasheet-ingest.queue.js';
import { matchesDatasheetFile } from '../src/modules/components/datasheet-parse.utils.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const dirArg = args.find((a) => !a.startsWith('--'));
const components = await prisma.component.findMany({ select: { partNumber: true, datasheetUrl: true, specs: true } });
// --all: re-ingest every component that has a matching file, not only those still lacking current data
const pending = components.filter(
  (c) => c.datasheetUrl && (all || !String((c.specs as Record<string, any> | null)?._provenance?.documentId ?? '').startsWith('sha256:'))
);

const baseName = (url: string) => decodeURIComponent(url.split('?')[0].split('/').pop() ?? '').toLowerCase();

if (pending.length === 0) {
  console.log('Every component is already on the current pipeline. Nothing to do.');
  process.exit(0);
}

if (!dirArg) {
  console.log(`\n${pending.length} datasheet(s) still need to be ingested. Open each URL in your browser, save the PDF`);
  console.log('into ONE folder keeping the filename shown, then run:\n\n  npm run ingest:local -- <that folder>\n');
  for (const c of pending) console.log(`  ${(c.partNumber ?? '?').padEnd(20)} ${baseName(c.datasheetUrl!).padEnd(34)} ${c.datasheetUrl}`);
  console.log('');
  process.exit(0);
}

const dir = path.resolve(dirArg.replace(/^~(?=$|\/)/, os.homedir()));
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`Not a folder: ${dir}`);
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
console.log(`\nFolder: ${dir} — ${files.length} PDF(s) found, ${pending.length} component(s) pending\n`);

let ok = 0;
const missing: string[] = [];
const failed: string[] = [];
const notes: string[] = [];

const work = pending.flatMap((c) => {
  const want = baseName(c.datasheetUrl!).replace(/\.pdf$/, '');
  const file = files.find((f) => matchesDatasheetFile(f, want));
  if (!file) {
    missing.push(`${c.partNumber} (${want}.pdf)`);
    return [];
  }
  return [{ c, file }];
});

const runOne = async ({ c, file }: (typeof work)[number]) => {
  try {
    const r = await datasheetIngestionService.ingestFromUrl(c.datasheetUrl!, { pdfBuffer: fs.readFileSync(path.join(dir, file)) });
    console.log(`  OK    ${(c.partNumber ?? '').padEnd(20)} ${file.padEnd(28)} → ${r.partNumber}, ${r.chunksIngested} chunks${r.skippedReason ? ' [skipped: ' + r.skippedReason + ']' : ''}`);
    ok++;
    // The same datasheet can describe a differently-named catalog row (ESP32-D0WD-V3 -> "ESP32"); the
    // ingestion upserts by the part number found IN the document, so that other row is not refreshed.
    if (r.partNumber !== c.partNumber) notes.push(`${c.partNumber}: this file is the ${r.partNumber} datasheet, so the ${r.partNumber} row was updated and the "${c.partNumber}" row is unchanged (duplicate catalog entry)`);
    // The queue's failed entry for this part is now obsolete.
    for (const job of await datasheetIngestQueue.getFailed(0, 500)) {
      if (job.data?.datasheetUrl === c.datasheetUrl) await job.remove().catch(() => undefined);
    }
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    failed.push(`${c.partNumber}: ${msg}`);
    console.log(`  FAIL  ${(c.partNumber ?? '').padEnd(20)} ${file.padEnd(28)} → ${msg}`);
  }
};

// Three at a time: each ingestion is mostly waiting on the AI calls.
const queue = [...work];
await Promise.all(Array.from({ length: 3 }, async () => { for (let item = queue.shift(); item; item = queue.shift()) await runOne(item); }));

console.log(`\nIngested ${ok}. Still missing a file: ${missing.length}${missing.length ? '\n    ' + missing.join('\n    ') : ''}`);
if (failed.length) console.log(`Failed: ${failed.length}\n    ${failed.join('\n    ')}`);
if (notes.length) console.log(`Notes:\n    ${notes.join('\n    ')}`);
console.log('\nRun `npm run verify:ingestion` to see the catalog scorecard.\n');
await prisma.$disconnect();
process.exit(failed.length ? 1 : 0);
