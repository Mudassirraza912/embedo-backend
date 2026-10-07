/**
 * Imports a Hardware Library directory (Drive layout: HW-xxxx/HW-xxxx.{json,svg,asset.json}).
 *
 *   npm run hw:import -- --dir prisma/hardware-library [--dry-run] [--overwrite-changed]
 *   node dist/scripts/hardware-import.js --dir prisma/hardware-library      (inside the api container)
 *
 * Idempotent: unchanged boards are skipped, changed ones are reported and left alone unless
 * --overwrite-changed is given (dev only — in production a changed record goes through review).
 * Exits non-zero when any board failed validation.
 */
import path from 'node:path';
import { prisma } from '../db/prisma.js';
import { importHardwareLibrary } from '../modules/hardware/hardware-import.service.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<number> {
  const dir = value('dir') ?? process.env['HARDWARE_LIBRARY_DIR'];
  if (!dir) {
    console.error('Usage: hardware-import --dir <library dir> [--dry-run] [--overwrite-changed]');
    return 2;
  }
  const report = await importHardwareLibrary(path.resolve(dir), {
    dryRun: flag('dry-run'),
    overwriteChanged: flag('overwrite-changed'),
    actor: 'seed-importer',
  });

  for (const board of report.boards) {
    const marker = board.outcome === 'failed' ? '✖' : board.issues.some((i) => i.severity === 'warning') ? '!' : '✓';
    console.log(`${marker} ${board.folder.padEnd(10)} ${board.outcome}`);
    for (const issue of board.issues) console.log(`    ${issue.severity}: ${issue.message}`);
  }
  console.log(`\n${report.dryRun ? '[dry run] ' : ''}${JSON.stringify(report.counts)}`);
  return report.counts.failed > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
