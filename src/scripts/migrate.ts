/**
 * Production-safe migration runner.
 *
 *   node dist/scripts/migrate.js
 *
 * 1. If the database already contains the application schema but has no Prisma migration
 *    history (it was originally created with `prisma db push`), the baseline migration is
 *    marked as applied so `migrate deploy` does not try to recreate existing tables.
 * 2. Runs `prisma migrate deploy` (forward-only, never destructive without an explicit migration).
 *
 * `prisma db push` must never be used against production.
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const BASELINE_MIGRATION = '20260911000000_init';

const run = (args: string[]): void => {
  const result = spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error(`prisma ${args.join(' ')} failed with exit code ${result.status}`);
  }
};

const main = async (): Promise<void> => {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('users', '_prisma_migrations')`;
    const names = new Set(rows.map((r) => r.table_name));
    const hasSchema = names.has('users');
    const hasHistory = names.has('_prisma_migrations');

    if (hasSchema && !hasHistory) {
      console.log(`[migrate] Existing schema without migration history detected — baselining ${BASELINE_MIGRATION}.`);
      run(['migrate', 'resolve', '--applied', BASELINE_MIGRATION]);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('[migrate] Applying pending migrations...');
  run(['migrate', 'deploy']);
  console.log('[migrate] Done.');
};

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
