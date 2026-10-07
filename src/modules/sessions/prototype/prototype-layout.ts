import { SvgAnchor } from '../../hardware/hardware-svg.js';
import {
  DiagramModule,
  DiagramWire,
  ModuleDiagram,
  NetClass,
  Point,
  PrototypeConnection,
  PrototypeGap,
  PrototypeNet,
} from './prototype.types.js';

/**
 * Deterministic bench layout (plan D5 step 6), ported from the harness compose():
 * the controller sits in the centre column, each module goes to the left or right column depending
 * on which controller edge its links attach to, and each side gets its own channel of vertical bus
 * lanes. Wires leave the module anchor, run to their lane, then to the controller anchor — all
 * orthogonal. Output is absolute geometry the frontend draws directly over the library SVGs.
 */

export const NET_COLORS: Record<NetClass | 'cable', string> = {
  power: '#F5B84B',
  ground: '#6E8B8F',
  i2c: '#20E6E0',
  spi: '#9CD7D5',
  uart: '#019893',
  gpio: '#7FB3B5',
  analog: '#B48EF5',
  pwm: '#F58E6E',
  cable: '#20E6E0',
};

const LEGEND_LABELS: Record<NetClass | 'cable', string> = {
  power: 'Power',
  ground: 'Ground',
  i2c: 'I2C',
  spi: 'SPI',
  uart: 'UART',
  gpio: 'GPIO',
  analog: 'Analog',
  pwm: 'PWM',
  cable: 'STEMMA QT / Qwiic cable',
};

const PAD = 46;
const HEADER = 34;
const GAP_Y = 54;
const LANE_PITCH = 22;
const LANE_MARGIN = 40;
const CONTROLLER_MARGIN = 60;
const ESCAPE = 14;
const PLACEHOLDER = { width: 220, height: 120 };
const GAP_BOX = { width: 220, height: 64, spacing: 16 };

export interface LayoutInstance {
  instanceId: string;
  label: string;
  isController: boolean;
  width: number | null;
  height: number | null;
  anchors: Map<string, SvgAnchor>;
  badge: string | null;
}

export interface LayoutInput {
  instances: LayoutInstance[];
  nets: PrototypeNet[];
  connections: PrototypeConnection[];
  gaps: PrototypeGap[];
  /** Draw `proposed` connections dashed (dev override). Off: only `drawn` connections get a wire. */
  drawProposed: boolean;
}

type Side = 'left' | 'right';
type Edge = 'left' | 'right' | 'top' | 'bottom';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Which edge of its artwork an anchor sits on (anchors sit just outside the board outline). */
function edgeOf(anchor: { x: number; y: number }, width: number, height: number): Edge {
  const distances: Array<[Edge, number]> = [
    ['left', anchor.x],
    ['right', width - anchor.x],
    ['top', anchor.y],
    ['bottom', height - anchor.y],
  ];
  return distances.sort((a, b) => a[1] - b[1])[0]![0];
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const q: Point = [r1(p[0]), r1(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  // Drop collinear middle points so every segment is a real turn.
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true;
    const a = out[i - 1]!;
    const b = out[i + 1]!;
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
  });
}

export function layoutPrototype(input: LayoutInput): ModuleDiagram {
  const controller = input.instances.find((i) => i.isController) ?? null;
  const peripherals = input.instances.filter((i) => i !== controller);
  const sizeOf = (i: LayoutInstance) => ({ width: i.width ?? PLACEHOLDER.width, height: i.height ?? PLACEHOLDER.height });
  const visible = input.connections.filter((c) => c.state === 'drawn' || (c.state === 'proposed' && input.drawProposed));
  const netById = new Map(input.nets.map((n) => [n.netId, n]));

  // --- sides: majority of the controller anchors each module connects to --------------------------
  const ctrlSize = controller ? sizeOf(controller) : PLACEHOLDER;
  const sideVotes = new Map<string, { left: number; right: number; ys: number[] }>();
  const hostOf = new Map<string, string>(); // chained cable: module -> module it hangs off
  for (const c of input.connections) {
    const ends = [c.from, c.to];
    const ctrlEnd = controller ? ends.find((e) => e.instanceId === controller.instanceId) : undefined;
    const other = ends.find((e) => e !== ctrlEnd)!;
    if (!ctrlEnd) {
      hostOf.set(c.to.instanceId, c.from.instanceId);
      continue;
    }
    const anchor = controller!.anchors.get(ctrlEnd.anchorId);
    if (!anchor) continue;
    const vote = sideVotes.get(other.instanceId) ?? { left: 0, right: 0, ys: [] };
    if (anchor.x < ctrlSize.width / 2) vote.left += 1;
    else vote.right += 1;
    vote.ys.push(anchor.y);
    sideVotes.set(other.instanceId, vote);
  }

  const sideOf = new Map<string, Side>();
  const orderKey = new Map<string, number>();
  const heights = { left: 0, right: 0 };
  const resolveSide = (id: string, depth = 0): Side => {
    const known = sideOf.get(id);
    if (known) return known;
    const vote = sideVotes.get(id);
    let side: Side;
    if (vote && vote.left !== vote.right) side = vote.left > vote.right ? 'left' : 'right';
    else if (hostOf.has(id) && depth < 16) side = resolveSide(hostOf.get(id)!, depth + 1);
    else side = heights.left <= heights.right ? 'left' : 'right';
    sideOf.set(id, side);
    return side;
  };
  for (const p of peripherals) {
    const side = resolveSide(p.instanceId);
    heights[side] += sizeOf(p).height + GAP_Y;
    const vote = sideVotes.get(p.instanceId);
    const host = hostOf.get(p.instanceId);
    orderKey.set(
      p.instanceId,
      vote && vote.ys.length > 0
        ? vote.ys.reduce((a, b) => a + b, 0) / vote.ys.length
        : host
          ? (orderKey.get(host) ?? ctrlSize.height) + 0.5
          : ctrlSize.height
    );
  }
  const column = (side: Side) =>
    peripherals
      .filter((p) => sideOf.get(p.instanceId) === side)
      .sort((a, b) => (orderKey.get(a.instanceId) ?? 0) - (orderKey.get(b.instanceId) ?? 0) || a.instanceId.localeCompare(b.instanceId));
  const columns = { left: column('left'), right: column('right') };

  // --- lanes: one per (side, net) for wires, one per cable ---------------------------------------
  interface Lane {
    key: string;
    side: Side;
    netId: string | null;
    color: string;
    sortY: number;
    x: number;
  }
  const lanes = new Map<string, Lane>();
  const laneOf = new Map<string, string>();
  const peripheralEnd = (c: PrototypeConnection) => (controller && c.from.instanceId === controller.instanceId ? c.to : c.from);
  for (const c of visible) {
    const end = peripheralEnd(c);
    const side = sideOf.get(end.instanceId) ?? 'left';
    const key = c.kind === 'cable' ? `${side}|cable|${c.id}` : `${side}|net|${c.netIds[0]}`;
    laneOf.set(c.id, key);
    const ctrlEnd = c.from === end ? c.to : c.from;
    const ctrlAnchorY = controller?.anchors.get(ctrlEnd.anchorId)?.y ?? 0;
    const existing = lanes.get(key);
    if (existing) {
      existing.sortY = Math.min(existing.sortY, ctrlAnchorY);
    } else {
      const netClass = c.kind === 'cable' ? 'cable' : (netById.get(c.netIds[0] ?? '')?.class ?? 'gpio');
      lanes.set(key, { key, side, netId: c.kind === 'cable' ? null : (c.netIds[0] ?? null), color: NET_COLORS[netClass], sortY: ctrlAnchorY, x: 0 });
    }
  }
  const sideLanes = (side: Side) => [...lanes.values()].filter((l) => l.side === side).sort((a, b) => a.sortY - b.sortY || a.key.localeCompare(b.key));
  const leftLanes = sideLanes('left');
  const rightLanes = sideLanes('right');

  // --- horizontal placement ------------------------------------------------------------------------
  const leftColW = Math.max(0, ...columns.left.map((p) => sizeOf(p).width));
  const leftLaneStart = PAD + leftColW + LANE_MARGIN;
  const mcuX = columns.left.length > 0 ? leftLaneStart + Math.max(leftLanes.length - 1, 0) * LANE_PITCH + CONTROLLER_MARGIN : PAD;
  const rightLaneStart = mcuX + ctrlSize.width + CONTROLLER_MARGIN;
  const rightColX = rightLaneStart + Math.max(rightLanes.length - 1, 0) * LANE_PITCH + LANE_MARGIN;
  // Left lanes: index 0 nearest the modules; right lanes: index 0 nearest the controller.
  leftLanes.forEach((lane, i) => (lane.x = leftLaneStart + i * LANE_PITCH));
  rightLanes.forEach((lane, i) => (lane.x = rightLaneStart + i * LANE_PITCH));

  const top = PAD + HEADER;
  const boxes = new Map<string, Box>();
  if (controller) boxes.set(controller.instanceId, { x: mcuX, y: top, ...ctrlSize });
  const stack = (list: LayoutInstance[], side: Side) => {
    let y = top;
    for (const p of list) {
      const size = sizeOf(p);
      // Left column is right-aligned so every module faces its lanes at the same x.
      const x = side === 'left' ? PAD + (leftColW - size.width) : rightColX;
      boxes.set(p.instanceId, { x, y, ...size });
      y += size.height + GAP_Y;
    }
    return y - GAP_Y;
  };
  const leftBottom = stack(columns.left, 'left');
  const rightBottom = stack(columns.right, 'right');

  // --- wires -----------------------------------------------------------------------------------------
  const wires: DiagramWire[] = [];
  const junctions: ModuleDiagram['junctions'] = [];
  const laneSpans = new Map<string, { min: number; max: number; count: number }>();
  const absAnchor = (instanceId: string, anchorId: string) => {
    const inst = input.instances.find((i) => i.instanceId === instanceId);
    const box = boxes.get(instanceId);
    const a = inst?.anchors.get(anchorId);
    if (!inst || !box || !a) return null;
    return { x: box.x + a.x, y: box.y + a.y, edge: edgeOf(a, box.width, box.height), box };
  };

  type Anchored = NonNullable<ReturnType<typeof absAnchor>>;

  /** From a module anchor to its lane, entering on a horizontal that clears the module body. */
  const moduleLeg = (P: Anchored, lane: Lane, stagger: number): { points: Point[]; entryY: number } => {
    const toward = lane.side === 'left' ? 'right' : 'left';
    const points: Point[] = [[P.x, P.y]];
    let entryY = P.y;
    if (P.edge === toward) {
      // Faces the lanes: straight across.
    } else if (P.edge === 'top' || P.edge === 'bottom') {
      entryY = P.edge === 'top' ? P.box.y - ESCAPE - stagger : P.box.y + P.box.height + ESCAPE + stagger;
      points.push([P.x, entryY]);
    } else {
      // Faces away from the lanes: step out, then go around below the module.
      const outX = P.edge === 'left' ? P.box.x - ESCAPE : P.box.x + P.box.width + ESCAPE;
      entryY = P.box.y + P.box.height + ESCAPE + stagger;
      points.push([outX, P.y], [outX, entryY]);
    }
    points.push([lane.x, entryY]);
    return { points, entryY };
  };

  /** From the lane to a controller anchor, going over the controller when the anchor faces away. */
  const controllerLeg = (C: Anchored, lane: Lane, stagger: number): Point[] => {
    const facing = lane.side === 'left' ? 'left' : 'right';
    const points: Point[] = [];
    if (C.edge === facing) {
      points.push([lane.x, C.y]);
    } else if (C.edge === 'top' || C.edge === 'bottom') {
      const y = C.edge === 'top' ? C.box.y - ESCAPE - stagger : C.box.y + C.box.height + ESCAPE + stagger;
      points.push([lane.x, y], [C.x, y]);
    } else {
      const y = C.box.y - ESCAPE - stagger;
      const farX = C.edge === 'right' ? C.box.x + C.box.width + ESCAPE : C.box.x - ESCAPE;
      points.push([lane.x, y], [farX, y], [farX, C.y]);
    }
    points.push([C.x, C.y]);
    return points;
  };

  visible.forEach((c, index) => {
    const lane = lanes.get(laneOf.get(c.id)!)!;
    const pEnd = peripheralEnd(c);
    const otherEnd = pEnd === c.from ? c.to : c.from;
    const P = absAnchor(pEnd.instanceId, pEnd.anchorId);
    const Q = absAnchor(otherEnd.instanceId, otherEnd.anchorId);
    if (!P || !Q) return;
    const stagger = (index % 4) * 4;

    const first = moduleLeg(P, lane, stagger);
    const entryY = first.entryY;
    const reachesController = Boolean(controller && otherEnd.instanceId === controller.instanceId);
    // A daisy-chained cable joins two modules in the same column: both ends are module legs.
    const second = reachesController ? controllerLeg(Q, lane, stagger) : [...moduleLeg(Q, lane, stagger).points].reverse();
    const points = dedupe([...first.points, ...second]);
    const net = c.kind === 'wire' ? netById.get(c.netIds[0] ?? '') : undefined;
    const netClass = c.kind === 'cable' ? 'cable' : (net?.class ?? 'gpio');
    wires.push({
      connectionId: c.id,
      kind: c.kind,
      netIds: c.netIds,
      netClass,
      color: NET_COLORS[netClass],
      strokeWidth: c.kind === 'cable' ? 5 : netClass === 'power' || netClass === 'ground' ? 2.6 : 2,
      dashed: c.state !== 'drawn',
      points,
    });

    const laneYs = points.filter((p) => p[0] === r1(lane.x)).map((p) => p[1]);
    const span = laneSpans.get(lane.key) ?? { min: Infinity, max: -Infinity, count: 0 };
    for (const y of laneYs) {
      span.min = Math.min(span.min, y);
      span.max = Math.max(span.max, y);
    }
    span.count += 1;
    laneSpans.set(lane.key, span);
    if (c.kind === 'wire') junctions.push({ x: r1(lane.x), y: r1(entryY), netId: lane.netId, color: lane.color });
  });

  // A junction dot only means something where wires actually share a lane.
  const sharedLanes = new Set([...laneSpans.entries()].filter(([, s]) => s.count > 1).map(([k]) => k));
  const sharedJunctions = junctions.filter((j) => [...lanes.values()].some((l) => sharedLanes.has(l.key) && r1(l.x) === j.x && l.netId === j.netId));

  // --- labels (staggered over three rows to avoid collisions) ---------------------------------------
  const labels: ModuleDiagram['labels'] = [];
  [...leftLanes, ...rightLanes].forEach((lane) => {
    const span = laneSpans.get(lane.key);
    if (!span || !Number.isFinite(span.min)) return;
    const text = lane.netId ? (netById.get(lane.netId)?.name ?? lane.netId) : 'STEMMA QT';
    // Labels run vertically up their lane from just above its top, so neighbouring lanes
    // (22 px apart) can never overlap; `y` is the label's bottom end.
    labels.push({ text, x: r1(lane.x), y: r1(span.min - 8), netId: lane.netId, color: lane.color });
  });

  // --- gap placeholders under the shorter column -------------------------------------------------
  const ctrlBottom = controller ? top + ctrlSize.height : top;
  const gapUnderLeft = columns.left.length <= columns.right.length;
  let gapY = Math.max(gapUnderLeft ? leftBottom : rightBottom, columns.left.length + columns.right.length === 0 ? ctrlBottom : top) + GAP_Y;
  const gapX = gapUnderLeft ? (columns.left.length > 0 ? PAD + leftColW - GAP_BOX.width : PAD) : rightColX;
  const gapBoxes = input.gaps.map((g) => {
    const box = {
      gapId: g.gapId,
      x: r1(Math.max(PAD, gapX)),
      y: r1(gapY),
      width: GAP_BOX.width,
      height: GAP_BOX.height,
      title: g.category.toUpperCase(),
      subtitle: `${g.need} — no module in library`,
    };
    gapY += GAP_BOX.height + GAP_BOX.spacing;
    return box;
  });

  // --- canvas ---------------------------------------------------------------------------------------
  const modules: DiagramModule[] = input.instances
    .filter((i) => boxes.has(i.instanceId))
    .map((i) => {
      const b = boxes.get(i.instanceId)!;
      return { instanceId: i.instanceId, x: r1(b.x), y: r1(b.y), width: b.width, height: b.height, label: i.label, badge: i.badge };
    });
  const allX = [
    ...modules.map((m) => m.x + m.width),
    ...gapBoxes.map((g) => g.x + g.width),
    ...wires.flatMap((w) => w.points.map((p) => p[0])),
  ];
  const allY = [
    ...modules.map((m) => m.y + m.height),
    ...gapBoxes.map((g) => g.y + g.height),
    ...wires.flatMap((w) => w.points.map((p) => p[1])),
  ];
  const minY = Math.min(top, ...wires.flatMap((w) => w.points.map((p) => p[1])), ...labels.map((l) => l.y - (l.text.length * 6.2 + 18)));
  // Routes that climb over the controller can rise above the header; shift everything down if so.
  const shift = minY < PAD ? PAD - minY : 0;
  if (shift > 0) {
    for (const m of modules) m.y = r1(m.y + shift);
    for (const g of gapBoxes) g.y = r1(g.y + shift);
    for (const w of wires) w.points = w.points.map(([x, y]) => [x, r1(y + shift)] as Point);
    for (const j of sharedJunctions) j.y = r1(j.y + shift);
    for (const l of labels) l.y = r1(l.y + shift);
  }

  const classes = new Set(wires.map((w) => w.netClass));
  const legend = (Object.keys(LEGEND_LABELS) as Array<NetClass | 'cable'>)
    .filter((c) => classes.has(c))
    .map((netClass) => ({ netClass, label: LEGEND_LABELS[netClass], color: NET_COLORS[netClass] }));

  return {
    width: r1(Math.max(...allX, mcuX + ctrlSize.width) + PAD),
    height: r1(Math.max(...allY, top + ctrlSize.height) + PAD + shift),
    modules,
    wires,
    junctions: sharedJunctions,
    labels,
    gapBoxes,
    legend,
    header: {
      title: 'Prototype Kit',
      summary: `${input.instances.length} module${input.instances.length === 1 ? '' : 's'} · ${input.nets.length} net${input.nets.length === 1 ? '' : 's'} · ${input.gaps.length} gap${input.gaps.length === 1 ? '' : 's'}`,
    },
  };
}
