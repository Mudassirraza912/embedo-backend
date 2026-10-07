import path from 'node:path';
import { loadBundle } from '../../src/modules/hardware/hardware-import.service.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';

/** The dev fixture library, loaded exactly as the importer reads it, as runtime LibraryEntity objects. */
export const FIXTURE_DIR = path.resolve('prisma/hardware-library');

export async function loadFixtureEntity(id: string, overrides: Partial<LibraryEntity> = {}): Promise<LibraryEntity> {
  const { bundle, issues } = await loadBundle(FIXTURE_DIR, id);
  if (!bundle) throw new Error(`fixture ${id} failed to load: ${issues.map((i) => i.message).join('; ')}`);
  const g = bundle.record.status_governance;
  return {
    hardwareEntityId: bundle.hardwareEntityId,
    productFamilyId: bundle.record.identity.product_family_id,
    preferredInFamily: false,
    reviewStatus: g.review_status,
    lifecycleStatus: g.lifecycle_status,
    assetReadiness: g.asset_readiness,
    scope: g.scope,
    verificationMethod: g.verification_method,
    recordOrigin: g.record_origin,
    projectId: null,
    isController: isControllerRecord(bundle.record),
    record: bundle.record,
    sources: bundle.record.provenance.sources.map((s) => ({ sourceType: s.source_type, url: s.url ?? null, official: s.official })),
    svg: { hash: bundle.asset.generation_source_hash, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) },
    ...overrides,
  };
}

export const FIXTURE_IDS = { pico: 'HW-FX01', qtPy: 'HW-FX02', bme280: 'HW-FX03', gps: 'HW-FX04', microSd: 'HW-FX05' } as const;
