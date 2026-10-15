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
  /** Base path for module artwork, e.g. "/api/v1/hardware/entities". */
  svgBasePath: string;
  projectName: string;
  understanding: string;
  notes: string;
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
    // A board on the bench with nothing wired to it (no power, ground or signal) is reported, unless
    // a failed or unverified controller-link check already names it.
    const onNets = new Set(allocation.nets.flatMap((n) => n.members.map((m) => m.instanceId)));
    for (const m of modules) {
      if (onNets.has(m.instanceId)) continue;
      const covered = results.some((r) => r.ruleType === 'required_host_interface' && r.status !== 'PASS' && r.status !== 'WARNING' && r.instanceIds.includes(m.instanceId));
      if (covered) continue;
      const label = instances.find((i) => i.instanceId === m.instanceId)?.label ?? m.instanceId;
      results.push({
        ruleType: 'required_host_interface',
        status: 'WARNING',
        message: `${label} is on the bench but nothing is wired to it (no power, ground or signal).`,
        suggestedFix: 'Remove it if the controller already does its job, or say how it should connect.',
        instanceIds: [m.instanceId],
        pinIds: [],
      });
    }
    nets = allocation.nets;
    requiredPins = allocation.requiredPins;

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
    // A connection is drawn unless a failing or unverifiable check touches it. Whether a board has
    // been accepted into the shared library is internal (admin review) and never changes the
    // drawing: users see check results, not review status (product decision 2026-10-14).
    connections = allocation.connections.map((c) => {
      const pins = pinsOf(c);
      const blocked = failing.some((r) => r.pinIds.some((p) => pins.has(p)));
      const state: ConnectionState = blocked ? 'blocked' : 'drawn';
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
        badge: null,
      };
    }),
    nets,
    connections,
    gaps,
    drawProposed: false,
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
