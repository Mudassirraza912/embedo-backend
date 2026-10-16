/**
 * Local replay of a Prototype session: rebuilds the bench from a session's stored composition (the
 * resolver's choice) and the exact library records it used, with the code in this checkout. Lets a
 * change to the allocator, checks or layout be tried on real sessions before it is pushed.
 *
 *   1. Dump a session (dev, or read-only prod) to JSON:
 *      scripts/prototype-replay-dump.sql via psql -v sid=<session id> -At -f ... > dump.json
 *   2. DATABASE_URL=postgresql://x:x@localhost:5432/x JWT_ACCESS_SECRET=0123456789abcdef0123456789abcdef \
 *        npx tsx scripts/prototype-replay.ts dump.json [out.svg]
 *
 * Nothing is written anywhere except the optional SVG. No AI calls, no database.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { hardwareRecordSchema, isControllerRecord } from '../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../src/modules/hardware/hardware-svg.js';
import { renderBenchArt } from '../src/modules/hardware/bench-art.js';
import type { LibraryEntity } from '../src/modules/hardware/hardware-library.service.js';
import { assemblePrototype, externalSupplyVoltsOf } from '../src/modules/sessions/prototype/prototype-assembler.js';
import { withPlaceholderEntities } from '../src/modules/sessions/prototype/prototype-placeholders.js';
import { renderPrototypeSvg } from '../src/modules/sessions/prototype/prototype-svg-exporter.js';
import { isPrototypeComposition } from '../src/modules/sessions/prototype/prototype.types.js';

interface Dump {
  session: { id: string; title: string | null; intent_text: string; design_graph: unknown };
  entities: Array<{
    hardware_entity_id: string;
    product_family_id: string;
    review_status: string;
    lifecycle_status: string;
    asset_readiness: string;
    scope: string;
    verification_method: string;
    record_origin: string;
    project_id: string | null;
    metadata_json: unknown;
    svg_markup: string | null;
    svg_hash: string | null;
  }>;
}

const [file, svgOut] = process.argv.slice(2);
if (!file) {
  console.error('usage: tsx scripts/prototype-replay.ts dump.json [out.svg]');
  process.exit(2);
}
const dump = JSON.parse(readFileSync(file, 'utf8')) as Dump;
if (!isPrototypeComposition(dump.session.design_graph)) {
  console.error('session has no prototype composition');
  process.exit(1);
}
const composition = dump.session.design_graph;

const entities = new Map<string, LibraryEntity>();
for (const row of dump.entities) {
  const record = hardwareRecordSchema.parse(row.metadata_json);
  entities.set(row.hardware_entity_id, {
    hardwareEntityId: row.hardware_entity_id,
    productFamilyId: row.product_family_id,
    preferredInFamily: false,
    reviewStatus: row.review_status,
    lifecycleStatus: row.lifecycle_status,
    assetReadiness: row.asset_readiness as LibraryEntity['assetReadiness'],
    scope: row.scope,
    verificationMethod: row.verification_method,
    recordOrigin: row.record_origin,
    projectId: row.project_id,
    isController: isControllerRecord(record),
    record,
    sources: [],
    svg: row.svg_markup ? { hash: row.svg_hash ?? 'h', markup: row.svg_markup, parsed: parseModuleSvg(row.svg_markup) } : null,
  });
}

const p = assemblePrototype(composition, entities, {
  svgBasePath: '/api/v1/hardware/entities',
  projectName: dump.session.title ?? 'Prototype',
  understanding: '',
  notes: '',
  externalSupplyVolts: externalSupplyVoltsOf(dump.session.intent_text),
});

console.log(`session ${dump.session.id}`);
console.log(`summary  ${p.moduleDiagram.header.summary} · layout ${p.moduleDiagram.layoutVersion} · ${p.moduleDiagram.bands} band(s)`);
console.log(`checks   ${JSON.stringify(p.compatibility.counts)}`);
for (const i of p.instances) console.log(`  ${i.instanceId.padEnd(14)} ${i.placeholder ? `[placeholder ${i.placeholder.kind}] ` : ''}${i.label}`);
console.log(`nets     ${p.nets.map((n) => `${n.name}(${n.members.length})`).join(' ')}`);
for (const r of p.compatibility.results.filter((r) => r.status !== 'PASS')) console.log(`  ${r.status.padEnd(7)} ${r.ruleType}: ${r.message}`);
const unwired = p.pinList.summary.unwiredModules ?? [];
if (unwired.length > 0) console.log(`unwired  ${unwired.map((m) => m.label).join(', ')}`);

if (svgOut) {
  const all = withPlaceholderEntities(entities, p.instances);
  const artwork = new Map(p.instances.map((i) => [i.instanceId, renderBenchArt(all.get(i.hardwareEntityId)!.record, i.isController).svg]));
  writeFileSync(svgOut, renderPrototypeSvg(p, artwork));
  console.log(`svg      ${svgOut}`);
}
