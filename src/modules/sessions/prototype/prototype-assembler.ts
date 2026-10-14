import crypto from 'node:crypto';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { allocatePins, AllocInstance } from './prototype-allocator.js';
import { countResults, evaluateCompatibility } from './prototype-checks.js';
import { layoutPrototype } from './prototype-layout.js';
import { BenchArt, renderBenchArt } from '../../hardware/bench-art.js';
import { buildPinList } from './prototype-pin-list.js';
import { buildHardwareLibrary } from './prototype-library.js';
import {
  CompatibilityResult,
  ConnectionState,
  PROTOTYPE_SCHEMA_VERSION,
  PrototypeArchitecture,
  PrototypeComposition,
  PrototypeConnection,
  PrototypeInstance,
  PrototypeSvgRef,
} from './prototype.types.js';

/**
 * Turns the resolver's selection into the full Prototype payload. Pure and deterministic: the same
 * composition and library records always give the same nets, wires, geometry and pin list.
 */

export interface AssembleOptions {
  /** PROTOTYPE_ALLOW_PROVISIONAL: draw not-yet-reviewed wiring dashed instead of hiding it. */
  allowProvisional: boolean;
  /** Base path for module artwork, e.g. "/api/v1/hardware/entities". */
  svgBasePath: string;
  projectName: string;
  understanding: string;
  notes: string;
}

const isWiringReady = (entity: LibraryEntity) => entity.reviewStatus === 'confirmed' && entity.assetReadiness === 'wiring_ready';

export function badgeFor(entity: LibraryEntity): string | null {
  if (!entity.svg) return 'NO ARTWORK';
  if (entity.scope === 'private_project') return 'PRIVATE · PROVISIONAL';
  if (entity.reviewStatus !== 'confirmed') return 'PROVISIONAL';
  if (entity.assetReadiness !== 'wiring_ready') return 'AWAITING WIRING REVIEW';
  return null;
}

/** Where the frontend loads a board's bench art from (hash = cache key). */
export function benchSvgRef(art: BenchArt, hardwareEntityId: string, isController: boolean, svgBasePath: string): PrototypeSvgRef {
  return {
    url: `${svgBasePath}/${encodeURIComponent(hardwareEntityId)}/bench.svg${isController ? '?controller=1' : ''}`,
    hash: art.hash,
    width: art.width,
    height: art.height,
  };
}

export function assemblePrototype(
  composition: PrototypeComposition,
  entities: Map<string, LibraryEntity>,
  options: AssembleOptions
): PrototypeArchitecture {
  const svgRef = (entity: LibraryEntity): PrototypeSvgRef | null =>
    entity.svg
      ? {
          url: `${options.svgBasePath}/${encodeURIComponent(entity.hardwareEntityId)}/svg`,
          hash: entity.svg.hash,
          width: entity.svg.parsed.width,
          height: entity.svg.parsed.height,
        }
      : null;

  // The diagram draws every board in bench style, rendered from its record (see bench-art.ts).
  const benchCache = new Map<string, BenchArt>();
  const benchOf = (entity: LibraryEntity, isController: boolean): BenchArt => {
    const key = `${entity.hardwareEntityId}|${isController}`;
    if (!benchCache.has(key)) benchCache.set(key, renderBenchArt(entity.record, isController));
    return benchCache.get(key)!;
  };
  const benchRef = (entity: LibraryEntity, isController: boolean): PrototypeSvgRef =>
    benchSvgRef(benchOf(entity, isController), entity.hardwareEntityId, isController, options.svgBasePath);

  const toInstance = (instanceId: string, entity: LibraryEntity, role: string | null, isController: boolean): PrototypeInstance => ({
    instanceId,
    hardwareEntityId: entity.hardwareEntityId,
    label: entity.record.identity.product_name,
    role,
    isController,
    reviewStatus: entity.reviewStatus,
    assetReadiness: entity.assetReadiness,
    scope: entity.scope,
    svg: benchRef(entity, isController),
  });

  const controllerEntity = composition.controller ? entities.get(composition.controller.hardwareEntityId) : undefined;
  const modules = composition.modules.filter((m) => entities.has(m.hardwareEntityId));
  const instances: PrototypeInstance[] = [];
  if (controllerEntity && composition.controller) {
    instances.push(toInstance(composition.controller.instanceId, controllerEntity, 'controller', true));
  }
  for (const m of modules) instances.push(toInstance(m.instanceId, entities.get(m.hardwareEntityId)!, m.role || null, false));
  // Two of the same board read as "Adafruit BME280" and "Adafruit BME280 #2".
  const seen = new Map<string, number>();
  for (const instance of instances) {
    const n = (seen.get(instance.hardwareEntityId) ?? 0) + 1;
    seen.set(instance.hardwareEntityId, n);
    if (n > 1) instance.label = `${instance.label} #${n}`;
  }

  const gaps = composition.gaps.map((g, i) => ({ gapId: `g${i + 1}`, category: g.category, need: g.need, suggestion: g.suggestion }));

  let nets: PrototypeArchitecture['nets'] = [];
  let connections: PrototypeConnection[] = [];
  let results: CompatibilityResult[] = [];
  let requiredPins = new Map<string, Set<string>>();

  if (controllerEntity && composition.controller) {
    const controller: AllocInstance = { instanceId: composition.controller.instanceId, entity: controllerEntity, links: [] };
    const peripherals: AllocInstance[] = modules.map((m) => ({ instanceId: m.instanceId, entity: entities.get(m.hardwareEntityId)!, links: m.links }));
    const allocation = allocatePins(controller, peripherals);
    results = [...allocation.results, ...evaluateCompatibility(controller, peripherals, allocation)];
    nets = allocation.nets;
    requiredPins = allocation.requiredPins;

    const entityOf = (instanceId: string) => entities.get(instances.find((i) => i.instanceId === instanceId)?.hardwareEntityId ?? '');
    const failing = results.filter((r) => r.status === 'BLOCKER' || r.status === 'UNKNOWN');
    const pinsOf = (c: (typeof allocation.connections)[number]): Set<string> => {
      const pins = new Set<string>();
      for (const net of nets) {
        if (!c.netIds.includes(net.netId)) continue;
        for (const m of net.members) {
          const isEnd =
            c.kind === 'cable'
              ? m.instanceId === c.from.instanceId || m.instanceId === c.to.instanceId
              : (m.instanceId === c.from.instanceId && m.anchorId === c.from.anchorId) || (m.instanceId === c.to.instanceId && m.anchorId === c.to.anchorId);
          if (isEnd) pins.add(m.pinId);
        }
      }
      return pins;
    };
    // Gating per connection (plan D5): drawn only when both boards are wiring-ready and no BLOCKER
    // or UNKNOWN touches it; otherwise the mapping is shown but not asserted.
    connections = allocation.connections.map((c) => {
      const pins = pinsOf(c);
      const blocked = failing.some((r) => r.pinIds.some((p) => pins.has(p)));
      const fromEntity = entityOf(c.from.instanceId);
      const toEntity = entityOf(c.to.instanceId);
      const ready = Boolean(fromEntity && toEntity && isWiringReady(fromEntity) && isWiringReady(toEntity));
      const state: ConnectionState = blocked ? 'blocked' : ready ? 'drawn' : 'proposed';
      return { ...c, state };
    });
  }

  const moduleDiagram = layoutPrototype({
    instances: instances.map((i) => {
      const entity = entities.get(i.hardwareEntityId)!;
      const art = benchOf(entity, i.isController);
      return {
        instanceId: i.instanceId,
        label: i.label,
        isController: i.isController,
        width: art.width,
        height: art.height,
        anchors: art.anchors,
        inset: art.inset,
        edges: art.edges,
        badge: badgeFor(entity),
      };
    }),
    nets,
    connections,
    gaps,
    drawProposed: options.allowProvisional,
    projectName: options.projectName,
  });

  const pinList = buildPinList({ instances, entities, nets, connections, results, requiredPins });
  const hardwareLibrary = buildHardwareLibrary(instances, entities, svgRef);

  const stateHash = `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        instances: instances.map((i) => [i.instanceId, i.hardwareEntityId]).sort(),
        connections: connections.map((c) => [c.kind, c.from.instanceId, c.from.anchorId, c.to.instanceId, c.to.anchorId, [...c.netIds].sort()]),
      })
    )
    .digest('hex')}`;

  const controllerLabel = instances.find((i) => i.isController)?.label ?? 'No controller selected';
  return {
    kind: 'prototype',
    schemaVersion: PROTOTYPE_SCHEMA_VERSION,
    understanding: options.understanding,
    notes: options.notes,
    stateHash,
    projectMeta: { name: options.projectName, tagline: options.understanding, controller: controllerLabel },
    instances,
    nets,
    connections,
    gaps,
    compatibility: { results, counts: countResults(results) },
    moduleDiagram,
    pinList,
    hardwareLibrary,
  };
}
