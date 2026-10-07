/**
 * Uploads a Hardware Library folder (Drive layout: HW-xxxx/HW-xxxx.{json,svg,asset.json}) to an
 * Embedo environment through the admin API, from the operator's own machine. The server stores
 * each board in the database and embeds it; it never reads hardware files from its own disk.
 *
 *   EMBEDO_ADMIN_TOKEN=<admin JWT> npm run hw:upload -- --dir <folder> --api https://dev-api.embedo.ai/api/v1 [--replace]
 *
 * Without --replace, boards that already exist are reported and left alone (409).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<number> {
  const dir = value('dir');
  const api = value('api')?.replace(/\/$/, '');
  const token = process.env['EMBEDO_ADMIN_TOKEN'];
  const replace = args.includes('--replace');
  if (!dir || !api || !token) {
    console.error('Usage: EMBEDO_ADMIN_TOKEN=<admin JWT> hw:upload --dir <folder> --api <api base, e.g. https://dev-api.embedo.ai/api/v1> [--replace]');
    return 2;
  }

  const folders = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^HW-[A-Za-z0-9-]+$/.test(e.name))
    .map((e) => e.name)
    .sort();
  let failed = 0;
  for (const id of folders) {
    const base = path.join(dir, id);
    const record = JSON.parse(await fs.readFile(path.join(base, `${id}.json`), 'utf8'));
    const svg = await fs.readFile(path.join(base, `${id}.svg`), 'utf8');
    const asset = await fs
      .readFile(path.join(base, `${id}.asset.json`), 'utf8')
      .then((t) => JSON.parse(t))
      .catch(() => undefined);

    const res = await fetch(replace ? `${api}/admin/hardware/${encodeURIComponent(id)}` : `${api}/admin/hardware`, {
      method: replace ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ record, svg, asset }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { outcome?: string; embedding?: string; issues?: Array<{ severity: string; message: string }> };
      error?: { code?: string; message?: string; details?: { issues?: Array<{ message: string }> } };
    };
    if (res.ok) {
      console.log(`✓ ${id.padEnd(10)} ${body.data?.outcome} · embedding ${body.data?.embedding}`);
      for (const issue of body.data?.issues ?? []) console.log(`    ${issue.severity}: ${issue.message}`);
    } else {
      if (res.status !== 409) failed += 1;
      console.log(`${res.status === 409 ? '·' : '✖'} ${id.padEnd(10)} ${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`);
      for (const issue of body.error?.details?.issues ?? []) console.log(`    ${issue.message}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
