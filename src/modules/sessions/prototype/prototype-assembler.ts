import crypto from 'node:crypto';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { allocatePins, AllocInstance, inputRange } from './prototype-allocator.js';
import { Board, parseVolts } from './prototype-board.js';
import {
  isPlaceholderEntity,
  isPlaceholderId,
  PlaceholderKind,
  placeholderEntity,
  placeholderId,
  placeholderKindFor,
  placeholderLinks,
} from './prototype-placeholders.js';
import { countResults, evaluateCompatibility } from './prototype-checks.js';
import { layoutPrototype } from './prototype-layout.js';
import { BenchArt, renderBenchArt } from '../../hardware/bench-art.js';
import { buildPinList } from './prototype-pin-list.js';
import { buildHardwareLibrary } from './prototype-library.js';
import {
  CompatibilityResult,
  ConnectionState,
  PROTOTYPE_SCHEMA_VERSION,
  PrototypeGap,
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
  /**
   * Volts of the bench's outside supply when the brief states one ("12V input"). A supply on the
   * bench that nothing else can feed is then drawn fed from a "12 V DC input" block.
   */
  externalSupplyVolts?: number | null;
}

/** The outside supply a brief states: "12V input", "24 V DC supply", "powered from 12V". */
export function externalSupplyVoltsOf(text: string): number | null {
  const m =
    /(\d+(?:\.\d+)?)\s*v(?:dc)?\b\s*(?:dc\s*)?(?:input|in\b|supply|adapter|power(?:\s+input)?|battery|feed)/i.exec(text) ??
    /(?:input|supply|powered\s+(?:from|by)|fed\s+(?:from|by))\s*(?:of|at|from)?\s*(\d+(?:\.\d+)?)\s*v\b/i.exec(text);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v >= 3 && v <= 60 ? v : null;
}

const PLACEHOLDER_WORDS: Array<[RegExp, string]> = [
  [/\bgps\b|gnss/i, 'gps'],
  [/bluetooth|\bble\b/i, 'ble'],
  [/ultrasonic/i, 'ultrasonic'],
  [/vibration/i, 'vibration'],
  [/soil/i, 'soil'],
  [/\bgas\b/i, 'gas'],
  [/pressure/i, 'pressure'],
  [/magnetometer/i, 'mag'],
  [/thermocouple/i, 'thermocouple'],
  [/display|oled|lcd/i, 'display'],
];
const KIND_WORD: Record<PlaceholderKind, string> = {
  I2C: 'i2c_dev', SPI: 'spi_dev', UART: 'serial', GPIO: 'io', ANALOG: 'analog', PWM: 'pwm',
  CAN: 'can_dev', CANXCVR: 'can_xcvr', RS485: 'modbus', RS485XCVR: 'rs485_xcvr', DCIN: 'dcin', NONE: 'module',
};

/**
 * A readable instance id for a placeholder, so its nets read "LIS3MDL1_CS" or "RS485_XCVR1_DE":
 * the part number the gap names, else what it is, else its kind. Never clashes with other ids.
 */
function placeholderInstanceId(gap: { need: string; suggestion: string }, kind: PlaceholderKind, taken: Set<string>): string {
  const text = `${gap.need} ${gap.suggestion}`;
  const part = /\b([A-Z]{2,}[0-9][A-Z0-9]*)\b/.exec(`${gap.need}`) ?? /\b([A-Z]{2,}[0-9][A-Z0-9]*)\b/.exec(gap.suggestion);
  const base =
    kind === 'CANXCVR' || kind === 'RS485XCVR'
      ? KIND_WORD[kind]
      : (part?.[1]?.toLowerCase() ?? PLACEHOLDER_WORDS.find(([re]) => re.test(text))?.[1] ?? KIND_WORD[kind]);
  const stem = base.replace(/[^a-z0-9_]/g, '').slice(0, 18) || 'module';
  const sep = /\d$/.test(stem) ? '_' : '';
  let n = 1;
  while (taken.has(`${stem}${sep}${n}`)) n++;
  const id = `${stem}${sep}${n}`;
  taken.add(id);
  return id;
}


/** Where the frontend loads a board's bench art from (hash = cache key). */
export function benchSvgRef(art: BenchArt, hardwareEntityId: string, isController: boolean, svgBasePath: string, label?: string): PrototypeSvgRef {
  // A placeholder is rebuilt from its id and label (it is never stored), so its label rides along.
  const query = [isController ? 'controller=1' : null, isPlaceholderId(hardwareEntityId) && label ? `name=${encodeURIComponent(label)}` : null].filter(Boolean);
  return {
    url: `${svgBasePath}/${encodeURIComponent(hardwareEntityId)}/bench.svg${query.length > 0 ? `?${query.join('&')}` : ''}`,
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
    benchSvgRef(benchOf(entity, isController), entity.hardwareEntityId, isController, options.svgBasePath, entity.record.identity.product_name);

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
  const libraryModules = composition.modules.filter((m) => entities.has(m.hardwareEntityId));

  // Every gap becomes a placeholder block on the bus it needs (only once there is a controller to
  // wire it to), so a brief that names N modules shows N blocks and a complete protocol design.
  const taken = new Set([composition.controller?.instanceId ?? 'mcu', ...libraryModules.map((m) => m.instanceId)]);
  const allEntities = new Map(entities);
  const gaps: PrototypeGap[] = composition.gaps.map((g, i) => ({ gapId: `g${i + 1}`, category: g.category, need: g.need, suggestion: g.suggestion, interface: g.interface ?? null }));
  const placeholderModules: Array<{ instanceId: string; hardwareEntityId: string; role: string; links: ReturnType<typeof placeholderLinks>; kind: PlaceholderKind; gap: PrototypeGap }> = [];
  if (controllerEntity) {
    for (const gap of gaps) {
      const kind = placeholderKindFor(gap);
      const instanceId = placeholderInstanceId(gap, kind, taken);
      const entity = placeholderEntity(placeholderId(kind, instanceId), gap.need || gap.suggestion || gap.category);
      if (!entity) continue;
      allEntities.set(entity.hardwareEntityId, entity);
      gap.instanceId = instanceId;
      gap.interface = gap.interface ?? (placeholderLinks(kind)[0]?.interface ?? null);
      placeholderModules.push({ instanceId, hardwareEntityId: entity.hardwareEntityId, role: gap.suggestion || gap.need, links: placeholderLinks(kind), kind, gap });
    }
  }

  // The bench's outside supply: when the brief states one and a supply on the bench takes it but
  // nothing on the bench can feed that supply, draw the input ("12 V DC input") feeding it.
  const supplyIn = options.externalSupplyVolts ?? null;
  if (controllerEntity && supplyIn !== null) {
    const supplyOutputs = libraryModules
      .map((m) => entities.get(m.hardwareEntityId)!)
      .filter((e) => e.record.interfaces.host_requirement !== 'host_required')
      .flatMap((e) => e.record.pins.filter((p) => p.direction === 'power_out').map((p) => parseVolts(p.voltage_domain) ?? parseVolts(p.pin_name)))
      .filter((v): v is number => v !== null);
    const takesIt = libraryModules.some((m) => {
      const e = entities.get(m.hardwareEntityId)!;
      if (e.record.interfaces.host_requirement === 'host_required') return false;
      const board = new Board(m.instanceId, e);
      const ranges = e.record.pins.filter((p) => p.direction === 'power_in').map((p) => inputRange(board, p)).filter((r): r is [number, number] => r !== null);
      const fits = (v: number, r: [number, number]) => v >= r[0] - 0.01 && v <= r[1] + 0.01;
      return ranges.some((r) => fits(supplyIn, r)) && !ranges.some((r) => supplyOutputs.some((v) => fits(v, r)));
    });
    if (takesIt) {
      const instanceId = taken.has('dcin') ? 'dcin_1' : 'dcin';
      taken.add(instanceId);
      const entity = placeholderEntity(placeholderId('DCIN', instanceId), `${supplyIn} V DC input`)!;
      allEntities.set(entity.hardwareEntityId, entity);
      placeholderModules.unshift({
        instanceId,
        hardwareEntityId: entity.hardwareEntityId,
        role: 'Outside supply stated in the brief',
        links: [],
        kind: 'DCIN',
        gap: { gapId: '', category: 'Power', need: `${supplyIn} V DC input`, suggestion: '' },
      });
    }
  }

  const modules = [...libraryModules, ...placeholderModules];
  const instances: PrototypeInstance[] = [];
  if (controllerEntity && composition.controller) {
    instances.push(toInstance(composition.controller.instanceId, controllerEntity, 'controller', true));
  }
  for (const m of libraryModules) instances.push(toInstance(m.instanceId, entities.get(m.hardwareEntityId)!, m.role || null, false));
  for (const m of placeholderModules) {
    instances.push({
      ...toInstance(m.instanceId, allEntities.get(m.hardwareEntityId)!, m.role || null, false),
      placeholder: { kind: m.kind, gapId: m.gap.gapId, need: m.gap.need, suggestion: m.gap.suggestion },
    });
  }
  // Two of the same board read as "Adafruit BME280" and "Adafruit BME280 #2".
  const seen = new Map<string, number>();
  for (const instance of instances) {
    const n = (seen.get(instance.hardwareEntityId) ?? 0) + 1;
    seen.set(instance.hardwareEntityId, n);
    if (n > 1) instance.label = `${instance.label} #${n}`;
  }

  let nets: PrototypeArchitecture['nets'] = [];
  let connections: PrototypeConnection[] = [];
  let results: CompatibilityResult[] = [];
  let requiredPins = new Map<string, Set<string>>();

  if (controllerEntity && composition.controller) {
    const controller: AllocInstance = { instanceId: composition.controller.instanceId, entity: controllerEntity, links: [] };
    const peripherals: AllocInstance[] = modules.map((m) => ({ instanceId: m.instanceId, entity: allEntities.get(m.hardwareEntityId)!, links: m.links }));
    const allocation = allocatePins(controller, peripherals);
    results = [...allocation.results, ...evaluateCompatibility(controller, peripherals, allocation)];
    // A board on the bench with nothing wired to it (no power, ground or signal) is reported, unless
    // a failed or unverified controller-link check already names it.
    const onNets = new Set(allocation.nets.flatMap((n) => n.members.map((m) => m.instanceId)));
    for (const m of libraryModules) {
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
      const entity = allEntities.get(i.hardwareEntityId)!;
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
        outsideSupply: i.placeholder?.kind === 'DCIN',
      };
    }),
    nets,
    connections,
    gaps,
    drawProposed: false,
    projectName: options.projectName,
  });

  const pinList = buildPinList({ instances, entities: allEntities, nets, connections, results, requiredPins });
  // Placeholders are not library records: they never appear as one (Source, Module Specs records).
  const hardwareLibrary = buildHardwareLibrary(
    instances.filter((i) => !isPlaceholderEntity(allEntities.get(i.hardwareEntityId)!)),
    entities,
    svgRef
  );

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
