import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Which build is running. CI writes build-info.json (version, commit, build time, channel) into
 * the source before the Docker build; the committed copy is a placeholder for local runs, where
 * the version falls back to package.json + "-local".
 *
 * Versions are MAJOR.MINOR.BUILD: MAJOR.MINOR from package.json, BUILD counted by CI from the
 * production release tags (scripts/ci/next-version.sh). Development deploys carry a "-dev.N"
 * pre-release of the next production build.
 */
export interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
  channel: 'production' | 'development' | 'local';
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), file), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

function load(): BuildInfo {
  const info = readJson('build-info.json') ?? {};
  const pkgVersion = str(readJson('package.json')?.['version']) ?? '0.0.0';
  const channel = info['channel'] === 'production' || info['channel'] === 'development' ? info['channel'] : 'local';
  return {
    version: str(info['version']) ?? `${pkgVersion}-local`,
    commit: str(info['commit']),
    builtAt: str(info['builtAt']),
    channel,
  };
}

export const buildInfo: BuildInfo = load();
