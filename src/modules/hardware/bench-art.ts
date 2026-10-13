import crypto from 'node:crypto';
import { SvgAnchor } from './hardware-svg.js';
import { HardwareRecord } from './hardware.schema.js';

/**
 * Bench artwork: the presentation drawing of a board on the Prototype module diagram.
 *
 * The library keeps each board's perimeter-v1 SVG as its validated asset. The diagram instead
 * draws every board from its record in one consistent "bench" style — large labelled pads, a bold
 * title with a spec line, corner mount holes and a feature visual chosen from what the board is
 * (OLED screen, relay + terminal block, shielded MCU module, GNSS patch antenna, microSD slot,
 * sensor package) — so every module, old or new, looks the same. Anchor ids are the record's
 * svg_anchor_id values, placed at pad centres, so connections resolve exactly as before.
 *
 * Everything drawn comes from the record. Nothing is invented: no USB connector unless the record
 * lists a USB power source, no part numbers that are not the record's silicon.
 */

export const BENCH_ART_VERSION = 'bench-2';

type Edge = 'left' | 'right' | 'top' | 'bottom';
export type BenchKind = 'mcu' | 'display' | 'relay' | 'gps' | 'storage' | 'sensor' | 'chip';

export interface BenchArt {
  svg: string;
  hash: string;
  width: number;
  height: number;
  /** Empty margin around the board (room for the glow). */
  inset: number;
  anchors: Map<string, SvgAnchor>;
  edges: Map<string, Edge>;
  kind: BenchKind;
}

const M = 14; // margin around the board
const PAD = 22; // pad size
const PAD_IN = 26; // board edge to pad centre
const TITLE_H = 60;
const HOLE_IN = 17;

const C = {
  board0: '#0F4C53',
  board1: '#0A343A',
  edge: '#2BB8B6',
  silk: '#9CD7D5',
  pad: '#C3ECE9',
  text: '#F2FBFB',
  sub: '#8ED8D4',
  label: '#DDF3F2',
  power: '#F5B84B',
  ground: '#AFC3C5',
  cyan: '#20E6E0',
  dark: '#04191C',
  inner: '#082A2F',
};

const SANS = "Inter, 'Segoe UI', Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tw = (text: string, size: number, mono = false) => text.length * size * (mono ? 0.61 : 0.56);
const r1 = (n: number) => Math.round(n * 10) / 10;

function fit(text: string, maxPx: number, size: number, mono = false): string {
  if (tw(text, size, mono) <= maxPx) return text;
  const per = size * (mono ? 0.61 : 0.56);
  const n = Math.max(4, Math.floor(maxPx / per) - 1);
  const cut = text.slice(0, n);
  const word = cut.lastIndexOf(' ');
  return `${(word > n * 0.6 ? cut.slice(0, word) : cut).replace(/[\s\-–—,:;·]+$/, '')}…`;
}

/** What to draw in the middle of the board. */
export function benchKind(record: HardwareRecord, isController: boolean): BenchKind {
  const id = record.identity;
  const text = [id.product_name, id.group, ...(id.functional_categories ?? []), id.prototype_role ?? '', id.main_silicon ?? ''].join(' ').toLowerCase();
  if (isController || /controller board|main controller|microcontroller/.test(text)) return 'mcu';
  if (/oled|lcd|tft|display|e-?ink|e-?paper|screen/.test(text)) return 'display';
  if (/relay/.test(text)) return 'relay';
  if (/\bgps\b|gnss/.test(text)) return 'gps';
  if (/micro ?sd|sd card|storage/.test(text)) return 'storage';
  if (/sens|bme|bmp|imu|accel|gyro|temperat|humid|pressure|light|gas|distance|tof/.test(text)) return 'sensor';
  return 'chip';
}

const FEATURE_SIZE: Record<BenchKind, [number, number]> = {
  mcu: [150, 116],
  display: [176, 88],
  relay: [150, 84],
  gps: [96, 96],
  storage: [140, 84],
  sensor: [110, 76],
  chip: [104, 76],
};

const stripParen = (s: string) => s.replace(/\s*\(.*\)\s*$/, '').trim();

interface Slot {
  anchorId: string;
  whole: boolean;
  label: string;
  cls: string;
  connectorId: string;
  contactId: string | null;
  pinId: string | null;
}

export function renderBenchArt(record: HardwareRecord, isController = false): BenchArt {
  const hwId = record.identity.hardware_entity_id;
  const kind = benchKind(record, isController);
  const pins = new Map(record.pins.map((p) => [p.pin_id, p]));

  // --- slots per edge (connectors in record order, a gap between connectors) -------------------------
  const byEdge: Record<Edge, Slot[][]> = { left: [], right: [], top: [], bottom: [] };
  for (const c of record.connectors) {
    const edge = (c.position?.svg_edge ?? 'bottom') as Edge;
    if (!byEdge[edge]) continue;
    const slots: Slot[] = [];
    if (c.connection_mode === 'whole_connector') {
      if (c.svg_anchor_id) {
        slots.push({ anchorId: c.svg_anchor_id, whole: true, label: /stemma|qwiic|jst[_ -]?sh/i.test(c.connector_type) ? 'STEMMA QT' : 'CONN', cls: 'data', connectorId: c.connector_id, contactId: null, pinId: null });
      }
    } else {
      for (const k of c.contacts) {
        if (!k.svg_anchor_id) continue;
        const pin = pins.get(k.pin_id);
        slots.push({ anchorId: k.svg_anchor_id, whole: false, label: pin?.pin_name ?? k.contact_id.split(':').pop()!, cls: pin?.signal_class ?? 'data', connectorId: c.connector_id, contactId: k.contact_id, pinId: k.pin_id });
      }
    }
    if (slots.length > 0) byEdge[edge].push(slots);
  }
  const flat = (e: Edge) => byEdge[e].flat();
  const longest = (e: Edge) => Math.max(0, ...flat(e).filter((s) => !s.whole).map((s) => tw(s.label, 12.5, true)));

  const hPitch = (e: Edge) => Math.max(44, longest(e) + 16);
  const sideCount = Math.max(flat('left').length, flat('right').length);
  const vPitch = sideCount > 12 ? 32 : 40;
  const WHOLE_SPAN = 70;
  const span = (e: Edge, pitch: number) =>
    byEdge[e].reduce((n, group) => n + group.reduce((m, s) => m + (s.whole ? WHOLE_SPAN : pitch), 0), 0) + Math.max(byEdge[e].length - 1, 0) * (pitch * 0.5);

  const hasPads = (e: Edge) => flat(e).some((s) => !s.whole);
  const hasAny = (e: Edge) => flat(e).length > 0;
  const topZone = hasPads('top') ? 64 : hasAny('top') ? 34 : 0;
  const bottomZone = hasPads('bottom') ? 64 : hasAny('bottom') ? 34 : 0;
  const sideZone = (e: Edge) => (hasPads(e) ? PAD_IN + PAD / 2 + 10 + longest(e) + 14 : hasAny(e) ? 92 : 18);
  const leftZ = sideZone('left');
  const rightZ = sideZone('right');

  // --- text ----------------------------------------------------------------------------------------
  const id = record.identity;
  const silicon = stripParen(id.main_silicon ?? '');
  const ifaces = [...new Set(record.interfaces.interfaces.map((i) => i.type.toUpperCase()).filter((t) => ['I2C', 'SPI', 'UART', 'I2S', 'CAN', 'USB'].includes(t)))]
    .map((t) => (t === 'I2C' ? 'I²C' : t))
    .slice(0, 2);
  const subtitleParts = kind === 'mcu' ? [silicon, id.vendor] : [silicon, ...(ifaces.length > 0 ? ifaces : [id.vendor])];
  const subtitle = subtitleParts.filter(Boolean).join(' · ');
  const title = id.product_name;

  // USB socket, only when the record says the board is USB powered, on an edge without connectors.
  const usb = (record.electrical.power_source_types ?? []).map((s) => s.toLowerCase());
  const usbLabel = usb.some((s) => /usb[_-]?c/.test(s)) ? 'USB-C' : usb.some((s) => /micro[_-]?usb/.test(s)) ? 'Micro-USB' : usb.some((s) => /usb/.test(s)) ? 'USB' : null;
  const usbEdge: Edge | null = usbLabel ? (!hasAny('bottom') ? 'bottom' : !hasAny('top') ? 'top' : null) : null;
  const usbTop = usbEdge === 'top' ? 26 : 0;
  const usbBottom = usbEdge === 'bottom' ? 50 : 0;

  // --- size ------------------------------------------------------------------------------------------
  const [fw, fh] = FEATURE_SIZE[kind];
  const sideStart = usbTop + topZone + TITLE_H + 10;
  const sideSpan = Math.max(span('left', vPitch), span('right', vPitch));
  const titleW = Math.min(tw(title, 17), 420);
  let bw = Math.max(
    250,
    titleW + 2 * (HOLE_IN + 22),
    tw(subtitle, 11.5, true) + 2 * (HOLE_IN + 22),
    span('top', hPitch('top')) + 60,
    span('bottom', hPitch('bottom')) + 60,
    leftZ + fw + rightZ + 20
  );
  bw = Math.round(bw);
  const featureH = fh + 20;
  const bh = Math.round(Math.max(150, sideStart + Math.max(sideSpan + 10, featureH) + bottomZone + usbBottom + (bottomZone || usbBottom ? 0 : 12)));
  const W = bw + 2 * M;
  const H = bh + 2 * M;
  const x0 = M;
  const y0 = M;

  const out: string[] = [];
  const anchors = new Map<string, SvgAnchor>();
  const edges = new Map<string, Edge>();
  const g = (s: string) => `${hwId}-${s}`;

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" data-hardware-entity-id="${esc(hwId)}" data-embedo-svg="${BENCH_ART_VERSION}">`);
  out.push(`<title>${esc(title)}</title>`);
  out.push(
    `<defs>` +
      `<linearGradient id="${g('pcb')}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${C.board0}"/><stop offset="1" stop-color="${C.board1}"/></linearGradient>` +
      `<linearGradient id="${g('sheen')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.07"/><stop offset="0.4" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>` +
      `<linearGradient id="${g('can')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16565D"/><stop offset="1" stop-color="#0B3439"/></linearGradient>` +
      `<linearGradient id="${g('screen')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#03181B"/><stop offset="1" stop-color="#062226"/></linearGradient>` +
      `</defs>`
  );

  // --- board -----------------------------------------------------------------------------------------
  out.push(`<g id="${g('board')}">`);
  out.push(`<rect x="${x0 - 3}" y="${y0 - 3}" width="${bw + 6}" height="${bh + 6}" rx="17" fill="none" stroke="${C.cyan}" stroke-opacity="0.07" stroke-width="6"/>`);
  out.push(`<rect x="${x0}" y="${y0}" width="${bw}" height="${bh}" rx="14" fill="url(#${g('pcb')})" stroke="${C.edge}" stroke-opacity="0.75" stroke-width="1.6"/>`);
  out.push(`<rect x="${x0}" y="${y0}" width="${bw}" height="${bh}" rx="14" fill="url(#${g('sheen')})"/>`);
  out.push(`<rect x="${x0 + 6}" y="${y0 + 6}" width="${bw - 12}" height="${bh - 12}" rx="10" fill="none" stroke="${C.silk}" stroke-opacity="0.07"/>`);
  for (const [hx, hy] of [
    [x0 + HOLE_IN, y0 + HOLE_IN],
    [x0 + bw - HOLE_IN, y0 + HOLE_IN],
    [x0 + HOLE_IN, y0 + bh - HOLE_IN],
    [x0 + bw - HOLE_IN, y0 + bh - HOLE_IN],
  ]) {
    out.push(`<circle cx="${hx}" cy="${hy}" r="7.5" fill="${C.dark}" stroke="${C.silk}" stroke-opacity="0.6" stroke-width="1.6"/>`);
  }
  out.push(`</g>`);

  // --- title -----------------------------------------------------------------------------------------
  const ty = y0 + usbTop + topZone;
  const centred = kind === 'mcu';
  const tx = centred ? x0 + bw / 2 : x0 + HOLE_IN + 22;
  const anchor = centred ? 'middle' : 'start';
  const maxTitle = centred ? bw - 2 * (HOLE_IN + 18) : bw - (HOLE_IN + 22) - (HOLE_IN + 16);
  out.push(`<g id="${g('title')}">`);
  out.push(`<text x="${tx}" y="${ty + 30}" fill="${C.text}" font-family="${SANS}" font-size="17" font-weight="700" text-anchor="${anchor}">${esc(fit(title, maxTitle, 17))}</text>`);
  if (subtitle) {
    out.push(`<text x="${tx}" y="${ty + 49}" fill="${C.sub}" font-family="${MONO}" font-size="11.5" text-anchor="${anchor}" letter-spacing="0.2">${esc(fit(subtitle, maxTitle, 11.5, true))}</text>`);
  }
  out.push(`</g>`);

  // --- feature ---------------------------------------------------------------------------------------
  const fx0 = x0 + leftZ;
  const fx1 = x0 + bw - rightZ;
  const fy0 = y0 + usbTop + topZone + TITLE_H;
  const fy1 = y0 + bh - (bottomZone || usbBottom || 12);
  const cx = r1((fx0 + fx1) / 2);
  const cy = r1((fy0 + fy1) / 2);
  out.push(`<g id="${g('feature')}">`);
  out.push(...feature(kind, cx, cy, Math.min(fw, fx1 - fx0 - 12), Math.min(fh, fy1 - fy0 - 8), record, g));
  out.push(`</g>`);

  if (usbEdge) {
    const ux = x0 + bw / 2;
    const uy = usbEdge === 'top' ? y0 - 6 : y0 + bh - 18;
    out.push(
      `<g id="${g('usb')}"><rect x="${ux - 30}" y="${uy}" width="60" height="24" rx="9" fill="${C.dark}" stroke="${C.silk}" stroke-opacity="0.85" stroke-width="2"/>` +
        `<rect x="${ux - 20}" y="${uy + 8}" width="40" height="8" rx="4" fill="none" stroke="${C.silk}" stroke-opacity="0.35"/>` +
        (usbEdge === 'top'
          ? `<text x="${ux + 40}" y="${uy + 21}" fill="${C.sub}" font-family="${MONO}" font-size="10.5" font-weight="600">${usbLabel}</text>`
          : `<text x="${ux}" y="${uy - 9}" fill="${C.sub}" font-family="${MONO}" font-size="10.5" font-weight="600" text-anchor="middle">${usbLabel}</text>`) +
        `</g>`
    );
  }

  // --- pads ------------------------------------------------------------------------------------------
  const toneOf = (cls: string) => (cls === 'power' ? C.power : cls === 'ground' ? C.ground : C.label);
  for (const edge of ['left', 'right', 'top', 'bottom'] as Edge[]) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const pitch = horizontal ? hPitch(edge) : vPitch;
    const total = span(edge, pitch);
    let cursor = horizontal ? x0 + (bw - total) / 2 : y0 + sideStart + (Math.max(sideSpan, 0) - total) / 2;
    byEdge[edge].forEach((group, gi) => {
      if (gi > 0) cursor += pitch * 0.5;
      out.push(`<g id="${g(`conn-${gi}-${edge}`)}" class="embedo-connector" data-connector-id="${esc(group[0]!.connectorId)}">`);
      for (const s of group) {
        const step = s.whole ? WHOLE_SPAN : pitch;
        const along = cursor + step / 2;
        cursor += step;
        let ax: number;
        let ay: number;
        if (s.whole) {
          // JST-SH socket hugging the edge; the anchor sits on the outline where the cable plugs in.
          const [w, h] = horizontal ? [44, 16] : [16, 44];
          const rx = horizontal ? along - w / 2 : edge === 'left' ? x0 + 6 : x0 + bw - 6 - w;
          const ry = horizontal ? (edge === 'top' ? y0 + 6 : y0 + bh - 6 - h) : along - h / 2;
          ax = horizontal ? along : edge === 'left' ? x0 : x0 + bw;
          ay = horizontal ? (edge === 'top' ? y0 : y0 + bh) : along;
          out.push(`<rect x="${rx}" y="${ry}" width="${w}" height="${h}" rx="3.5" fill="${C.dark}" stroke="${C.cyan}" stroke-opacity="0.9" stroke-width="1.6"/>`);
          for (let k = 0; k < 4; k++) {
            const off = -12 + k * 8;
            const px = horizontal ? along + off : rx + w / 2;
            const py = horizontal ? ry + h / 2 : along + off;
            out.push(`<rect x="${px - 2}" y="${py - 2}" width="4" height="4" rx="1" fill="${C.cyan}" fill-opacity="0.8"/>`);
          }
          const lx = horizontal ? along : edge === 'left' ? rx + w + 8 : rx - 8;
          const ly = horizontal ? (edge === 'top' ? ry + h + 13 : ry - 7) : along + 3.5;
          out.push(
            `<text x="${lx}" y="${ly}" fill="${C.cyan}" font-family="${MONO}" font-size="9" font-weight="700" letter-spacing="0.6" text-anchor="${horizontal ? 'middle' : edge === 'left' ? 'start' : 'end'}">STEMMA QT</text>`
          );
          out.push(`<circle id="${esc(s.anchorId)}" class="embedo-anchor embedo-anchor-whole" cx="${ax}" cy="${ay}" r="3" fill="${C.cyan}" data-connector-id="${esc(s.connectorId)}"/>`);
        } else {
          ax = horizontal ? along : edge === 'left' ? x0 + PAD_IN : x0 + bw - PAD_IN;
          ay = horizontal ? (edge === 'top' ? y0 + PAD_IN : y0 + bh - PAD_IN) : along;
          const tone = toneOf(s.cls);
          out.push(`<rect x="${ax - PAD / 2}" y="${ay - PAD / 2}" width="${PAD}" height="${PAD}" rx="6" fill="${C.pad}"/>`);
          out.push(`<rect x="${ax - PAD / 2}" y="${ay - PAD / 2}" width="${PAD}" height="${PAD / 2}" rx="6" fill="#FFFFFF" fill-opacity="0.18"/>`);
          out.push(
            `<circle id="${esc(s.anchorId)}" class="embedo-anchor" cx="${ax}" cy="${ay}" r="5.2" fill="${C.dark}" data-connector-id="${esc(s.connectorId)}" data-contact-id="${esc(s.contactId ?? '')}" data-pin-id="${esc(s.pinId ?? '')}"/>`
          );
          const label = esc(s.label);
          if (horizontal) {
            const ly = edge === 'top' ? ay + PAD / 2 + 16 : ay - PAD / 2 - 8;
            out.push(`<text x="${ax}" y="${ly}" fill="${tone}" font-family="${MONO}" font-size="12.5" font-weight="600" text-anchor="middle">${label}</text>`);
          } else {
            const lx = edge === 'left' ? ax + PAD / 2 + 10 : ax - PAD / 2 - 10;
            out.push(
              `<text x="${lx}" y="${ay + 4}" fill="${tone}" font-family="${MONO}" font-size="12.5" font-weight="600" text-anchor="${edge === 'left' ? 'start' : 'end'}">${label}</text>`
            );
          }
        }
        anchors.set(s.anchorId, { id: s.anchorId, x: r1(ax), y: r1(ay), whole: s.whole, connectorId: s.connectorId, contactId: s.contactId, pinId: s.pinId });
        edges.set(s.anchorId, edge);
      }
      out.push(`</g>`);
    });
  }
  out.push('</svg>');
  const svg = `${out.join('\n')}\n`;
  const hash = `sha256:${crypto.createHash('sha256').update(svg).digest('hex')}`;
  return { svg, hash, width: W, height: H, inset: M, anchors, edges, kind };
}

/** The centrepiece for each kind of board, centred on (cx, cy) within w × h. */
function feature(kind: BenchKind, cx: number, cy: number, w: number, h: number, record: HardwareRecord, g: (s: string) => string): string[] {
  const silicon = stripParen(record.identity.main_silicon ?? '') || 'IC';
  const x = r1(cx - w / 2);
  const y = r1(cy - h / 2);
  const out: string[] = [];
  switch (kind) {
    case 'mcu': {
      const wireless = /esp32|esp8266|nrf5|cyw43|wroom|wrover|wi-?fi|ble|bluetooth|wireless/i.test(
        [record.identity.main_silicon, ...(record.identity.secondary_ics ?? []), ...(record.identity.functional_categories ?? [])].join(' ')
      );
      if (wireless) {
        // Shielded RF module with its antenna keep-out above the can.
        const mod = /(?:wroom|wrover|mini)(?:-\w+)?/i.exec([record.identity.main_silicon, ...(record.identity.secondary_ics ?? [])].join(' '));
        out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${C.inner}" stroke="${C.edge}" stroke-opacity="0.55" stroke-width="1.4"/>`);
        out.push(`<line x1="${x + 14}" y1="${y + 9}" x2="${x + w - 14}" y2="${y + 9}" stroke="${C.silk}" stroke-opacity="0.45" stroke-width="1.4" stroke-dasharray="4 4"/>`);
        out.push(`<rect x="${x + 10}" y="${y + 20}" width="${w - 20}" height="${h - 30}" rx="6" fill="url(#${g('can')})" stroke="${C.silk}" stroke-opacity="0.35"/>`);
        out.push(`<text x="${cx}" y="${y + 20 + (h - 30) / 2 + (mod ? -2 : 5)}" fill="${C.text}" font-family="${MONO}" font-size="14" font-weight="700" text-anchor="middle">${esc(fit(silicon, w - 30, 14, true))}</text>`);
        if (mod) out.push(`<text x="${cx}" y="${y + 20 + (h - 30) / 2 + 15}" fill="${C.sub}" font-family="${MONO}" font-size="10.5" text-anchor="middle">${esc(mod[0]!.toUpperCase())}</text>`);
        out.push(`<circle cx="${x + w - 18}" cy="${y + 30}" r="4" fill="${C.cyan}"/><circle cx="${x + w - 18}" cy="${y + 30}" r="8" fill="${C.cyan}" fill-opacity="0.2"/>`);
      } else {
        out.push(...chip(cx, cy, Math.min(w, h, 92), Math.min(w, h, 92), silicon, true));
      }
      break;
    }
    case 'display': {
      out.push(`<rect x="${x - 14}" y="${cy - 16}" width="8" height="32" rx="3" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.4"/>`);
      out.push(`<rect x="${x + w + 6}" y="${cy - 16}" width="8" height="32" rx="3" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.4"/>`);
      out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.75" stroke-width="1.8"/>`);
      out.push(`<rect x="${x + 9}" y="${y + 9}" width="${w - 18}" height="${h - 18}" rx="4" fill="url(#${g('screen')})" stroke="${C.cyan}" stroke-opacity="0.25"/>`);
      out.push(`<text x="${x + 24}" y="${cy - 3}" fill="${C.cyan}" font-family="${MONO}" font-size="13.5" font-weight="600">Hello,</text>`);
      out.push(`<text x="${x + 24}" y="${cy + 14}" fill="${C.cyan}" font-family="${MONO}" font-size="13.5" font-weight="600">Embedo!</text>`);
      out.push(`<rect x="${x + w - 50}" y="${cy - 14}" width="28" height="28" rx="6" fill="none" stroke="${C.cyan}" stroke-width="2"/>`);
      out.push(`<rect x="${x + w - 43}" y="${cy - 7}" width="14" height="14" rx="2" fill="${C.cyan}" fill-opacity="0.6"/>`);
      break;
    }
    case 'relay': {
      // The relay can only; contacts are drawn as pads when the record lists them, never invented.
      const rw = Math.min(150, w);
      const rx = cx - rw / 2;
      out.push(`<rect x="${rx}" y="${y}" width="${rw}" height="${h}" rx="6" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.7" stroke-width="1.6"/>`);
      out.push(`<rect x="${rx + 8}" y="${y + 7}" width="${rw - 16}" height="${h - 14}" rx="4" fill="#0E3F45" stroke="${C.silk}" stroke-opacity="0.35"/>`);
      out.push(`<text x="${cx}" y="${cy + 2}" fill="${C.text}" font-family="${SANS}" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="0.8">RELAY</text>`);
      out.push(`<text x="${cx}" y="${cy + 18}" fill="${C.sub}" font-family="${MONO}" font-size="10" text-anchor="middle">${esc(fit(silicon, rw - 20, 10, true))}</text>`);
      break;
    }
    case 'gps': {
      const s = Math.min(w, h);
      const px = cx - s / 2;
      const py = cy - s / 2;
      out.push(`<rect x="${px}" y="${py}" width="${s}" height="${s}" rx="8" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.6" stroke-width="1.5"/>`);
      out.push(`<rect x="${px + 12}" y="${py + 12}" width="${s - 24}" height="${s - 24}" rx="5" fill="#C9A86A" fill-opacity="0.9" stroke="#E8CD92" stroke-opacity="0.8"/>`);
      out.push(`<rect x="${px + 20}" y="${py + 20}" width="${s - 40}" height="${s - 40}" rx="3" fill="none" stroke="#7A6232" stroke-opacity="0.6"/>`);
      out.push(`<circle cx="${cx + 7}" cy="${cy - 7}" r="4" fill="#E8D7AE" stroke="#7A6232"/>`);
      out.push(`<text x="${px + s + 12}" y="${cy + 4}" fill="${C.sub}" font-family="${MONO}" font-size="10.5" font-weight="600">GNSS</text>`);
      break;
    }
    case 'storage': {
      out.push(`<path d="M${x} ${y + 8}q0 -8 8 -8h${w - 30}l14 12h0q8 0 8 8v${h - 20}q0 8 -8 8h-${w - 8}q-8 0 -8 -8z" fill="${C.inner}" stroke="${C.silk}" stroke-opacity="0.75" stroke-width="1.6"/>`);
      out.push(`<rect x="${x + 12}" y="${y + 18}" width="${w - 24}" height="${h - 30}" rx="4" fill="#0E3F45" stroke="${C.silk}" stroke-opacity="0.3"/>`);
      for (let k = 0; k < 8; k++) out.push(`<rect x="${x + 22 + k * ((w - 44) / 8)}" y="${y + h - 26}" width="${(w - 44) / 8 - 4}" height="10" rx="1.5" fill="#D9B45A" fill-opacity="0.75"/>`);
      out.push(`<text x="${cx}" y="${y + 40}" fill="${C.text}" font-family="${MONO}" font-size="12" font-weight="700" text-anchor="middle">microSD</text>`);
      break;
    }
    case 'sensor': {
      out.push(...chip(cx - 26, cy, 44, 44, '', false));
      out.push(`<circle cx="${cx - 26 + 12}" cy="${cy - 10}" r="3.5" fill="${C.dark}" stroke="${C.silk}" stroke-opacity="0.6"/>`);
      out.push(`<text x="${cx + 6}" y="${cy + 5}" fill="${C.text}" font-family="${MONO}" font-size="13" font-weight="700">${esc(fit(silicon, w / 2 + 20, 13, true))}</text>`);
      break;
    }
    default:
      out.push(...chip(cx, cy, Math.min(w, 120), Math.min(h, 70), silicon, true));
  }
  return out;
}

function chip(cx: number, cy: number, w: number, h: number, label: string, dot: boolean): string[] {
  const x = r1(cx - w / 2);
  const y = r1(cy - h / 2);
  const leads: string[] = [];
  for (let lx = x + 8; lx <= x + w - 8; lx += 7) leads.push(`M${lx} ${y - 4}v4M${lx} ${y + h}v4`);
  for (let ly = y + 8; ly <= y + h - 8; ly += 7) leads.push(`M${x - 4} ${ly}h4M${x + w} ${ly}h4`);
  const out = [
    `<path d="${leads.join('')}" stroke="${C.silk}" stroke-opacity="0.5" stroke-width="2"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#062428" stroke="${C.edge}" stroke-opacity="0.7" stroke-width="1.3"/>`,
    `<rect x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" rx="4" fill="none" stroke="${C.silk}" stroke-opacity="0.12"/>`,
  ];
  if (dot) out.push(`<circle cx="${x + w - 11}" cy="${y + 11}" r="3" fill="${C.cyan}"/>`);
  if (label) out.push(`<text x="${cx}" y="${cy + 4.5}" fill="${C.text}" font-family="${MONO}" font-size="12.5" font-weight="700" text-anchor="middle">${esc(fit(label, w - 14, 12.5, true))}</text>`);
  return out;
}
