import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { sessionsService } from '../sessions/sessions.service.js';
import { hardwareLibraryService, LibraryEntity } from './hardware-library.service.js';
import { renderBenchArt } from './bench-art.js';
import { isPlaceholderId, placeholderEntity } from '../sessions/prototype/prototype-placeholders.js';
import { projectSharingAccessService } from '../shares/project-sharing-access.service.js';

/**
 * Read access to library boards for the Prototype UI (module artwork + record summary).
 * Shared-library records are catalogue data and readable by anyone who can use the app, whatever
 * their review state — a saved version must keep rendering the exact board it used (§19.2).
 * A private record is readable only by the owner of the project it belongs to.
 */
async function loadVisible(req: Request): Promise<LibraryEntity> {
  const entity = await hardwareLibraryService.getOne(req.params['id'] as string);
  if (!entity) throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
  if (entity.scope === 'private_project') {
    const project = entity.projectId
      ? await prisma.designSession.findUnique({ where: { id: entity.projectId }, select: { userId: true, anonSessionToken: true, deletedAt: true } })
      : null;
    if (!project) throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
    if (req.user?.id && project.userId !== req.user.id) {
      if (!(await projectSharingAccessService.canEdit(entity.projectId!, req.user.id))) {
        throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
      }
    } else {
      try {
        sessionsService.verifySessionOwnership(project, req.user?.id, req.anonSessionToken);
      } catch {
        // Same answer as a missing id: never confirm that another project's private board exists.
        throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
      }
    }
  }
  return entity;
}

export class HardwareController {
  getEntity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const entity = await loadVisible(req);
      const { identity, electrical, interfaces, compatibility_hints } = entity.record;
      res.status(200).json({
        success: true,
        data: {
          hardwareEntityId: entity.hardwareEntityId,
          productFamilyId: entity.productFamilyId,
          productName: identity.product_name,
          vendor: identity.vendor,
          vendorSku: identity.vendor_sku ?? null,
          group: identity.group,
          functionalCategories: identity.functional_categories,
          prototypeRole: identity.prototype_role ?? null,
          mainSilicon: identity.main_silicon ?? null,
          isController: entity.isController,
          governance: {
            reviewStatus: entity.reviewStatus,
            assetReadiness: entity.assetReadiness,
            verificationMethod: entity.verificationMethod,
            recordOrigin: entity.recordOrigin,
            lifecycleStatus: entity.lifecycleStatus,
            scope: entity.scope,
          },
          electrical: {
            supplyVoltageMinV: electrical.supply_voltage_min_v ?? null,
            supplyVoltageMaxV: electrical.supply_voltage_max_v ?? null,
            logicLevel: electrical.logic_level_summary ?? null,
          },
          interfaces: interfaces.interfaces.map((i) => ({ type: i.type, addresses: i.addresses })),
          knownIncompatibleNotes: compatibility_hints.known_incompatible_notes,
          pins: entity.record.pins.map((p) => ({
            pinId: p.pin_id,
            name: p.pin_name,
            signalClass: p.signal_class,
            direction: p.direction,
            voltageDomain: p.voltage_domain ?? null,
            functions: p.functions,
          })),
          sources: entity.sources,
          svg: entity.svg
            ? { url: `${req.baseUrl}/entities/${encodeURIComponent(entity.hardwareEntityId)}/svg`, hash: entity.svg.hash, width: entity.svg.parsed.width, height: entity.svg.parsed.height }
            : null,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  getSvg = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const entity = await loadVisible(req);
      if (!entity.svg) throw new AppError(404, 'NOT_FOUND', 'This board has no validated artwork yet');
      const etag = `"${entity.svg.hash.replace(/^sha256:/, '').slice(0, 64)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', entity.scope === 'private_project' ? 'private, max-age=300' : 'public, max-age=300');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      // Imported SVGs are already rejected if they contain script or remote content; the CSP is a
      // second fence for anyone opening the URL directly.
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(200).send(entity.svg.markup);
    } catch (err) {
      next(err);
    }
  };

  /** The board as drawn on the Prototype module diagram (bench art, rendered from the record). */
  getBenchSvg = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] as string;
      // A placeholder holds no data: anyone may draw one from its id and label.
      const entity = isPlaceholderId(id) ? placeholderEntity(id, String(req.query['name'] ?? '')) : await loadVisible(req);
      if (!entity) throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
      const art = renderBenchArt(entity.record, req.query['controller'] === '1', req.query['theme'] === 'light' ? 'light' : 'dark');
      const etag = `"${art.hash.replace(/^sha256:/, '').slice(0, 64)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', entity.scope === 'private_project' ? 'private, max-age=300' : 'public, max-age=300');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.status(200).send(art.svg);
    } catch (err) {
      next(err);
    }
  };
}

export const hardwareController = new HardwareController();
