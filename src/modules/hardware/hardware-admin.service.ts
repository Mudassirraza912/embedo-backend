import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import {
  ASSET_READINESS,
  HardwareRecord,
  hardwareRecordSchema,
  LIFECYCLE_STATUSES,
  REVIEW_STATUSES,
  SvgAssetFile,
  svgAssetFileSchema,
  wholeConnectorAnchorId,
} from './hardware.schema.js';
import { assertSafeModuleSvg, duplicateSvgIds, parseModuleSvg, UnsafeSvgError } from './hardware-svg.js';
import { EmbedOutcome, hardwareEmbeddingService } from './hardware-embedding.service.js';

/**
 * Hardware library administration. Boards are added from the admin panel and live entirely in
 * the database: the v3.3 record (metadata_json), its perimeter-v1 SVG (svg_assets.svg_markup),
 * its sources, and a pgvector embedding for retrieval. Nothing is read from or written to disk.
 *
 * Every write is validated first (schema, SVG safety, anchor contract); an unchanged upload is a
 * no-op; replacing an existing board is an explicit admin action and is audit-logged.
 */

export interface BundleIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface HardwareUpload {
  /** The v3.3 record (HW-xxxx.json). */
  record: unknown;
  /** The perimeter-v1 artwork (HW-xxxx.svg) as text. */
  svg: string;
  /** HW-xxxx.asset.json. Optional: derived from the SVG when absent. */
  asset?: unknown;
}

export interface PreparedBundle {
  hardwareEntityId: string;
  record: HardwareRecord;
  rawRecord: unknown;
  svg: string;
  asset: SvgAssetFile;
  contentHash: string;
}

const sha256 = (text: string): string => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

/** Stable JSON (sorted keys) so key order or formatting never counts as a change. */
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
    issues.push({ severity: 'error', message: `asset is for ${asset.hardware_entity_id}, record is ${id}` });
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
      issues.push({ severity: 'warning', message: `asset lists ${missing.length} anchor(s) the SVG lacks: ${missing.slice(0, 5).join(', ')}` });
    }
  }

  // §8.5 wants {rail_name, voltage_min_v, voltage_max_v}. A string rail is accepted, but every rule
  // that reads it reports UNKNOWN until a reviewer structures it.
  const stringRails = record.electrical.required_power_rails.filter((rail) => typeof rail === 'string');
  if (stringRails.length > 0) {
    issues.push({ severity: 'warning', message: `unstructured power rail(s): ${stringRails.join('; ')}` });
  }
  if (record.status_governance.asset_readiness === 'needs_review') {
    issues.push({ severity: 'warning', message: 'asset_readiness is needs_review' });
  }

  return issues;
}

/** Parses and validates an upload without touching the database. */
export function prepareBundle(input: HardwareUpload): { bundle: PreparedBundle | null; issues: BundleIssue[] } {
  const issues: BundleIssue[] = [];
  const record = hardwareRecordSchema.safeParse(input.record);
  if (!record.success) {
    return {
      bundle: null,
      issues: record.error.issues.slice(0, 20).map((i) => ({ severity: 'error' as const, message: `record ${i.path.join('.')}: ${i.message}` })),
    };
  }
  const id = record.data.identity.hardware_entity_id;
  const svg = typeof input.svg === 'string' ? input.svg.trim() : '';

  let rawAsset = input.asset;
  if (rawAsset === undefined || rawAsset === null) {
    // No asset.json: derive it from the artwork itself.
    let anchorIds: string[] = [];
    try {
      anchorIds = [...parseModuleSvg(svg).anchors.keys()];
    } catch {
      // validateBundle reports the unusable SVG below.
    }
    rawAsset = {
      hardware_entity_id: id,
      file_name: `${id}.svg`,
      storage_path: `/modules/${id}.svg`,
      build_status: 'complete',
      validation_status: 'not_run',
      anchor_ids: anchorIds,
      generation_source_hash: sha256(svg),
      artwork_original: true,
    };
  }
  const asset = svgAssetFileSchema.safeParse(rawAsset);
  if (!asset.success) {
    return {
      bundle: null,
      issues: asset.error.issues.slice(0, 10).map((i) => ({ severity: 'error' as const, message: `asset ${i.path.join('.')}: ${i.message}` })),
    };
  }

  issues.push(...validateBundle(record.data, svg, asset.data));
  if (issues.some((i) => i.severity === 'error')) return { bundle: null, issues };

  // Validation is ours now, whatever the upload claimed.
  const validatedAsset: SvgAssetFile = { ...asset.data, validation_status: 'passed' };
  return {
    bundle: {
      hardwareEntityId: id,
      record: record.data,
      rawRecord: input.record,
      svg: assertSafeModuleSvg(svg),
      asset: validatedAsset,
      contentHash: sha256(`${canonicalJson(input.record)}\n${sha256(svg)}`),
    },
    issues,
  };
}

const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

async function writeBundle(bundle: PreparedBundle, actor: string, replace: boolean): Promise<void> {
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
    // belongs to reviewers (§19.3) and must survive re-uploads.
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

export interface SaveResult {
  hardwareEntityId: string;
  outcome: 'created' | 'updated' | 'unchanged';
  embedding: EmbedOutcome;
  issues: BundleIssue[];
}

async function audit(actorUserId: string | null, action: string, hardwareEntityId: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        entityType: 'HardwareEntity',
        entityId: null, // audit_log.entity_id is a UUID; hardware ids are not
        metadata: { hardwareEntityId, ...metadata } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.warn({ err, hardwareEntityId, action }, 'Failed to write hardware audit log');
  }
}

const listSelect = {
  hardwareEntityId: true,
  productFamilyId: true,
  reviewStatus: true,
  assetReadiness: true,
  lifecycleStatus: true,
  scope: true,
  verificationMethod: true,
  recordOrigin: true,
  embeddedAt: true,
  embeddingModelVersion: true,
  updatedAt: true,
  metadataJson: true,
} satisfies Prisma.HardwareEntitySelect;

function summaryRow(row: Prisma.HardwareEntityGetPayload<{ select: typeof listSelect }>) {
  const identity = ((row.metadataJson as Record<string, unknown>)['identity'] ?? {}) as Record<string, unknown>;
  return {
    hardwareEntityId: row.hardwareEntityId,
    productFamilyId: row.productFamilyId,
    productName: typeof identity['product_name'] === 'string' ? identity['product_name'] : row.hardwareEntityId,
    vendor: typeof identity['vendor'] === 'string' ? identity['vendor'] : null,
    vendorSku: typeof identity['vendor_sku'] === 'string' ? identity['vendor_sku'] : null,
    functionalCategories: Array.isArray(identity['functional_categories']) ? identity['functional_categories'] : [],
    reviewStatus: row.reviewStatus,
    assetReadiness: row.assetReadiness,
    lifecycleStatus: row.lifecycleStatus,
    scope: row.scope,
    verificationMethod: row.verificationMethod,
    recordOrigin: row.recordOrigin,
    embedded: row.embeddedAt !== null,
    embeddedAt: row.embeddedAt,
    embeddingModelVersion: row.embeddingModelVersion,
    updatedAt: row.updatedAt,
  };
}

export const hardwareAdminService = {
  /** Dry run: what an upload would produce, without writing anything. */
  validate(input: HardwareUpload) {
    const { bundle, issues } = prepareBundle(input);
    return { valid: bundle !== null, hardwareEntityId: bundle?.hardwareEntityId ?? null, issues };
  },

  /**
   * Creates (mode=create) or replaces (mode=replace) one board, then embeds it. The record is the
   * source of truth for governance on create; replace keeps the stored review state unless the
   * upload changes it, so re-uploading a fixed SVG does not silently un-confirm a board.
   */
  async save(input: HardwareUpload, actor: { userId: string | null; label: string }, mode: 'create' | 'replace', expectedId?: string): Promise<SaveResult> {
    const { bundle, issues } = prepareBundle(input);
    if (!bundle) throw new AppError(422, 'VALIDATION_ERROR', 'Hardware record failed validation', { issues });
    if (expectedId && bundle.hardwareEntityId !== expectedId) {
      throw new AppError(400, 'BAD_REQUEST', `Record id ${bundle.hardwareEntityId} does not match ${expectedId}`);
    }

    const existing = await prisma.hardwareEntity.findUnique({
      where: { hardwareEntityId: bundle.hardwareEntityId },
      select: { contentHash: true, scope: true },
    });
    if (mode === 'create' && existing) {
      throw new AppError(409, 'CONFLICT', `${bundle.hardwareEntityId} already exists. Use PUT /admin/hardware/${bundle.hardwareEntityId} to replace it.`);
    }
    if (mode === 'replace' && !existing) throw new AppError(404, 'NOT_FOUND', `${bundle.hardwareEntityId} does not exist`);
    if (bundle.record.status_governance.scope === 'private_project') {
      throw new AppError(400, 'BAD_REQUEST', 'Private project hardware is created by a project, not uploaded to the shared library');
    }

    let outcome: SaveResult['outcome'];
    if (existing && existing.contentHash === bundle.contentHash) {
      outcome = 'unchanged';
    } else {
      await writeBundle(bundle, actor.label, Boolean(existing));
      outcome = existing ? 'updated' : 'created';
      await audit(actor.userId, existing ? 'HARDWARE_UPDATED' : 'HARDWARE_CREATED', bundle.hardwareEntityId, {
        contentHash: bundle.contentHash,
        warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
      });
    }

    // Embedding failures never lose the upload: the board is saved and can be re-embedded.
    const { outcome: embedding, error } = await hardwareEmbeddingService.embedEntity(bundle.hardwareEntityId);
    if (embedding === 'failed') issues.push({ severity: 'warning', message: `embedding failed (${error}); retry with POST /admin/hardware/${bundle.hardwareEntityId}/embed` });
    if (embedding === 'not_configured') issues.push({ severity: 'warning', message: 'embeddings are not configured (OPENAI_API_KEY); the board is saved without a vector' });

    logger.info({ hardwareEntityId: bundle.hardwareEntityId, outcome, embedding, actor: actor.label }, 'Hardware library record saved');
    return { hardwareEntityId: bundle.hardwareEntityId, outcome, embedding, issues };
  },

  async list(query: { q?: string; reviewStatus?: string; assetReadiness?: string; embedded?: boolean; page: number; pageSize: number }) {
    const where: Prisma.HardwareEntityWhereInput = {
      scope: 'shared_library',
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      ...(query.assetReadiness ? { assetReadiness: query.assetReadiness } : {}),
      ...(query.embedded === undefined ? {} : query.embedded ? { embeddedAt: { not: null } } : { embeddedAt: null }),
      ...(query.q
        ? {
            OR: [
              { hardwareEntityId: { contains: query.q, mode: 'insensitive' } },
              { productFamilyId: { contains: query.q, mode: 'insensitive' } },
              { family: { familyName: { contains: query.q, mode: 'insensitive' } } },
              { family: { vendor: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.hardwareEntity.count({ where }),
      prisma.hardwareEntity.findMany({
        where,
        select: listSelect,
        orderBy: { hardwareEntityId: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items: rows.map(summaryRow) };
  },

  async get(hardwareEntityId: string) {
    const row = await prisma.hardwareEntity.findUnique({
      where: { hardwareEntityId },
      select: {
        ...listSelect,
        contentHash: true,
        createdBy: true,
        createdAt: true,
        embeddingSourceSummary: true,
        sources: { select: { sourceType: true, url: true, official: true, verifiedAt: true } },
        svgAsset: {
          select: { fileName: true, buildStatus: true, validationStatus: true, anchorIds: true, generationSourceHash: true, approvedBy: true, approvedAt: true, svgMarkup: true },
        },
      },
    });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
    return {
      ...summaryRow(row),
      contentHash: row.contentHash,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      embeddingSourceSummary: row.embeddingSourceSummary,
      record: row.metadataJson,
      sources: row.sources,
      svgAsset: row.svgAsset,
    };
  },

  /** Reviewer actions: confirm/reject, readiness, lifecycle. Records are never hard-deleted. */
  async updateGovernance(
    hardwareEntityId: string,
    patch: { reviewStatus?: string; assetReadiness?: string; lifecycleStatus?: string },
    actor: { userId: string | null; label: string }
  ) {
    if (patch.reviewStatus && !(REVIEW_STATUSES as readonly string[]).includes(patch.reviewStatus)) throw new AppError(400, 'BAD_REQUEST', 'Invalid reviewStatus');
    if (patch.assetReadiness && !(ASSET_READINESS as readonly string[]).includes(patch.assetReadiness)) throw new AppError(400, 'BAD_REQUEST', 'Invalid assetReadiness');
    if (patch.lifecycleStatus && !(LIFECYCLE_STATUSES as readonly string[]).includes(patch.lifecycleStatus)) throw new AppError(400, 'BAD_REQUEST', 'Invalid lifecycleStatus');

    const before = await prisma.hardwareEntity.findUnique({
      where: { hardwareEntityId },
      select: { reviewStatus: true, assetReadiness: true, lifecycleStatus: true },
    });
    if (!before) throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.hardwareEntity.update({
        where: { hardwareEntityId },
        data: { ...patch, ...(patch.reviewStatus === 'confirmed' ? { lastVerifiedAt: new Date() } : {}) },
        select: { reviewStatus: true, assetReadiness: true, lifecycleStatus: true },
      });
      // Wiring-ready artwork is a reviewer sign-off on the SVG too (§12).
      if (patch.assetReadiness === 'wiring_ready') {
        await tx.svgAsset.updateMany({ where: { hardwareEntityId }, data: { approvedBy: actor.label, approvedAt: new Date() } });
      }
      return updated;
    });
    await audit(actor.userId, 'HARDWARE_GOVERNANCE_UPDATED', hardwareEntityId, { before, after });
    return { hardwareEntityId, ...after };
  },
};
