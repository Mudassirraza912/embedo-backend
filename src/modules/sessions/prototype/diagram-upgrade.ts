import { env } from '../../../config/env.js';
import { renderBenchArt } from '../../hardware/bench-art.js';
import { hardwareLibraryService, LibraryEntity } from '../../hardware/hardware-library.service.js';
import { badgeFor, benchSvgRef } from './prototype-assembler.js';
import { layoutPrototype } from './prototype-layout.js';
import { isPrototypeArchitecture, PrototypeArchitecture } from './prototype.types.js';

/**
 * Prototype payloads saved before the bus-backbone layout (moduleDiagram without `buses`) are
 * redrawn when served, so the old lane drawing and the old board artwork never render again.
 * Only the drawing changes: the stored instances, nets, connections, gaps, checks, pin list and
 * library entries are kept exactly as saved. Nothing is written back to the database.
 */

const needsUpgrade = (value: unknown): value is PrototypeArchitecture =>
  isPrototypeArchitecture(value) && Boolean(value.moduleDiagram) && !Array.isArray(value.moduleDiagram.buses);

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
        badge: entity ? badgeFor(entity) : null,
      };
    }),
    nets: a.nets,
    connections: a.connections,
    gaps: a.gaps,
    // Same as the pipeline: unreviewed wiring is drawn dashed, never hidden.
    drawProposed: true,
    projectName: a.projectMeta?.name,
  });
  return { ...a, instances, moduleDiagram } as T;
}

/** Hardware ids an old-format payload needs, so many payloads can share one library read. */
export function boardsToUpgrade(value: unknown): string[] {
  return needsUpgrade(value) ? value.instances.map((i) => i.hardwareEntityId) : [];
}

export async function upgradePrototypeDiagram<T>(value: T): Promise<T> {
  const ids = boardsToUpgrade(value);
  if (ids.length === 0) return value;
  return upgradeWithEntities(value, await hardwareLibraryService.getByIds(ids));
}

/** Upgrades many payloads with one library read. */
export async function upgradePrototypeDiagrams<T>(values: T[]): Promise<T[]> {
  const ids = [...new Set(values.flatMap(boardsToUpgrade))];
  if (ids.length === 0) return values;
  const entities = await hardwareLibraryService.getByIds(ids);
  return values.map((v) => upgradeWithEntities(v, entities));
}
