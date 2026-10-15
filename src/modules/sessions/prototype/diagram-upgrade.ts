import { env } from '../../../config/env.js';
import { renderBenchArt } from '../../hardware/bench-art.js';
import { hardwareLibraryService, LibraryEntity } from '../../hardware/hardware-library.service.js';
import { benchSvgRef } from './prototype-assembler.js';
import { LAYOUT_VERSION, layoutPrototype } from './prototype-layout.js';
import { isPrototypeArchitecture, PrototypeArchitecture } from './prototype.types.js';

/**
 * Prototype payloads are normalised when served (nothing is written back to the database):
 *
 * - Saved with an older layout (no `buses`, or `layoutVersion` below the current one): redrawn, so
 *   the old lane drawing, old board artwork and over-wide single backbones never render again.
 *   Only the drawing changes.
 * - Saved before 2026-10-14: library review status was shown to users (PROVISIONAL badges, wiring
 *   "proposed, awaiting review" drawn dashed). Review status is internal, so it is scrubbed: a
 *   connection is drawn unless a check blocks it, and no review badge or note remains.
 */

const needsUpgrade = (value: unknown): value is PrototypeArchitecture =>
  isPrototypeArchitecture(value) &&
  Boolean(value.moduleDiagram) &&
  (!Array.isArray(value.moduleDiagram.buses) || (value.moduleDiagram.layoutVersion ?? 0) < LAYOUT_VERSION);

/** Redraws one payload with the current layout + bench art. Returns other values unchanged. */
export function upgradeWithEntities<T>(value: T, entities: Map<string, LibraryEntity>): T {
  if (!needsUpgrade(value)) return value;
  const a = value;
  const svgBasePath = `${env.API_PREFIX}/hardware/entities`;
  const instances = a.instances.map((i) => {
    const entity = entities.get(i.hardwareEntityId);
    return entity ? { ...i, svg: benchSvgRef(renderBenchArt(entity.record, i.isController), i.hardwareEntityId, i.isController, svgBasePath) } : i;
  });
  const moduleDiagram = layoutPrototype({
    instances: a.instances.map((i) => {
      const entity = entities.get(i.hardwareEntityId);
      const art = entity ? renderBenchArt(entity.record, i.isController) : null;
      return {
        instanceId: i.instanceId,
        label: i.label,
        isController: i.isController,
        width: art?.width ?? null,
        height: art?.height ?? null,
        anchors: art?.anchors ?? new Map(),
        inset: art?.inset ?? 0,
        edges: art?.edges,
        badge: null,
      };
    }),
    nets: a.nets,
    connections: a.connections,
    gaps: a.gaps,
    drawProposed: false,
    projectName: a.projectMeta?.name,
  });
  return { ...a, instances, moduleDiagram } as T;
}

/** Hardware ids an old-format payload needs, so many payloads can share one library read. */
export function boardsToUpgrade(value: unknown): string[] {
  return needsUpgrade(value) ? value.instances.map((i) => i.hardwareEntityId) : [];
}

export async function upgradePrototypeDiagram<T>(value: T): Promise<T> {
  const scrubbed = scrubReviewState(value);
  const ids = boardsToUpgrade(scrubbed);
  if (ids.length === 0) return scrubbed;
  return upgradeWithEntities(scrubbed, await hardwareLibraryService.getByIds(ids));
}

/** Upgrades many payloads with one library read. */
export async function upgradePrototypeDiagrams<T>(values: T[]): Promise<T[]> {
  const ids = [...new Set(values.flatMap(boardsToUpgrade))];
  if (ids.length === 0) return values.map(scrubReviewState);
  const entities = await hardwareLibraryService.getByIds(ids);
  return values.map((v) => upgradeWithEntities(scrubReviewState(v), entities));
}

/** Removes library review status from a stored payload (see the header comment). */
export function scrubReviewState<T>(value: T): T {
  if (!isPrototypeArchitecture(value)) return value;
  const a = value;
  const connections = a.connections.map((c) => (c.state === 'proposed' ? { ...c, state: 'drawn' as const } : c));
  const d = a.moduleDiagram;
  const moduleDiagram = d
    ? {
        ...d,
        modules: d.modules.map((m) => (m.badge ? { ...m, badge: null } : m)),
        wires: d.wires.map((w) => (w.dashed && !w.blocked ? { ...w, dashed: false } : w)),
        ...(d.buses
          ? {
              buses: d.buses.map((b) => ({
                ...b,
                dashed: Boolean(b.blocked && b.dashed),
                taps: b.taps.map((t) => ({ ...t, dashed: Boolean(t.blocked && t.dashed) })),
              })),
            }
          : {}),
        legendCard: d.legendCard
          ? { ...d.legendCard, dashedNote: false, rows: d.legendCard.rows.map((r) => ({ ...r, dashed: Boolean(r.blocked && r.dashed) })) }
          : d.legendCard,
      }
    : d;
  const pinList = a.pinList
    ? {
        ...a.pinList,
        rows: a.pinList.rows.map((r) => (r.status === 'proposed' ? { ...r, status: 'assigned' as const, note: r.note === 'awaiting wiring review' ? null : r.note } : r)),
        summary: { ...a.pinList.summary, assigned: a.pinList.summary.assigned + (a.pinList.summary.proposed ?? 0), proposed: 0 },
      }
    : a.pinList;
  return { ...a, connections, moduleDiagram, pinList } as T;
}
