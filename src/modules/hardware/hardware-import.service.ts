import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import {
  HardwareRecord,
  hardwareRecordSchema,
  SvgAssetFile,
  svgAssetFileSchema,
  wholeConnectorAnchorId,
} from './hardware.schema.js';
import { assertSafeModuleSvg, duplicateSvgIds, parseModuleSvg, UnsafeSvgError } from './hardware-svg.js';

/**
 * Seed import of the Hardware Library (plan D3). The Drive layout is one folder per board:
 *
 *   <dir>/HW-0001/HW-0001.json   the v3.3 record
 *   <dir>/HW-0001/HW-0001.svg    perimeter-v1 artwork
 *   <dir>/HW-0001/HW-0001.asset.json
 *
 * Rules: records are validated before anything is written; an id that already exists with the
 * same content is skipped (a second run reports zero changes); one that exists with different
 * content is NOT overwritten unless the caller explicitly asks (§4.3 — changes go through review).
 */

export interface BundleIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface LoadedBundle {
  folder: string;
  hardwareEntityId: string;
  record: HardwareRecord;
  rawRecord: unknown;
  svg: string;
  asset: SvgAssetFile;
  contentHash: string;
}

export interface ImportOptions {
  dryRun?: boolean;
  /** Dev only: replace boards whose content changed. Without it they are reported and left alone. */
  overwriteChanged?: boolean;
  actor?: string;
}

export type BoardOutcome = 'created' | 'updated' | 'unchanged' | 'changed_not_overwritten' | 'failed' | 'would_create' | 'would_update';

export interface ImportReport {
  dir: string;
  dryRun: boolean;
  counts: Record<BoardOutcome, number>;
  boards: Array<{ folder: string; hardwareEntityId: string | null; outcome: BoardOutcome; issues: BundleIssue[] }>;
}

const sha256 = (text: string): string => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

/** Stable JSON (sorted keys) so formatting changes in the source files never count as a change. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

/** Checks that need the record and its artwork together (validate.py's anchor contract, plan C3). */
export function validateBundle(record: HardwareRecord, svg: string, asset: SvgAssetFile): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const id = record.identity.hardware_entity_id;

  if (asset.hardware_entity_id !== id) {
    issues.push({ severity: 'error', message: `asset.json is for ${asset.hardware_entity_id}, record is ${id}` });
  }

  let parsed;
  try {
    assertSafeModuleSvg(svg);
    parsed = parseModuleSvg(svg);
  } catch (err) {
    issues.push({ severity: 'error', message: `SVG rejected: ${err instanceof UnsafeSvgError ? err.message : String(err)}` });
    return issues;
  }

  for (const dupe of duplicateSvgIds(svg)) {
    issues.push({ severity: 'error', message: `SVG id "${dupe}" is not unique` });
  }

  const pinIds = new Set(record.pins.map((p) => p.pin_id));
  const pinsOnContacts = new Set<string>();
  const recordAnchors = new Set<string>();
  for (const connector of record.connectors) {
    for (const contact of connector.contacts) {
      if (!pinIds.has(contact.pin_id)) {
        issues.push({ severity: 'error', message: `${contact.contact_id} references unknown pin ${contact.pin_id}` });
      }
      pinsOnContacts.add(contact.pin_id);
      if (contact.svg_anchor_id) {
        recordAnchors.add(contact.svg_anchor_id);
        if (!parsed.anchors.has(contact.svg_anchor_id)) {
          issues.push({ severity: 'error', message: `anchor ${contact.svg_anchor_id} (${contact.contact_id}) is missing from the SVG` });
        }
      } else if (connector.connection_mode !== 'whole_connector') {
        issues.push({ severity: 'warning', message: `${contact.contact_id} has no svg_anchor_id, so it cannot be wired` });
      }
    }
    const whole = wholeConnectorAnchorId(connector);
    if (whole) {
      recordAnchors.add(whole);
      if (!parsed.anchors.get(whole)?.whole) {
        issues.push({ severity: 'error', message: `whole-connector anchor ${whole} is missing from the SVG` });
      }
    }
  }

  for (const pin of record.pins) {
    if (!pinsOnContacts.has(pin.pin_id)) {
      issues.push({ severity: 'warning', message: `pin ${pin.pin_id} is not exposed on any contact` });
    }
  }

  const connectorIds = new Set(record.connectors.map((c) => c.connector_id));
  for (const anchor of parsed.anchors.values()) {
    if (recordAnchors.has(anchor.id)) continue;
    // A whole-connector anchor may live only in the SVG; it is tied to its connector by data-connector-id.
    if (anchor.whole && anchor.connectorId && connectorIds.has(anchor.connectorId)) continue;
    issues.push({ severity: 'warning', message: `SVG anchor ${anchor.id} is not referenced by the record` });
  }

  if (asset.anchor_ids.length > 0) {
    const svgAnchorIds = new Set(parsed.anchors.keys());
    const missing = asset.anchor_ids.filter((a) => !svgAnchorIds.has(a));
    if (missing.length > 0) {
      issues.push({ severity: 'warning', message: `asset.json lists ${missing.length} anchor(s) the SVG lacks: ${missing.slice(0, 5).join(', ')}` });
    }
  }

  // §8.5 wants {rail_name, voltage_min_v, voltage_max_v}. A string rail imports, but every rule that
  // reads it reports UNKNOWN until a reviewer structures it.
  const stringRails = record.electrical.required_power_rails.filter((rail) => typeof rail === 'string');
  if (stringRails.length > 0) {
    issues.push({ severity: 'warning', message: `unstructured power rail(s): ${stringRails.join('; ')}` });
  }
  if (record.status_governance.asset_readiness === 'needs_review') {
    issues.push({ severity: 'warning', message: 'asset_readiness is needs_review' });
  }

  return issues;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Reads and validates one board folder. Never touches the database. */
export async function loadBundle(dir: string, folder: string): Promise<{ bundle: LoadedBundle | null; issues: BundleIssue[] }> {
  const base = path.join(dir, folder);
  const issues: BundleIssue[] = [];
  let rawRecord: unknown;
  let rawAsset: unknown;
  let svg: string;
  try {
    rawRecord = await readJson(path.join(base, `${folder}.json`));
    rawAsset = await readJson(path.join(base, `${folder}.asset.json`));
    svg = await fs.readFile(path.join(base, `${folder}.svg`), 'utf8');
  } catch (err) {
    return { bundle: null, issues: [{ severity: 'error', message: `cannot read bundle files: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const record = hardwareRecordSchema.safeParse(rawRecord);
  const asset = svgAssetFileSchema.safeParse(rawAsset);
  if (!record.success) {
    issues.push(
      ...record.error.issues.slice(0, 10).map((i) => ({ severity: 'error' as const, message: `record ${i.path.join('.')}: ${i.message}` }))
    );
  }
  if (!asset.success) {
    issues.push(
      ...asset.error.issues.slice(0, 10).map((i) => ({ severity: 'error' as const, message: `asset.json ${i.path.join('.')}: ${i.message}` }))
    );
  }
  if (!record.success || !asset.success) return { bundle: null, issues };

  if (record.data.identity.hardware_entity_id !== folder) {
    issues.push({ severity: 'error', message: `folder ${folder} holds record ${record.data.identity.hardware_entity_id}` });
  }
  issues.push(...validateBundle(record.data, svg, asset.data));
  if (issues.some((i) => i.severity === 'error')) return { bundle: null, issues };

  return {
    bundle: {
      folder,
      hardwareEntityId: record.data.identity.hardware_entity_id,
      record: record.data,
      rawRecord,
      svg: assertSafeModuleSvg(svg),
      asset: asset.data,
      contentHash: sha256(canonicalJson(rawRecord) + '\n' + sha256(svg)),
    },
    issues,
  };
}

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

async function writeBundle(bundle: LoadedBundle, actor: string, replace: boolean): Promise<void> {
  const { record, asset } = bundle;
  const id = bundle.hardwareEntityId;
  const governance = record.status_governance;
  const entityData = {
    productFamilyId: record.identity.product_family_id,
    hardwareRevision: record.family_revision.hardware_revision ?? null,
    reviewStatus: governance.review_status,
    lifecycleStatus: governance.lifecycle_status,
    scope: governance.scope,
    verificationMethod: governance.verification_method,
    recordOrigin: governance.record_origin,
    assetReadiness: governance.asset_readiness,
    createdBy: governance.created_by ?? actor,
    metadataSchemaVersion: record.metadata_schema_version ?? governance.metadata_schema_version ?? '3.3',
    contentHash: bundle.contentHash,
    metadataJson: bundle.rawRecord as Prisma.InputJsonValue,
  };
  const svgData = {
    fileName: asset.file_name,
    storagePath: asset.storage_path,
    buildStatus: asset.build_status,
    validationStatus: asset.validation_status,
    anchorIds: asset.anchor_ids as Prisma.InputJsonValue,
    generationSourceHash: asset.generation_source_hash,
    generatedAt: toDate(asset.generated_at),
    approvedBy: asset.approved_by ?? null,
    approvedAt: toDate(asset.approved_at),
    artworkOriginal: asset.artwork_original,
    svgMarkup: bundle.svg,
  };
  const sources = record.provenance.sources.map((s) => ({
    sourceType: s.source_type,
    url: s.url ?? null,
    official: s.official,
    verifiedAt: toDate(s.verified_at),
    contentFingerprint: s.content_fingerprint ?? null,
  }));

  await prisma.$transaction(async (tx) => {
    // The family row is created on first sight and otherwise left alone: preferred_hardware_entity_id
    // belongs to reviewers (§19.3) and must survive re-imports.
    await tx.productFamily.upsert({
      where: { productFamilyId: record.identity.product_family_id },
      create: {
        productFamilyId: record.identity.product_family_id,
        vendor: record.identity.vendor,
        familyName: record.identity.product_name,
        canonicalGroup: record.identity.group.slice(0, 60),
      },
      update: {},
    });

    if (replace) {
      await tx.hardwareEntity.update({ where: { hardwareEntityId: id }, data: entityData });
      await tx.hardwareSource.deleteMany({ where: { hardwareEntityId: id } });
      await tx.svgAsset.upsert({ where: { hardwareEntityId: id }, create: { hardwareEntityId: id, ...svgData }, update: svgData });
    } else {
      await tx.hardwareEntity.create({ data: { hardwareEntityId: id, ...entityData } });
      await tx.svgAsset.create({ data: { hardwareEntityId: id, ...svgData } });
    }
    if (sources.length > 0) {
      await tx.hardwareSource.createMany({ data: sources.map((s) => ({ hardwareEntityId: id, ...s })) });
    }
  });
}

/** Imports every HW-* folder under `dir`. Per-board failures are reported, never fatal to the run. */
export async function importHardwareLibrary(dir: string, options: ImportOptions = {}): Promise<ImportReport> {
  const actor = options.actor ?? 'seed-importer';
  const dryRun = Boolean(options.dryRun);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && /^HW-[A-Za-z0-9-]+$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const report: ImportReport = {
    dir,
    dryRun,
    counts: { created: 0, updated: 0, unchanged: 0, changed_not_overwritten: 0, failed: 0, would_create: 0, would_update: 0 },
    boards: [],
  };

  for (const folder of folders) {
    const { bundle, issues } = await loadBundle(dir, folder);
    let outcome: BoardOutcome;
    if (!bundle) {
      outcome = 'failed';
    } else {
      try {
        const existing = await prisma.hardwareEntity.findUnique({
          where: { hardwareEntityId: bundle.hardwareEntityId },
          select: { contentHash: true },
        });
        if (existing && existing.contentHash === bundle.contentHash) {
          outcome = 'unchanged';
        } else if (existing && !options.overwriteChanged) {
          outcome = 'changed_not_overwritten';
          issues.push({ severity: 'warning', message: 'content differs from the stored record; left unchanged (needs review)' });
        } else if (dryRun) {
          outcome = existing ? 'would_update' : 'would_create';
        } else {
          await writeBundle(bundle, actor, Boolean(existing));
          outcome = existing ? 'updated' : 'created';
        }
      } catch (err) {
        outcome = 'failed';
        issues.push({ severity: 'error', message: `database write failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    report.counts[outcome] += 1;
    report.boards.push({ folder, hardwareEntityId: bundle?.hardwareEntityId ?? null, outcome, issues });
  }

  logger.info({ dir, dryRun, counts: report.counts }, 'Hardware library import finished');
  return report;
}
