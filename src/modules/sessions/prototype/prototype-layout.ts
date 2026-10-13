import { SvgAnchor } from '../../hardware/hardware-svg.js';
import {
  DiagramBus,
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
 * Deterministic bench layout (plan D5 step 6), drawn as a bus backbone:
 *
 *   ┌ header ───────────────────────────────────────────────┐
 *   [ board ]   [ controller ]   [ board ]        <- top row: boards sit on the backbone
 *  (3V3)━━━━━━━━━━━━●━━━━━━━━━━━━━━●━━━━━━━━━━●   <- one labelled track per net (and per cable)
 *  (GND)━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
 *   [ board ]   [ gap ]                [ legend ] <- bottom row: boards hang under it
 *
 * Every connection leaves its board anchor, drops straight onto its track (or steps into the
 * channel beside the board first when the pin faces sideways), runs along the track and climbs to
 * the other anchor. Channels get one lane per net, ordered so escapes from one board never cross.
 * Output is absolute geometry the frontend and the SVG exporter draw directly over the library art.
 */

export const LAYOUT_VERSION = 2;

/** Per-class shades: tracks of one class (e.g. SDA / SCL) get neighbouring but distinct colours. */
export const NET_SHADES: Record<NetClass | 'cable', string[]> = {
  power: ['#F5B84B', '#FF8F5A', '#FFD27A'],
  ground: ['#8EA7AA', '#6E8B8F'],
  i2c: ['#20E6E0', '#9AF3EF'],
  spi: ['#7AA7FF', '#A88BFA', '#5ED3F3', '#C9B6FF'],
  uart: ['#4ADE80', '#B5E655'],
  gpio: ['#F472B6', '#FB7185', '#E879F9', '#FDA4AF'],
  analog: ['#B48EF5', '#D3B8FF'],
  pwm: ['#F58E6E', '#FFB199'],
  cable: ['#20E6E0'],
};
export const NET_COLORS: Record<NetClass | 'cable', string> = Object.fromEntries(
  Object.entries(NET_SHADES).map(([k, v]) => [k, v[0]!])
) as Record<NetClass | 'cable', string>;

const CLASS_ORDER: Array<NetClass | 'cable'> = ['power', 'ground', 'i2c', 'spi', 'uart', 'gpio', 'analog', 'pwm', 'cable'];

const LEGEND_LABELS: Record<NetClass | 'cable', string> = {
  power: 'Power',
  ground: 'Ground',
  i2c: 'I²C',
  spi: 'SPI',
  uart: 'UART',
  gpio: 'GPIO',
  analog: 'Analog',
  pwm: 'PWM',
  cable: 'STEMMA QT / Qwiic cable',
};

const PAD = 40;
const HEADER = { x: 24, y: 20, height: 68 };
const CONTENT_TOP = HEADER.y + HEADER.height + 44;
const TRACK_PITCH = 34;
const ROW_GAP = 46; // board pins to the nearest track
const LANE_PITCH = 16;
const LANE_MARGIN = 24; // board edge to its first channel lane
const MIN_GAP = 64; // between neighbouring boards
const ESCAPE = 18;
const ESCAPE_STEP = 9;
const PILL = { height: 26, charW: 8.8, padX: 16, gap: 16 };
const PLACEHOLDER = { width: 220, height: 120 };
const GAP_CARD = { width: 236, height: 78 };
const LEGEND_ROW = 26;

export interface LayoutInstance {
  instanceId: string;
  label: string;
  isController: boolean;
  width: number | null;
  height: number | null;
  anchors: Map<string, SvgAnchor>;
  /** Empty margin of the artwork around the board; derived from the anchors when absent. */
  inset?: number;
  /** Board edge of each anchor; derived from anchor positions when absent. */
  edges?: Map<string, Edge>;
  badge: string | null;
}

export interface LayoutInput {
  instances: LayoutInstance[];
  nets: PrototypeNet[];
  connections: PrototypeConnection[];
  gaps: PrototypeGap[];
  /** Draw `proposed` connections dashed (dev override). Off: only `drawn` connections get a wire. */
  drawProposed: boolean;
  projectName?: string;
}

type Edge = 'left' | 'right' | 'top' | 'bottom';
type Row = 'top' | 'bottom';

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

/** Human description of a track for the legend card. */
function describe(netClass: NetClass | 'cable', name: string, shared: boolean): string {
  const n = name.toUpperCase();
  const suffix = shared ? ' (shared)' : '';
  if (netClass === 'power') {
    const volts = /(\d+)V(\d+)?/.exec(n);
    return `${volts ? `${volts[1]}${volts[2] ? `.${volts[2]}` : ''} V` : name} power${suffix}`;
  }
  if (netClass === 'ground') return `Ground${suffix}`;
  if (netClass === 'cable') return 'STEMMA QT / Qwiic cable';
  const role = (
    [
      [/SDA/, 'I²C data'],
      [/SCL/, 'I²C clock'],
      [/SCK|SCLK/, 'SPI clock'],
      [/MOSI|COPI|SDO/, 'SPI data out'],
      [/MISO|CIPO|SDI/, 'SPI data in'],
      [/CS|SS/, 'SPI chip select'],
      [/TX/, 'UART transmit'],
      [/RX/, 'UART receive'],
    ] as Array<[RegExp, string]>
  ).find(([re]) => re.test(n))?.[1];
  return `${role ?? `${LEGEND_LABELS[netClass]} signal`}${suffix}`;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Endpoint {
  instanceId: string;
  anchorId: string;
  trackId: string;
}

interface LaneRequest {
  gap: number;
  /** 'L' = the lane serves the board left of the gap, 'R' = the board right of it. */
  portion: 'L' | 'R';
  trackId: string;
  sortKey: number;
}

export function layoutPrototype(input: LayoutInput): ModuleDiagram {
  const controller = input.instances.find((i) => i.isController) ?? null;
  const peripherals = input.instances.filter((i) => i !== controller);
  const visible = input.connections.filter((c) => c.state === 'drawn' || (c.state === 'proposed' && input.drawProposed));
  const netById = new Map(input.nets.map((n) => [n.netId, n]));
  const instById = new Map(input.instances.map((i) => [i.instanceId, i]));
  const artSize = (i: LayoutInstance) => ({ width: i.width ?? PLACEHOLDER.width, height: i.height ?? PLACEHOLDER.height });

  // Library artwork carries a margin around the board; anchors sit LEAD px outside the outline.
  // The "content box" (artwork minus empty margin) is what boards are spaced by.
  const insetOf = new Map<string, number>();
  for (const inst of input.instances) {
    const { width, height } = artSize(inst);
    const d = [...inst.anchors.values()].map((a) => Math.min(a.x, a.y, width - a.x, height - a.y));
    insetOf.set(inst.instanceId, inst.inset ?? (d.length > 0 ? Math.max(0, Math.min(64, ...d)) : 0));
  }
  const contentSize = (i: LayoutInstance) => {
    const { width, height } = artSize(i);
    const inset = insetOf.get(i.instanceId)!;
    return { width: width - 2 * inset, height: height - 2 * inset };
  };
  const anchorEdge = (inst: LayoutInstance, anchorId: string): Edge | null => {
    const a = inst.anchors.get(anchorId);
    if (!a) return null;
    const known = inst.edges?.get(anchorId);
    if (known) return known;
    const { width, height } = artSize(inst);
    return edgeOf(a, width, height);
  };

  // --- tracks: one per net with a visible wire, one per visible cable ------------------------------
  interface Track {
    id: string;
    netId: string | null;
    kind: 'net' | 'cable';
    netClass: NetClass | 'cable';
    label: string;
    color: string;
    y: number;
    connectionIds: string[];
    allDashed: boolean;
  }
  const tracks = new Map<string, Track>();
  const trackOfConnection = new Map<string, string>();
  for (const c of visible) {
    const id = c.kind === 'cable' ? `cable:${c.id}` : `net:${c.netIds[0] ?? c.id}`;
    trackOfConnection.set(c.id, id);
    const existing = tracks.get(id);
    const dashed = c.state !== 'drawn';
    if (existing) {
      existing.connectionIds.push(c.id);
      existing.allDashed = existing.allDashed && dashed;
      continue;
    }
    const net = c.kind === 'wire' ? netById.get(c.netIds[0] ?? '') : undefined;
    tracks.set(id, {
      id,
      netId: c.kind === 'cable' ? null : (c.netIds[0] ?? null),
      kind: c.kind === 'cable' ? 'cable' : 'net',
      netClass: c.kind === 'cable' ? 'cable' : (net?.class ?? 'gpio'),
      label: c.kind === 'cable' ? 'STEMMA QT' : (net?.name ?? c.netIds[0] ?? c.id),
      color: '',
      y: 0,
      connectionIds: [c.id],
      allDashed: dashed,
    });
  }
  const orderedTracks = [...tracks.values()].sort(
    (a, b) =>
      CLASS_ORDER.indexOf(a.netClass) - CLASS_ORDER.indexOf(b.netClass) ||
      a.label.localeCompare(b.label, 'en', { numeric: true }) ||
      a.id.localeCompare(b.id)
  );
  const shadeIndex = new Map<string, number>();
  for (const t of orderedTracks) {
    const k = shadeIndex.get(t.netClass) ?? 0;
    const shades = NET_SHADES[t.netClass];
    t.color = shades[k % shades.length]!;
    shadeIndex.set(t.netClass, k + 1);
  }

  // Endpoints per instance (an anchor on one track is one tap, however many connections share it).
  const endpointsOf = new Map<string, Endpoint[]>();
  const addEndpoint = (e: Endpoint) => {
    const list = endpointsOf.get(e.instanceId) ?? [];
    if (!list.some((x) => x.anchorId === e.anchorId && x.trackId === e.trackId)) list.push(e);
    endpointsOf.set(e.instanceId, list);
  };
  for (const c of visible) {
    const trackId = trackOfConnection.get(c.id)!;
    addEndpoint({ instanceId: c.from.instanceId, anchorId: c.from.anchorId, trackId });
    addEndpoint({ instanceId: c.to.instanceId, anchorId: c.to.anchorId, trackId });
  }

  // --- rows: boards whose pins face up hang under the backbone, everything else sits on it ---------
  const rowOf = new Map<string, Row>();
  if (controller) rowOf.set(controller.instanceId, 'top');
  const sideVote = new Map<string, number>(); // < 0: left of the controller, > 0: right
  const hostOf = new Map<string, string>();
  for (const c of input.connections) {
    if (!controller) break;
    const ctrlEnd = [c.from, c.to].find((e) => e.instanceId === controller.instanceId);
    if (!ctrlEnd) {
      hostOf.set(c.to.instanceId, c.from.instanceId);
      continue;
    }
    const other = ctrlEnd === c.from ? c.to : c.from;
    const a = controller.anchors.get(ctrlEnd.anchorId);
    if (!a) continue;
    const half = artSize(controller).width / 2;
    sideVote.set(other.instanceId, (sideVote.get(other.instanceId) ?? 0) + (a.x < half ? -1 : 1));
  }
  const voteOf = (id: string, depth = 0): number => {
    const v = sideVote.get(id) ?? 0;
    if (v !== 0 || depth > 16 || !hostOf.has(id)) return v;
    return voteOf(hostOf.get(id)!, depth + 1);
  };
  const unplaced: LayoutInstance[] = [];
  for (const p of peripherals) {
    const eps = endpointsOf.get(p.instanceId) ?? [];
    if (eps.length === 0) {
      unplaced.push(p);
      continue;
    }
    const up = eps.filter((e) => anchorEdge(p, e.anchorId) === 'top').length;
    rowOf.set(p.instanceId, up > eps.length - up ? 'bottom' : 'top');
  }
  const rowWidth = (row: Row) =>
    input.instances.filter((i) => rowOf.get(i.instanceId) === row).reduce((n, i) => n + contentSize(i).width + MIN_GAP, 0);
  for (const p of unplaced) rowOf.set(p.instanceId, rowWidth('top') <= rowWidth('bottom') + 240 ? 'top' : 'bottom');

  const rowList = (row: Row): LayoutInstance[] => {
    const members = peripherals.filter((p) => rowOf.get(p.instanceId) === row);
    const left = members.filter((p) => voteOf(p.instanceId) < 0);
    const right = members.filter((p) => voteOf(p.instanceId) > 0);
    const neutral = members.filter((p) => voteOf(p.instanceId) === 0);
    // Neutral boards balance the two sides of the controller.
    for (const p of neutral) (left.length <= right.length ? left : right).push(p);
    const sorted = (list: LayoutInstance[]) => list; // composition order is already meaningful
    if (row === 'top' && controller) return [...sorted(left), controller, ...sorted(right)];
    return [...sorted(left), ...sorted(right)];
  };
  const rows: Record<Row, LayoutInstance[]> = { top: rowList('top'), bottom: rowList('bottom') };

  // --- channel lanes: which gap and which side of it each sideways escape uses ---------------------
  const laneRequests: Record<Row, LaneRequest[]> = { top: [], bottom: [] };
  /** Around-the-board escapes (pins facing away from the backbone): depth per anchor. */
  const aroundDepth = new Map<string, number>();
  const epKey = (instanceId: string, anchorId: string, trackId: string) => `${instanceId}|${anchorId}|${trackId}`;
  for (const row of ['top', 'bottom'] as Row[]) {
    rows[row].forEach((inst, index) => {
      const { width } = artSize(inst);
      const eps = endpointsOf.get(inst.instanceId) ?? [];
      const away: Edge = row === 'top' ? 'top' : 'bottom';
      const around: Array<{ ep: Endpoint; gap: number; portion: 'L' | 'R'; dist: number }> = [];
      for (const ep of eps) {
        const a = inst.anchors.get(ep.anchorId);
        const edge = anchorEdge(inst, ep.anchorId);
        if (!a || !edge) continue;
        if (edge === 'left' || edge === 'right') {
          laneRequests[row].push({
            gap: edge === 'left' ? index : index + 1,
            portion: edge === 'left' ? 'R' : 'L',
            trackId: ep.trackId,
            // Top row: higher pins take outer lanes. Bottom row: lower pins do.
            sortKey: row === 'top' ? a.y : -a.y,
          });
        } else if (edge === away) {
          const toLeft = a.x < width / 2;
          around.push({ ep, gap: toLeft ? index : index + 1, portion: toLeft ? 'R' : 'L', dist: toLeft ? a.x : width - a.x });
        }
      }
      // Nearest-to-the-gap escapes stay lowest; farther ones climb over them and take outer lanes.
      for (const side of ['L', 'R'] as const) {
        around
          .filter((r) => r.portion === side)
          .sort((p, q) => p.dist - q.dist)
          .forEach((r, depth) => {
            aroundDepth.set(epKey(r.ep.instanceId, r.ep.anchorId, r.ep.trackId), depth);
            laneRequests[row].push({ gap: r.gap, portion: r.portion, trackId: r.ep.trackId, sortKey: -1e6 - depth });
          });
      }
    });
  }
  /** lanes[row][gap] = { L: trackIds outer→inner, R: trackIds outer→inner } */
  const lanesOf = (row: Row) => {
    const out: Array<{ L: string[]; R: string[] }> = Array.from({ length: rows[row].length + 1 }, () => ({ L: [], R: [] }));
    const best = new Map<string, LaneRequest>();
    for (const r of laneRequests[row]) {
      const k = `${r.gap}|${r.portion}|${r.trackId}`;
      const cur = best.get(k);
      if (!cur || r.sortKey < cur.sortKey) best.set(k, r);
    }
    for (const r of [...best.values()].sort((a, b) => a.sortKey - b.sortKey || a.trackId.localeCompare(b.trackId))) {
      out[r.gap]![r.portion].push(r.trackId);
    }
    return out;
  };
  const lanes = { top: lanesOf('top'), bottom: lanesOf('bottom') };

  // --- horizontal placement --------------------------------------------------------------------------
  const pillW = Math.max(0, ...orderedTracks.map((t) => t.label.length * PILL.charW + 2 * PILL.padX));
  const trackStart = PAD + pillW;
  const boxes = new Map<string, Box>(); // content boxes
  const laneX = new Map<string, number>(); // `${row}|${gap}|${portion}|${trackId}` -> x
  const gapWidth = (g: { L: string[]; R: string[] }, edgeGap: boolean) => {
    const n = g.L.length + g.R.length;
    if (n === 0) return edgeGap ? PILL.gap + 20 : MIN_GAP;
    return Math.max(edgeGap ? 0 : MIN_GAP, 2 * LANE_MARGIN + (n - 1) * LANE_PITCH + (g.L.length > 0 && g.R.length > 0 ? LANE_PITCH : 0));
  };
  const placeRow = (row: Row): number => {
    let x = trackStart;
    const list = rows[row];
    list.forEach((inst, i) => {
      const g = lanes[row][i]!;
      const w = gapWidth(g, i === 0);
      g.L.forEach((t, k) => laneX.set(`${row}|${i}|L|${t}`, x + LANE_MARGIN + (g.L.length - 1 - k) * LANE_PITCH));
      g.R.forEach((t, k) => laneX.set(`${row}|${i}|R|${t}`, x + w - LANE_MARGIN - (g.R.length - 1 - k) * LANE_PITCH));
      x += w;
      const size = contentSize(inst);
      boxes.set(inst.instanceId, { x, y: 0, ...size });
      x += size.width;
    });
    const last = lanes[row][list.length]!;
    if (list.length > 0 && last.L.length > 0) {
      last.L.forEach((t, k) => laneX.set(`${row}|${list.length}|L|${t}`, x + LANE_MARGIN + (last.L.length - 1 - k) * LANE_PITCH));
      x += 2 * LANE_MARGIN + (last.L.length - 1) * LANE_PITCH;
    }
    return x;
  };
  const topRight = placeRow('top');
  const bottomBoardsRight = placeRow('bottom');

  // --- vertical placement: top row bottom-aligned on the backbone, bottom row hangs under it --------
  const topRowH = Math.max(0, ...rows.top.map((i) => contentSize(i).height));
  for (const inst of rows.top) {
    const b = boxes.get(inst.instanceId)!;
    b.y = CONTENT_TOP + topRowH - b.height;
  }
  const firstTrackY = CONTENT_TOP + topRowH + (rows.top.length > 0 ? ROW_GAP : 0);
  orderedTracks.forEach((t, k) => (t.y = firstTrackY + k * TRACK_PITCH));
  const lastTrackY = orderedTracks.length > 0 ? firstTrackY + (orderedTracks.length - 1) * TRACK_PITCH : firstTrackY - ROW_GAP;
  const bottomRowY = lastTrackY + ROW_GAP;
  for (const inst of rows.bottom) boxes.get(inst.instanceId)!.y = bottomRowY;

  // --- legs: anchor -> track tap ---------------------------------------------------------------------
  const rowIndex = (inst: LayoutInstance) => rows[rowOf.get(inst.instanceId)!].indexOf(inst);
  const absAnchor = (instanceId: string, anchorId: string) => {
    const inst = instById.get(instanceId);
    const box = boxes.get(instanceId);
    const a = inst?.anchors.get(anchorId);
    if (!inst || !box || !a) return null;
    const inset = insetOf.get(instanceId)!;
    return { x: box.x - inset + a.x, y: box.y - inset + a.y, edge: anchorEdge(inst, anchorId)!, box, inst };
  };
  const legCache = new Map<string, Point[] | null>();
  const legOf = (instanceId: string, anchorId: string, trackId: string): Point[] | null => {
    const key = epKey(instanceId, anchorId, trackId);
    if (legCache.has(key)) return legCache.get(key)!;
    const P = absAnchor(instanceId, anchorId);
    const track = tracks.get(trackId)!;
    let leg: Point[] | null = null;
    if (P) {
      const row = rowOf.get(instanceId)!;
      const index = rowIndex(P.inst);
      const T = track.y;
      const toward: Edge = row === 'top' ? 'bottom' : 'top';
      const lane = (gap: number, portion: 'L' | 'R') => laneX.get(`${row}|${gap}|${portion}|${trackId}`);
      if (P.edge === toward) {
        leg = [[P.x, P.y], [P.x, T]];
      } else if (P.edge === 'left' || P.edge === 'right') {
        const L = P.edge === 'left' ? lane(index, 'R') : lane(index + 1, 'L');
        if (L !== undefined) leg = [[P.x, P.y], [L, P.y], [L, T]];
      } else {
        const toLeft = P.x - P.box.x < P.box.width / 2;
        const L = toLeft ? lane(index, 'R') : lane(index + 1, 'L');
        const depth = aroundDepth.get(key) ?? 0;
        const y = row === 'top' ? P.box.y - ESCAPE - depth * ESCAPE_STEP : P.box.y + P.box.height + ESCAPE + depth * ESCAPE_STEP;
        if (L !== undefined) leg = [[P.x, P.y], [P.x, y], [L, y], [L, T]];
      }
    }
    leg = leg ? dedupe(leg) : null;
    legCache.set(key, leg);
    return leg;
  };

  // --- wires (one polyline per connection) and buses (one per track) -------------------------------
  const wires: DiagramWire[] = [];
  const busTaps = new Map<string, DiagramBus['taps']>();
  for (const c of visible) {
    const trackId = trackOfConnection.get(c.id)!;
    const track = tracks.get(trackId)!;
    const a = legOf(c.from.instanceId, c.from.anchorId, trackId);
    const b = legOf(c.to.instanceId, c.to.anchorId, trackId);
    if (!a || !b) continue;
    const dashed = c.state !== 'drawn';
    for (const [end, leg] of [
      [c.from, a],
      [c.to, b],
    ] as const) {
      const taps = busTaps.get(trackId) ?? [];
      const existing = taps.find((t) => t.instanceId === end.instanceId && t.anchorId === end.anchorId);
      if (existing) existing.dashed = existing.dashed && dashed;
      else {
        const whole = instById.get(end.instanceId)?.anchors.get(end.anchorId)?.whole ?? false;
        taps.push({ x: leg[leg.length - 1]![0], instanceId: end.instanceId, anchorId: end.anchorId, points: leg, dashed, pad: !whole });
      }
      busTaps.set(trackId, taps);
    }
    wires.push({
      connectionId: c.id,
      kind: c.kind,
      netIds: c.netIds,
      netClass: track.netClass,
      color: track.color,
      strokeWidth: c.kind === 'cable' ? 5 : track.netClass === 'power' || track.netClass === 'ground' ? 2.6 : 2.2,
      dashed,
      points: dedupe([...a, ...[...b].reverse()]),
      busId: trackId,
    });
  }
  const buses: DiagramBus[] = orderedTracks
    .filter((t) => (busTaps.get(t.id) ?? []).length > 0)
    .map((t) => {
      const taps = busTaps.get(t.id)!.sort((p, q) => p.x - q.x);
      return {
        busId: t.id,
        netId: t.netId,
        kind: t.kind,
        netClass: t.netClass,
        label: t.label,
        color: t.color,
        y: r1(t.y),
        x1: r1(trackStart),
        x2: r1(Math.max(...taps.map((p) => p.x))),
        labelX: PAD,
        labelWidth: r1(pillW),
        dashed: t.allDashed,
        shared: taps.length > 2,
        taps,
      };
    });
  const junctions: ModuleDiagram['junctions'] = buses.flatMap((b) => b.taps.map((t) => ({ x: r1(t.x), y: b.y, netId: b.netId, color: b.color })));

  // --- bottom row extras: needs with no module, then the legend card -------------------------------
  let cursor = Math.max(bottomBoardsRight, trackStart) + (rows.bottom.length > 0 ? MIN_GAP : PILL.gap + 20);
  const gapBoxes = input.gaps.map((g) => {
    const box = {
      gapId: g.gapId,
      x: r1(cursor),
      y: r1(bottomRowY),
      width: GAP_CARD.width,
      height: GAP_CARD.height,
      title: g.category.toUpperCase(),
      subtitle: `${g.need} — no module in library`,
    };
    cursor += GAP_CARD.width + 24;
    return box;
  });

  const perTrack = buses.length <= 8;
  const legendRows: NonNullable<ModuleDiagram['legendCard']>['rows'] = perTrack
    ? buses.map((b) => ({ label: b.label, color: b.color, detail: describe(b.netClass, b.label, b.shared), dashed: b.dashed, netId: b.netId }))
    : CLASS_ORDER.filter((cls) => buses.some((b) => b.netClass === cls)).map((cls) => {
        const of = buses.filter((b) => b.netClass === cls);
        const names = of.filter((b) => b.kind === 'net').map((b) => b.label);
        return {
          label: LEGEND_LABELS[cls],
          color: of[0]!.color,
          detail: cls === 'cable' ? `${of.length} cable${of.length === 1 ? '' : 's'}` : names.join(', '),
          dashed: of.every((b) => b.dashed),
          netId: null,
        };
      });
  const legendW =
    legendRows.length > 0
      ? Math.max(
          330,
          76 + Math.max(...legendRows.map((r) => Math.min(r.label.length, 16) * 7.4)) + 34 + Math.max(...legendRows.map((r) => Math.min(r.detail.length, 44) * 6.9)) + 24
        )
      : 0;
  const anyDashed = legendRows.some((r) => r.dashed);
  const legendH = legendRows.length > 0 ? 54 + legendRows.length * LEGEND_ROW + (anyDashed ? 26 : 4) : 0;

  // --- shift down if around-the-board escapes rose above the content top ----------------------------
  const allPoints = wires.flatMap((w) => w.points);
  const minY = Math.min(CONTENT_TOP, ...allPoints.map((p) => p[1]));
  const shift = minY < CONTENT_TOP - 16 ? CONTENT_TOP - 16 - minY : 0;
  if (shift > 0) {
    const sh = (p: Point): Point => [p[0], r1(p[1] + shift)];
    for (const b of boxes.values()) b.y += shift;
    for (const w of wires) w.points = w.points.map(sh);
    for (const b of buses) {
      b.y = r1(b.y + shift);
      for (const t of b.taps) t.points = t.points.map(sh);
    }
    for (const j of junctions) j.y = r1(j.y + shift);
    for (const g of gapBoxes) g.y = r1(g.y + shift);
  }

  // --- canvas ---------------------------------------------------------------------------------------
  const modules: DiagramModule[] = input.instances
    .filter((i) => boxes.has(i.instanceId))
    .map((i) => {
      const b = boxes.get(i.instanceId)!;
      const inset = insetOf.get(i.instanceId)!;
      const art = artSize(i);
      return {
        instanceId: i.instanceId,
        x: r1(b.x - inset),
        y: r1(b.y - inset),
        width: art.width,
        height: art.height,
        label: i.label,
        badge: i.badge,
        content: { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) },
      };
    });
  const bottomY = bottomRowY + shift;
  const contentRight = Math.max(
    topRight,
    bottomBoardsRight,
    cursor - 24,
    ...buses.map((b) => b.x2 + 24),
    ...allPoints.map((p) => p[0])
  );
  const legendX = Math.max(cursor, contentRight - legendW);
  const legendCard =
    legendRows.length > 0
      ? { x: r1(legendX), y: r1(bottomY), width: r1(legendW), height: r1(legendH), title: 'Legend', caption: perTrack ? 'Nets & buses' : 'Net classes', rows: legendRows, dashedNote: anyDashed }
      : null;
  const bottomExtent = Math.max(
    bottomY + (rows.bottom.length > 0 ? Math.max(...rows.bottom.map((i) => contentSize(i).height)) : 0),
    ...gapBoxes.map((g) => g.y + g.height),
    legendCard ? legendCard.y + legendCard.height : 0,
    ...allPoints.map((p) => p[1]),
    ...modules.map((m) => m.content!.y + m.content!.height),
    lastTrackY + shift
  );
  const width = r1(Math.max(contentRight, legendCard ? legendCard.x + legendCard.width : 0, PAD + 720) + PAD);
  const height = r1(bottomExtent + PAD);

  const classes = new Set(wires.map((w) => w.netClass));
  const legend = CLASS_ORDER.filter((c) => classes.has(c)).map((netClass) => ({ netClass, label: LEGEND_LABELS[netClass], color: NET_COLORS[netClass] }));
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return {
    layoutVersion: LAYOUT_VERSION,
    width,
    height,
    modules,
    wires,
    buses,
    junctions,
    labels: [],
    gapBoxes,
    legend,
    legendCard,
    header: {
      title: 'Prototype Mode',
      subtitle: 'Design · Connect · Prototype',
      project: input.projectName ?? null,
      summary: `${count(input.instances.length, 'module')} · ${count(input.nets.length, 'net')} · ${count(input.gaps.length, 'gap')}`,
      box: { x: HEADER.x, y: HEADER.y, width: r1(width - 2 * HEADER.x), height: HEADER.height },
    },
  };
}
