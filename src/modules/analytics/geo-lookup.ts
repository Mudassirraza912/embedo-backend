/**
 * Pluggable IP → country/region lookup (task_two).
 *
 * No maintained geolocation data source is wired up here yet: picking one (a bundled offline
 * MaxMind GeoLite2-style database file read through a maintained reader package, geoip-lite, or a
 * live third-party API) needs the user's sign-off plus the privacy/retention/legal-basis language
 * the ticket itself requires before production rollout (see CLAUDE.md §11, task_two notes in
 * todo.md). Until that happens, `geoLookupProvider` is `StubGeoLookupProvider`, which always
 * reports "unknown" — never a guessed country. Swap the exported singleton for a real
 * implementation of `GeoLookupProvider` once a source is approved; every caller only depends on
 * this interface, never on a concrete provider.
 */

export type GeoLookupStatus = 'ok' | 'unknown';

export interface GeoLookupResult {
  status: GeoLookupStatus;
  /** ISO 3166-1 alpha-2, only when status === 'ok'. */
  countryCode: string | null;
  /** Only set when the source has reliable sub-country coverage for this lookup. */
  regionCode: string | null;
  /** Identifies the data source, e.g. "none" (this stub) or a real provider's id later. */
  source: string;
  sourceVersion: string | null;
}

export interface GeoLookupProvider {
  lookup(ip: string): GeoLookupResult | Promise<GeoLookupResult>;
}

const UNKNOWN_RESULT: GeoLookupResult = {
  status: 'unknown',
  countryCode: null,
  regionCode: null,
  source: 'none',
  sourceVersion: null,
};

/**
 * Always reports "unknown". This is intentional (see module doc) — never replace this with logic
 * that infers a country from timezone, language or any other weak signal; that is exactly what the
 * ticket's accuracy-boundary requirement forbids.
 */
export class StubGeoLookupProvider implements GeoLookupProvider {
  lookup(_ip: string): GeoLookupResult {
    return UNKNOWN_RESULT;
  }
}

export const geoLookupProvider: GeoLookupProvider = new StubGeoLookupProvider();
