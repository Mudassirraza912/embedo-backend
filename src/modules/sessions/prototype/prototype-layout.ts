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
 *
 * A bench too wide for one backbone wraps into stacked bands (layout v3): each band has its own
 * rows and tracks; a net with pads in several bands gets a track in each, same name and colour.
 */

export const LAYOUT_VERSION = 4;

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
  /**
   * Draw `proposed` connections dashed (dev override). Off: only `drawn` connections get a wire.
   * `blocked` connections are always drawn (styled "do not wire") so the canvas shows every net in
   * the graph; hiding them made the diagram disagree with the stored wiring.
   */
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

/** Clear space between one band's lowest escape and the next band's highest. */
const BAND_GAP = 72;
/** Space between the track labels and the first riser, and after the last riser. */
const RISER_MARGIN = 14;
/** A bench narrower than this stays on one backbone. */
const SINGLE_BAND_MAX_WIDTH = 1800;
/** Wider benches wrap into the band count whose width:height is closest to this (landscape canvas). */
const TARGET_RATIO = 1.3;
const MAX_BANDS = 6;

/**
 * Lays the bench out on one backbone, or, when that gets too wide, wraps it into stacked bands
 * (each band: a top row, its own tracks, a bottom row) so the drawing grows down as well as across.
 */
export function layoutPrototype(input: LayoutInput): ModuleDiagram {
  let best = layoutBands(input, 1);
  if (best.width <= SINGLE_BAND_MAX_WIDTH) return best;
  const score = (d: ModuleDiagram) => Math.abs(Math.log(d.width / d.height / TARGET_RATIO));
  for (let k = 2; k <= MAX_BANDS; k++) {
    const next = layoutBands(input, k);
    if (score(next) < score(best)) best = next;
    if ((next.bands ?? 1) < k) break; // fewer board groups than bands: nothing left to split
  }
  return best;
}

function layoutBands(input: LayoutInput, bandCount: number): ModuleDiagram {
  const controller = input.instances.find((i) => i.isController) ?? null;
  const peripherals = input.instances.filter((i) => i !== controller);
  const visible = input.connections.filter((c) => c.state === 'drawn' || c.state === 'blocked' || (c.state === 'proposed' && input.drawProposed));
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
    allDashed: boolean;
    allBlocked: boolean;
  }
  const tracks = new Map<string, Track>();
  const trackOfConnection = new Map<string, string>();
  for (const c of visible) {
    const id = c.kind === 'cable' ? `cable:${c.id}` : `net:${c.netIds[0] ?? c.id}`;
    trackOfConnection.set(c.id, id);
    if (tracks.has(id)) continue;
    const net = c.kind === 'wire' ? netById.get(c.netIds[0] ?? '') : undefined;
    tracks.set(id, {
      id,
      netId: c.kind === 'cable' ? null : (c.netIds[0] ?? null),
      kind: c.kind === 'cable' ? 'cable' : 'net',
      netClass: c.kind === 'cable' ? 'cable' : (net?.class ?? 'gpio'),
      label: c.kind === 'cable' ? 'STEMMA QT' : (net?.name ?? c.netIds[0] ?? c.id),
      color: '',
      y: 0,
      allDashed: true,
      allBlocked: true,
    });
  }
  const orderedTracks = [...tracks.values()].sort(
    (a, b) =>
      CLASS_ORDER.indexOf(a.netClass) - CLASS_ORDER.indexOf(b.netClass) ||
      a.label.localeCompare(b.label, 'en', { numeric: true }) ||
      a.id.localeCompare(b.id)
  );
  const baseOrder = new Map(orderedTracks.map((t, k) => [t.id, k]));
  const shadeIndex = new Map<string, number>();
  for (const t of orderedTracks) {
    const k = shadeIndex.get(t.netClass) ?? 0;
    const shades = NET_SHADES[t.netClass];
    t.color = shades[k % shades.length]!;
    shadeIndex.set(t.netClass, k + 1);
  }

  // --- which side of the controller each board belongs on, and which board hosts it ----------------
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

  // --- bands: boards are grouped with the boards they host (a cable chain never splits) -----------
  const rootOf = (id: string): string => {
    let cur = id;
    for (let d = 0; d < 16 && hostOf.has(cur); d++) cur = hostOf.get(cur)!;
    return cur;
  };
  const groups = new Map<string, LayoutInstance[]>();
  for (const p of peripherals) {
    const r = rootOf(p.instanceId);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  }
  const groupList = [...groups.values()];
  const spanOf = (list: LayoutInstance[]) => list.reduce((n, i) => n + contentSize(i).width + MIN_GAP, 0);
  // The controller also needs a channel lane beside it for most of its wired pins.
  const controllerPins = controller
    ? new Set(visible.flatMap((c) => [c.from, c.to].filter((e) => e.instanceId === controller.instanceId).map((e) => e.anchorId))).size
    : 0;
  const controllerSpan = controller ? spanOf([controller]) + controllerPins * LANE_PITCH : 0;
  const bandsWanted = Math.max(1, Math.min(bandCount, groupList.length + (controller ? 1 : 0)));
  const perBand = (controllerSpan + groupList.reduce((n, g) => n + spanOf(g), 0)) / bandsWanted || 1;
  const bandOf = new Map<string, number>();
  if (controller) bandOf.set(controller.instanceId, 0);
  let acc = controllerSpan;
  for (const g of groupList) {
    const w = spanOf(g);
    const band = Math.min(bandsWanted - 1, Math.floor((acc + w / 2) / perBand));
    for (const i of g) bandOf.set(i.instanceId, band);
    acc += w;
  }
  const usedBands = [...new Set(bandOf.values())].sort((a, b) => a - b);
  for (const [id, b] of bandOf) bandOf.set(id, usedBands.indexOf(b));
  const bands = Math.max(1, usedBands.length);
  const bandOfInst = (id: string) => bandOf.get(id) ?? 0;

  // A cable between two bands is drawn as a track in each; numbered so the two halves pair up.
  let crossCables = 0;
  for (const c of visible) {
    if (c.kind !== 'cable' || bandOfInst(c.from.instanceId) === bandOfInst(c.to.instanceId)) continue;
    tracks.get(trackOfConnection.get(c.id)!)!.label = `STEMMA QT ${++crossCables}`;
  }

  // --- band tracks: a net gets a track in every band that has one of its pads ----------------------
  interface BandTrack extends Track {
    band: number;
    baseId: string;
  }
  const bandTracks = new Map<string, BandTrack>();
  const bandTrackId = (band: number, baseId: string) => {
    const id = `${band}~${baseId}`;
    if (!bandTracks.has(id)) bandTracks.set(id, { ...tracks.get(baseId)!, id, y: 0, band, baseId });
    return id;
  };

  // Endpoints per instance (an anchor on one track is one tap, however many connections share it).
  const endpointsOf = new Map<string, Endpoint[]>();
  const endTracks = new Map<string, { from: string; to: string }>();
  const addEndpoint = (e: Endpoint) => {
    const list = endpointsOf.get(e.instanceId) ?? [];
    if (!list.some((x) => x.anchorId === e.anchorId && x.trackId === e.trackId)) list.push(e);
    endpointsOf.set(e.instanceId, list);
  };
  for (const c of visible) {
    const baseId = trackOfConnection.get(c.id)!;
    const from = bandTrackId(bandOfInst(c.from.instanceId), baseId);
    const to = bandTrackId(bandOfInst(c.to.instanceId), baseId);
    endTracks.set(c.id, { from, to });
    for (const id of new Set([from, to, baseId])) {
      const t = id === baseId ? tracks.get(id)! : bandTracks.get(id)!;
      t.allDashed = t.allDashed && c.state !== 'drawn';
      t.allBlocked = t.allBlocked && c.state === 'blocked';
    }
    addEndpoint({ instanceId: c.from.instanceId, anchorId: c.from.anchorId, trackId: from });
    addEndpoint({ instanceId: c.to.instanceId, anchorId: c.to.anchorId, trackId: to });
  }

  // Nets with pads in more than one band get a riser: a vertical line in a channel left of the
  // boards that joins the net's track in every band, so a lower band visibly connects up to the
  // controller instead of relying on matching names.
  const spanning = orderedTracks
    .map((t) => t.id)
    .filter((baseId) => new Set([...bandTracks.values()].filter((t) => t.baseId === baseId).map((t) => t.band)).size > 1);

  // --- rows: boards whose pins face up hang under their band's tracks, everything else sits on them -
  const rk = (band: number, row: Row) => `${band}|${row}`;
  const rowOf = new Map<string, Row>();
  if (controller) rowOf.set(controller.instanceId, 'top');
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
  const rowWidth = (band: number, row: Row) =>
    input.instances.filter((i) => bandOfInst(i.instanceId) === band && rowOf.get(i.instanceId) === row).reduce((n, i) => n + contentSize(i).width + MIN_GAP, 0);
  for (const p of unplaced) {
    const band = bandOfInst(p.instanceId);
    rowOf.set(p.instanceId, rowWidth(band, 'top') <= rowWidth(band, 'bottom') + 240 ? 'top' : 'bottom');
  }

  const rows = new Map<string, LayoutInstance[]>();
  for (let band = 0; band < bands; band++) {
    for (const row of ['top', 'bottom'] as Row[]) {
      const members = peripherals.filter((p) => bandOfInst(p.instanceId) === band && rowOf.get(p.instanceId) === row);
      const left = members.filter((p) => voteOf(p.instanceId) < 0);
      const right = members.filter((p) => voteOf(p.instanceId) > 0);
      const neutral = members.filter((p) => voteOf(p.instanceId) === 0);
      // Neutral boards balance the two sides of the controller. Composition order is kept.
      for (const p of neutral) (left.length <= right.length ? left : right).push(p);
      rows.set(rk(band, row), band === 0 && row === 'top' && controller ? [...left, controller, ...right] : [...left, ...right]);
    }
  }
  const keyOf = (inst: LayoutInstance) => rk(bandOfInst(inst.instanceId), rowOf.get(inst.instanceId)!);

  // --- channel lanes: which gap and which side of it each sideways escape uses ---------------------
  const laneRequests = new Map<string, LaneRequest[]>();
  /** Around-the-board escapes (pins facing away from the tracks): depth per anchor. */
  const aroundDepth = new Map<string, number>();
  /** Deepest around-the-board escape per row (count of levels), for the space between bands. */
  const aroundLevels = new Map<string, number>();
  const epKey = (instanceId: string, anchorId: string, trackId: string) => `${instanceId}|${anchorId}|${trackId}`;
  for (const [key, list] of rows) {
    const row = key.endsWith('|top') ? 'top' : 'bottom';
    const requests: LaneRequest[] = [];
    laneRequests.set(key, requests);
    list.forEach((inst, index) => {
      const { width } = artSize(inst);
      const eps = endpointsOf.get(inst.instanceId) ?? [];
      const away: Edge = row === 'top' ? 'top' : 'bottom';
      const around: Array<{ ep: Endpoint; gap: number; portion: 'L' | 'R'; dist: number }> = [];
      for (const ep of eps) {
        const a = inst.anchors.get(ep.anchorId);
        const edge = anchorEdge(inst, ep.anchorId);
        if (!a || !edge) continue;
        if (edge === 'left' || edge === 'right') {
          requests.push({
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
            aroundLevels.set(key, Math.max(aroundLevels.get(key) ?? 0, depth + 1));
            requests.push({ gap: r.gap, portion: r.portion, trackId: r.ep.trackId, sortKey: -1e6 - depth });
          });
      }
    });
  }
  /** lanes[key][gap] = { L: trackIds outer→inner, R: trackIds outer→inner } */
  const lanes = new Map<string, Array<{ L: string[]; R: string[] }>>();
  for (const [key, list] of rows) {
    const out: Array<{ L: string[]; R: string[] }> = Array.from({ length: list.length + 1 }, () => ({ L: [], R: [] }));
    const best = new Map<string, LaneRequest>();
    for (const r of laneRequests.get(key)!) {
      const k = `${r.gap}|${r.portion}|${r.trackId}`;
      const cur = best.get(k);
      if (!cur || r.sortKey < cur.sortKey) best.set(k, r);
    }
    for (const r of [...best.values()].sort((a, b) => a.sortKey - b.sortKey || a.trackId.localeCompare(b.trackId))) {
      out[r.gap]![r.portion].push(r.trackId);
    }
    lanes.set(key, out);
  }

  // --- horizontal placement --------------------------------------------------------------------------
  const pillW = Math.max(0, ...orderedTracks.map((t) => t.label.length * PILL.charW + 2 * PILL.padX));
  const trackHead = PAD + pillW;
  const riserX = new Map(spanning.map((baseId, k) => [baseId, trackHead + RISER_MARGIN + k * LANE_PITCH]));
  const trackStart = trackHead + (spanning.length > 0 ? 2 * RISER_MARGIN + (spanning.length - 1) * LANE_PITCH : 0);
  const boxes = new Map<string, Box>(); // content boxes
  const laneX = new Map<string, number>(); // `${key}|${gap}|${portion}|${trackId}` -> x
  const gapWidth = (g: { L: string[]; R: string[] }, edgeGap: boolean) => {
    const n = g.L.length + g.R.length;
    if (n === 0) return edgeGap ? PILL.gap + 20 : MIN_GAP;
    return Math.max(edgeGap ? 0 : MIN_GAP, 2 * LANE_MARGIN + (n - 1) * LANE_PITCH + (g.L.length > 0 && g.R.length > 0 ? LANE_PITCH : 0));
  };
  const rightOf = new Map<string, number>();
  for (const [key, list] of rows) {
    let x = trackStart;
    const rowLanes = lanes.get(key)!;
    list.forEach((inst, i) => {
      const g = rowLanes[i]!;
      const w = gapWidth(g, i === 0);
      g.L.forEach((t, k) => laneX.set(`${key}|${i}|L|${t}`, x + LANE_MARGIN + (g.L.length - 1 - k) * LANE_PITCH));
      g.R.forEach((t, k) => laneX.set(`${key}|${i}|R|${t}`, x + w - LANE_MARGIN - (g.R.length - 1 - k) * LANE_PITCH));
      x += w;
      const size = contentSize(inst);
      boxes.set(inst.instanceId, { x, y: 0, ...size });
      x += size.width;
    });
    const last = rowLanes[list.length]!;
    if (list.length > 0 && last.L.length > 0) {
      last.L.forEach((t, k) => laneX.set(`${key}|${list.length}|L|${t}`, x + LANE_MARGIN + (last.L.length - 1 - k) * LANE_PITCH));
      x += 2 * LANE_MARGIN + (last.L.length - 1) * LANE_PITCH;
    }
    rightOf.set(key, x);
  }

  // --- vertical placement, band by band: top row bottom-aligned on the band's tracks, bottom row
  // hangs under them; the next band starts below the deepest escape -------------------------------
  const escapeOf = (key: string) => {
    const n = aroundLevels.get(key) ?? 0;
    return n > 0 ? ESCAPE + (n - 1) * ESCAPE_STEP : 0;
  };
  let cursor = CONTENT_TOP;
  let bottomRowY = CONTENT_TOP;
  let lastTrackY = CONTENT_TOP;
  for (let band = 0; band < bands; band++) {
    const top = rows.get(rk(band, 'top'))!;
    const bottom = rows.get(rk(band, 'bottom'))!;
    if (band > 0) cursor += escapeOf(rk(band, 'top'));
    const topH = Math.max(0, ...top.map((i) => contentSize(i).height));
    for (const inst of top) {
      const b = boxes.get(inst.instanceId)!;
      b.y = cursor + topH - b.height;
    }
    const firstTrackY = cursor + topH + (top.length > 0 ? ROW_GAP : 0);
    const own = [...bandTracks.values()].filter((t) => t.band === band).sort((a, b) => baseOrder.get(a.baseId)! - baseOrder.get(b.baseId)!);
    own.forEach((t, k) => (t.y = firstTrackY + k * TRACK_PITCH));
    lastTrackY = own.length > 0 ? firstTrackY + (own.length - 1) * TRACK_PITCH : firstTrackY - ROW_GAP;
    bottomRowY = lastTrackY + ROW_GAP;
    for (const inst of bottom) boxes.get(inst.instanceId)!.y = bottomRowY;
    const bottomH = Math.max(0, ...bottom.map((i) => contentSize(i).height));
    cursor = (bottom.length > 0 ? bottomRowY + bottomH + escapeOf(rk(band, 'bottom')) : lastTrackY) + BAND_GAP;
  }

  // --- legs: anchor -> track tap ---------------------------------------------------------------------
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
    const track = bandTracks.get(trackId)!;
    let leg: Point[] | null = null;
    if (P) {
      const row = rowOf.get(instanceId)!;
      const rowKey = keyOf(P.inst);
      const index = rows.get(rowKey)!.indexOf(P.inst);
      const T = track.y;
      const toward: Edge = row === 'top' ? 'bottom' : 'top';
      const lane = (gap: number, portion: 'L' | 'R') => laneX.get(`${rowKey}|${gap}|${portion}|${trackId}`);
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

  // --- wires (one polyline per connection) and buses (one per band track) --------------------------
  const wires: DiagramWire[] = [];
  const busTaps = new Map<string, DiagramBus['taps']>();
  for (const c of visible) {
    const ends = endTracks.get(c.id)!;
    const track = bandTracks.get(ends.from)!;
    const a = legOf(c.from.instanceId, c.from.anchorId, ends.from);
    const b = legOf(c.to.instanceId, c.to.anchorId, ends.to);
    if (!a || !b) continue;
    const dashed = c.state !== 'drawn';
    const blocked = c.state === 'blocked';
    for (const [end, leg, trackId] of [
      [c.from, a, ends.from],
      [c.to, b, ends.to],
    ] as const) {
      const taps = busTaps.get(trackId) ?? [];
      const existing = taps.find((t) => t.instanceId === end.instanceId && t.anchorId === end.anchorId);
      if (existing) {
        existing.dashed = existing.dashed && dashed;
        if (existing.blocked && !blocked) delete existing.blocked;
      } else {
        const whole = instById.get(end.instanceId)?.anchors.get(end.anchorId)?.whole ?? false;
        taps.push({ x: leg[leg.length - 1]![0], instanceId: end.instanceId, anchorId: end.anchorId, points: leg, dashed, ...(blocked ? { blocked } : {}), pad: !whole });
      }
      busTaps.set(trackId, taps);
    }
    // Across bands the wire follows its track to the start of each band (the tracks share a name).
    const rx = riserX.get(bandTracks.get(ends.from)!.baseId) ?? trackStart;
    const bridge: Point[] = ends.from === ends.to ? [] : [[rx, a[a.length - 1]![1]], [rx, b[b.length - 1]![1]]];
    wires.push({
      connectionId: c.id,
      kind: c.kind,
      netIds: c.netIds,
      netClass: track.netClass,
      color: track.color,
      strokeWidth: c.kind === 'cable' ? 5 : track.netClass === 'power' || track.netClass === 'ground' ? 2.6 : 2.2,
      dashed,
      ...(blocked ? { blocked } : {}),
      points: dedupe([...a, ...bridge, ...[...b].reverse()]),
      busId: ends.from,
    });
  }
  // Riser segments: one per pair of neighbouring band tracks of a spanning net, drawn as a tap on
  // the lower track that starts on the upper one (no pad; a junction dot at each end).
  for (const baseId of spanning) {
    const x = riserX.get(baseId)!;
    const own = [...bandTracks.values()].filter((t) => t.baseId === baseId && (busTaps.get(t.id) ?? []).length > 0).sort((p, q) => p.y - q.y);
    for (let k = 1; k < own.length; k++) {
      const upper = own[k - 1]!;
      const lower = own[k]!;
      const taps = busTaps.get(lower.id)!;
      taps.push({
        x,
        instanceId: '',
        anchorId: `riser:${upper.id}`,
        points: [
          [r1(x), r1(upper.y)],
          [r1(x), r1(lower.y)],
        ],
        dashed: upper.allDashed && lower.allDashed,
        ...(upper.allBlocked && lower.allBlocked ? { blocked: true } : {}),
        pad: false,
      });
    }
  }
  const tapsPerBase = new Map<string, number>();
  for (const [id, taps] of busTaps) {
    const baseId = bandTracks.get(id)!.baseId;
    tapsPerBase.set(baseId, (tapsPerBase.get(baseId) ?? 0) + taps.filter((t) => t.instanceId !== "").length);
  }
  const baseOfBus = new Map<string, string>();
  const buses: DiagramBus[] = [...bandTracks.values()]
    .filter((t) => (busTaps.get(t.id) ?? []).length > 0)
    .sort((a, b) => a.band - b.band || baseOrder.get(a.baseId)! - baseOrder.get(b.baseId)!)
    .map((t) => {
      const taps = busTaps.get(t.id)!.sort((p, q) => p.x - q.x);
      baseOfBus.set(t.id, t.baseId);
      return {
        busId: bands === 1 ? t.baseId : t.id,
        netId: t.netId,
        kind: t.kind,
        netClass: t.netClass,
        label: t.label,
        color: t.color,
        y: r1(t.y),
        x1: r1(trackHead),
        x2: r1(Math.max(...taps.map((p) => p.x))),
        labelX: PAD,
        labelWidth: r1(pillW),
        dashed: t.allDashed,
        ...(t.allBlocked ? { blocked: true } : {}),
        shared: (tapsPerBase.get(t.baseId) ?? 0) > 2,
        taps,
      };
    });
  if (bands === 1) for (const w of wires) w.busId = baseOfBus.get(w.busId!) ?? w.busId;
  const junctions: ModuleDiagram['junctions'] = buses.flatMap((b) => b.taps.map((t) => ({ x: r1(t.x), y: b.y, netId: b.netId, color: b.color })));

  // --- last band's bottom row extras: needs with no module, then the legend card -------------------
  const lastBand = bands - 1;
  const bottomBoardsRight = rightOf.get(rk(lastBand, 'bottom')) ?? trackStart;
  const lastBottomCount = rows.get(rk(lastBand, 'bottom'))!.length;
  let gapCursor = Math.max(bottomBoardsRight, trackStart) + (lastBottomCount > 0 ? MIN_GAP : PILL.gap + 20);
  const gapBoxes = input.gaps.map((g) => {
    const box = {
      gapId: g.gapId,
      x: r1(gapCursor),
      y: r1(bottomRowY),
      width: GAP_CARD.width,
      height: GAP_CARD.height,
      title: g.category.toUpperCase(),
      subtitle: `${g.need} — no module in library`,
    };
    gapCursor += GAP_CARD.width + 24;
    return box;
  });

  // One legend row per net (or per class), however many bands its tracks appear in.
  const legendBuses = orderedTracks
    .filter((t) => tapsPerBase.has(t.id))
    .map((t) => ({ track: t }));
  const perTrack = legendBuses.length <= 8;
  const legendRows: NonNullable<ModuleDiagram['legendCard']>['rows'] = perTrack
    ? legendBuses.map(({ track: t }) => ({
        label: t.label,
        color: t.color,
        detail: describe(t.netClass, t.label, (tapsPerBase.get(t.id) ?? 0) > 2),
        dashed: t.allDashed,
        ...(t.allBlocked ? { blocked: true } : {}),
        netId: t.netId,
      }))
    : CLASS_ORDER.filter((cls) => legendBuses.some((l) => l.track.netClass === cls)).map((cls) => {
        const of = legendBuses.filter((l) => l.track.netClass === cls).map((l) => l.track);
        const names = of.filter((t) => t.kind === 'net').map((t) => t.label);
        return {
          label: LEGEND_LABELS[cls],
          color: of[0]!.color,
          detail: cls === 'cable' ? `${of.length} cable${of.length === 1 ? '' : 's'}` : names.join(', '),
          dashed: of.every((t) => t.allDashed),
          ...(of.every((t) => t.allBlocked) ? { blocked: true } : {}),
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
  const anyBlocked = buses.some((b) => b.blocked || b.taps.some((t) => t.blocked));
  const legendH = legendRows.length > 0 ? 54 + legendRows.length * LEGEND_ROW + (anyDashed ? 26 : 4) + (anyBlocked ? 22 : 0) : 0;

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
    ...rightOf.values(),
    gapCursor - 24,
    ...buses.map((b) => b.x2 + 24),
    ...allPoints.map((p) => p[0])
  );
  const legendX = Math.max(gapCursor, contentRight - legendW);
  const legendCard =
    legendRows.length > 0
      ? {
          x: r1(legendX),
          y: r1(bottomY),
          width: r1(legendW),
          height: r1(legendH),
          title: 'Legend',
          caption: bands > 1 ? 'Tracks with the same name are one net' : perTrack ? 'Nets & buses' : 'Net classes',
          rows: legendRows,
          dashedNote: anyDashed,
          ...(anyBlocked ? { blockedNote: true } : {}),
        }
      : null;
  const bottomExtent = Math.max(
    bottomY + (lastBottomCount > 0 ? Math.max(...rows.get(rk(lastBand, 'bottom'))!.map((i) => contentSize(i).height)) : 0),
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
    bands,
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
