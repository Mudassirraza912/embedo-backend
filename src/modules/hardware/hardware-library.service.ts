import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AssetReadiness, HardwareRecord, hardwareRecordSchema, isControllerRecord } from './hardware.schema.js';
import { parseModuleSvg, ParsedModuleSvg } from './hardware-svg.js';

/** One library board as the Prototype runtime sees it: governance columns + parsed facts + artwork. */
export interface LibraryEntity {
  hardwareEntityId: string;
  productFamilyId: string;
  preferredInFamily: boolean;
  reviewStatus: string;
  lifecycleStatus: string;
  assetReadiness: AssetReadiness;
  scope: string;
  verificationMethod: string;
  recordOrigin: string;
  projectId: string | null;
  isController: boolean;
  record: HardwareRecord;
  sources: Array<{ sourceType: string; url: string | null; official: boolean }>;
  svg: { hash: string; markup: string; parsed: ParsedModuleSvg } | null;
}

/** Readiness that has artwork, i.e. can be placed on the bench (truth file §12, plan D4 step 2). */
const PLACEABLE_READINESS: AssetReadiness[] = ['visual_ready', 'wiring_ready'];

/**
 * Truth-file eligibility (plan D4): shared confirmed records, plus this project's private records
 * (including provisional ones the sourcer created for it).
 * With PROTOTYPE_ALLOW_PROVISIONAL (dev only) provisional records with artwork are searchable too.
 */
export function eligibilityWhere(projectId: string | null, allowProvisional = env.PROTOTYPE_ALLOW_PROVISIONAL): Prisma.HardwareEntityWhereInput {
  return {
    assetReadiness: { in: PLACEABLE_READINESS },
    lifecycleStatus: { not: 'discontinued' },
    svgAsset: { isNot: null },
    OR: [
      { scope: 'shared_library', reviewStatus: allowProvisional ? { in: ['confirmed', 'provisional'] } : 'confirmed' },
      // A project's own sourced boards are usable in that project while they await review; they
      // are drawn as unverified and never appear in any other project.
      ...(projectId ? [{ scope: 'private_project', projectId, reviewStatus: { in: ['confirmed', 'provisional'] } }] : []),
    ],
  };
}

const entityInclude = {
  family: { select: { preferredHardwareEntityId: true } },
  sources: { select: { sourceType: true, url: true, official: true } },
  svgAsset: { select: { generationSourceHash: true, svgMarkup: true } },
} satisfies Prisma.HardwareEntityInclude;

type EntityRow = Prisma.HardwareEntityGetPayload<{ include: typeof entityInclude }>;

function toLibraryEntity(row: EntityRow): LibraryEntity | null {
  const parsed = hardwareRecordSchema.safeParse(row.metadataJson);
  if (!parsed.success) {
    logger.warn({ hardwareEntityId: row.hardwareEntityId, issues: parsed.error.issues.slice(0, 3) }, 'Library record no longer parses; skipped');
    return null;
  }
  let svg: LibraryEntity['svg'] = null;
  if (row.svgAsset) {
    try {
      svg = {
        hash: row.svgAsset.generationSourceHash,
        markup: row.svgAsset.svgMarkup,
        parsed: parseModuleSvg(row.svgAsset.svgMarkup, row.svgAsset.generationSourceHash),
      };
    } catch (err) {
      logger.warn({ hardwareEntityId: row.hardwareEntityId, err }, 'Library SVG no longer parses; board placed without artwork');
    }
  }
  return {
    hardwareEntityId: row.hardwareEntityId,
    productFamilyId: row.productFamilyId,
    preferredInFamily: row.family.preferredHardwareEntityId === row.hardwareEntityId,
    reviewStatus: row.reviewStatus,
    lifecycleStatus: row.lifecycleStatus,
    assetReadiness: row.assetReadiness as AssetReadiness,
    scope: row.scope,
    verificationMethod: row.verificationMethod,
    recordOrigin: row.recordOrigin,
    projectId: row.projectId,
    isController: isControllerRecord(parsed.data),
    record: parsed.data,
    sources: row.sources,
    svg,
  };
}

export const hardwareLibraryService = {
  /** Every board the resolver may choose from for this project. */
  async listEligible(projectId: string | null): Promise<LibraryEntity[]> {
    const rows = await prisma.hardwareEntity.findMany({
      where: eligibilityWhere(projectId),
      include: entityInclude,
      orderBy: { hardwareEntityId: 'asc' },
    });
    return rows.map(toLibraryEntity).filter((e): e is LibraryEntity => e !== null);
  },

  /**
   * The exact entities a stored composition references, whatever their current eligibility.
   * Versions pin hardware_entity_ids (§19.2), so a board that was since rejected is still shown —
   * the caller decides how to flag it.
   */
  async getByIds(ids: string[]): Promise<Map<string, LibraryEntity>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.hardwareEntity.findMany({ where: { hardwareEntityId: { in: [...new Set(ids)] } }, include: entityInclude });
    const entities = rows.map(toLibraryEntity).filter((e): e is LibraryEntity => e !== null);
    return new Map(entities.map((e) => [e.hardwareEntityId, e]));
  },

  async getOne(id: string): Promise<LibraryEntity | null> {
    const row = await prisma.hardwareEntity.findUnique({ where: { hardwareEntityId: id }, include: entityInclude });
    return row ? toLibraryEntity(row) : null;
  },
};
