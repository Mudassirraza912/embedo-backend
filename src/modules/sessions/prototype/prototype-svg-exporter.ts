import { DiagramBus, ModuleDiagram, Point, PrototypeArchitecture } from './prototype.types.js';

/**
 * Server-side SVG of the module diagram (the `svg` export of a Prototype session). Uses the same
 * geometry the frontend draws; each board's library artwork is nested at its placement with its
 * element ids prefixed per instance, so two copies of one board never collide.
 *
 * Header card, glowing tracks with pill labels, boards (bench art), legs with lit pads and
 * junction dots, badge pills, need cards and a legend card. Payloads saved in the old diagram
 * format are redrawn before they get here (diagram-upgrade.ts).
 */

const CANVAS = '#04191C';
const DOT = '#123F45';
const CARD = '#071F23';
const CARD_EDGE = '#14454C';
const TEXT = '#EAF6F6';
const MUTED = '#8EA7AA';
const TEAL = '#20E6E0';
const WARN = '#F5B84B';
const SANS = "Inter, 'Segoe UI', Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pts = (points: Point[]) => points.map(([x, y]) => `${x},${y}`).join(' ');

/** The Embedo mark (pixel "E"), 117 × 123 units. */
const LOGO_RECTS: Array<[number, number, number, number]> = [
  [24, 0, 63, 25],
  [0, 23, 117, 8],
  [0, 23, 27, 81],
  [81, 23, 36, 28],
  [33, 48, 84, 4],
  [33, 48, 51, 27],
  [87, 79, 30, 19],
  [0, 96, 117, 8],
  [24, 103, 66, 20],
];
export function embedoMark(x: number, y: number, size: number, fill: string): string {
  const s = size / 123;
  return `<g transform="translate(${x} ${y}) scale(${s.toFixed(4)})" fill="${fill}">${LOGO_RECTS.map(([rx, ry, w, h]) => `<rect x="${rx}" y="${ry}" width="${w}" height="${h}" rx="3"/>`).join('')}</g>`;
}

function nestArtwork(markup: string, prefix: string, x: number, y: number, width: number, height: number): string {
  const open = /<svg\b([^>]*)>/i.exec(markup);
  const close = markup.lastIndexOf('</svg>');
  if (!open || close < 0) return '';
  const viewBox = /viewBox\s*=\s*"([^"]+)"/i.exec(open[1]!)?.[1] ?? `0 0 ${width} ${height}`;
  const inner = markup
    .slice(open.index + open[0].length, close)
    .replace(/\sid\s*=\s*"([^"]+)"/g, (_m, id: string) => ` id="${prefix}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${prefix}-${id})`)
    .replace(/href\s*=\s*"#([^"]+)"/g, (_m, id: string) => `href="#${prefix}-${id}"`);
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${esc(viewBox)}" overflow="visible">${inner}</svg>`;
}

/** Splits text into at most `lines` lines of roughly `width` characters. */
function wrap(text: string, width: number, lines: number): string[] {
  const out = [''];
  for (const w of text.split(/\s+/)) {
    const cur = out[out.length - 1]!;
    if ((cur + ' ' + w).trim().length > width && cur) {
      if (out.length === lines) {
        out[out.length - 1] = `${cur.replace(/[\s,;:]+$/, '')}…`;
        return out;
      }
      out.push(w);
    } else out[out.length - 1] = (cur + ' ' + w).trim();
  }
  return out;
}

const fit = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function renderHeader(d: ModuleDiagram): string[] {
  const box = d.header.box ?? { x: 24, y: 20, width: d.width - 48, height: 68 };
  const { x, y, width, height } = box;
  const mid = y + height / 2;
  const out = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${CARD}" fill-opacity="0.92" stroke="${CARD_EDGE}"/>`,
    `<rect x="${x + 1}" y="${y + 1}" width="${width - 2}" height="${height / 2}" rx="13" fill="url(#hdr-sheen)"/>`,
    embedoMark(x + 22, mid - 17, 34, 'url(#brand)'),
    `<text x="${x + 68}" y="${mid + 8}" fill="${TEXT}" font-family="${SANS}" font-size="23" font-weight="700" letter-spacing="-0.2">Embedo</text>`,
    `<line x1="${x + 186}" y1="${mid - 18}" x2="${x + 186}" y2="${mid + 18}" stroke="${CARD_EDGE}" stroke-width="1.5"/>`,
    `<text x="${x + 210}" y="${mid - 3}" fill="${TEXT}" font-family="${SANS}" font-size="18" font-weight="700">${esc(d.header.title)}</text>`,
    `<text x="${x + 210}" y="${mid + 17}" fill="${TEAL}" fill-opacity="0.85" font-family="${MONO}" font-size="12" letter-spacing="0.4">${esc(d.header.subtitle ?? 'Design · Connect · Prototype')}</text>`,
  ];
  const right = x + width - 24;
  if (width > 760) {
    out.push(
      `<text x="${right}" y="${mid - 4}" fill="${MUTED}" font-family="${SANS}" font-size="10" font-weight="600" letter-spacing="3" text-anchor="end">HARDWARE IDEAS TO REALITY</text>`,
      `<text x="${right}" y="${mid + 15}" fill="${TEXT}" fill-opacity="0.8" font-family="${MONO}" font-size="11" text-anchor="end">${esc(
        [d.header.project ? fit(d.header.project, Math.max(16, Math.floor((width - 560) / 7.2) - 30)) : null, d.header.summary].filter(Boolean).join('  ·  ')
      )}</text>`
    );
  }
  return out;
}

const coreWidth = (b: DiagramBus) => (b.netClass === 'power' || b.netClass === 'ground' ? 2.8 : 2.4);

/** A connection a check blocks is drawn (the export shows the whole graph) in red, "do not wire". */
const BLOCKED = '#FF5C5C';
const BLOCKED_DASH = ' stroke-dasharray="4 5"';

/** The track itself, drawn under the boards. */
function renderTrack(b: DiagramBus): string[] {
  const dash = b.blocked ? BLOCKED_DASH : b.dashed ? ' stroke-dasharray="10 6"' : '';
  const color = b.blocked ? BLOCKED : b.color;
  const at = `x1="${b.x1}" y1="${b.y}" x2="${b.x2}" y2="${b.y}"`;
  const out: string[] = [];
  if (b.kind === 'cable') out.push(`<line ${at} stroke="${color}" stroke-width="10" stroke-opacity="0.16" stroke-linecap="round"/>`);
  out.push(`<line ${at} stroke="${color}" stroke-width="8" stroke-opacity="0.2" filter="url(#glow)"/>`);
  out.push(`<line ${at} stroke="${color}" stroke-width="${coreWidth(b)}" stroke-linecap="round"${dash}/>`);
  return out;
}

/** Legs from each board pad to the track, the lit pads and the junction dots, drawn over the boards. */
function renderTaps(b: DiagramBus): string[] {
  const out: string[] = [];
  for (const t of b.taps) {
    const dash = t.blocked ? BLOCKED_DASH : t.dashed ? ' stroke-dasharray="10 6"' : '';
    const color = t.blocked ? BLOCKED : b.color;
    out.push(`<polyline points="${pts(t.points)}" fill="none" stroke="${color}" stroke-width="7" stroke-opacity="0.16" filter="url(#glow)"/>`);
    out.push(`<polyline points="${pts(t.points)}" fill="none" stroke="${color}" stroke-width="${coreWidth(b)}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`);
  }
  for (const t of b.taps) {
    const [px, py] = t.points[0]!;
    if (t.pad !== false) {
      out.push(
        `<rect x="${px - 15}" y="${py - 15}" width="30" height="30" rx="9" fill="${b.color}" fill-opacity="0.22" filter="url(#glow)"/>`,
        `<rect x="${px - 11}" y="${py - 11}" width="22" height="22" rx="6" fill="${b.color}"/>`,
        `<circle cx="${px}" cy="${py}" r="5.2" fill="${CANVAS}"/>`
      );
    } else {
      out.push(`<circle cx="${px}" cy="${py}" r="4.5" fill="${b.color}" stroke="${CANVAS}" stroke-width="1.5"/>`);
    }
    out.push(`<circle cx="${t.x}" cy="${b.y}" r="7" fill="${b.color}" fill-opacity="0.22"/>`, `<circle cx="${t.x}" cy="${b.y}" r="4.6" fill="${b.color}"/>`);
  }
  return out;
}

/** Pill label at the head of the track. */
function renderPill(b: DiagramBus): string[] {
  const px = b.labelX;
  return [
    `<rect x="${px}" y="${b.y - 13}" width="${b.labelWidth}" height="26" rx="13" fill="${CANVAS}"/>`,
    `<rect x="${px}" y="${b.y - 13}" width="${b.labelWidth}" height="26" rx="13" fill="${b.color}" fill-opacity="0.12" stroke="${b.color}" stroke-width="2"/>`,
    `<text x="${px + b.labelWidth / 2}" y="${b.y + 5}" fill="${b.color}" font-family="${SANS}" font-size="14" font-weight="700" text-anchor="middle">${esc(b.label)}</text>`,
  ];
}

function renderLegend(card: NonNullable<ModuleDiagram['legendCard']>): string[] {
  const { x, y, width, height } = card;
  const out = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${CARD}" fill-opacity="0.94" stroke="${CARD_EDGE}"/>`,
    `<text x="${x + 20}" y="${y + 29}" fill="${TEXT}" font-family="${SANS}" font-size="15" font-weight="700">${esc(card.title)}</text>`,
    `<text x="${x + width - 20}" y="${y + 28}" fill="${MUTED}" font-family="${SANS}" font-size="9" font-weight="600" letter-spacing="2" text-anchor="end">${esc(card.caption.toUpperCase())}</text>`,
    `<line x1="${x + 16}" y1="${y + 42}" x2="${x + width - 16}" y2="${y + 42}" stroke="${CARD_EDGE}"/>`,
  ];
  const labelW = Math.max(...card.rows.map((r) => Math.min(r.label.length, 16) * 7.4));
  card.rows.forEach((r, i) => {
    const ry = y + 64 + i * 26;
    out.push(
      `<line x1="${x + 24}" y1="${ry}" x2="${x + 62}" y2="${ry}" stroke="${r.color}" stroke-width="3" stroke-linecap="round"${r.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
      `<circle cx="${x + 26}" cy="${ry}" r="4.5" fill="${r.color}" stroke="${CARD}" stroke-width="1.5"/>`,
      `<text x="${x + 76}" y="${ry + 4}" fill="${r.color}" font-family="${MONO}" font-size="12" font-weight="700">${esc(fit(r.label, 16))}</text>`,
      `<text x="${x + 76 + labelW + 12}" y="${ry + 4}" fill="${MUTED}" font-family="${SANS}" font-size="12">—</text>`,
      `<text x="${x + 76 + labelW + 34}" y="${ry + 4}" fill="${TEXT}" fill-opacity="0.8" font-family="${SANS}" font-size="12.5">${esc(fit(r.detail, 44))}</text>`
    );
  });
  if (card.blockedNote) {
    const ny = y + height - (card.dashedNote ? 40 : 16);
    out.push(
      `<line x1="${x + 24}" y1="${ny - 4}" x2="${x + 62}" y2="${ny - 4}" stroke="${BLOCKED}" stroke-width="2"${BLOCKED_DASH}/>`,
      `<text x="${x + 76}" y="${ny}" fill="${BLOCKED}" font-family="${SANS}" font-size="10.5">Red: blocked by a check, do not wire</text>`
    );
  }
  if (card.dashedNote) {
    const ny = y + height - 16;
    out.push(
      `<line x1="${x + 24}" y1="${ny - 4}" x2="${x + 62}" y2="${ny - 4}" stroke="${MUTED}" stroke-width="2" stroke-dasharray="6 4"/>`,
      `<text x="${x + 76}" y="${ny}" fill="${MUTED}" font-family="${SANS}" font-size="10.5">Dashed: proposed wiring, awaiting review</text>`
    );
  }
  return out;
}

function renderGap(g: ModuleDiagram['gapBoxes'][number]): string[] {
  const lines = wrap(g.subtitle.replace(/ — no module in library$/, ''), 32, 2);
  return [
    `<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="14" fill="${CARD}" fill-opacity="0.85" stroke="${MUTED}" stroke-opacity="0.6" stroke-dasharray="7 5"/>`,
    `<circle cx="${g.x + 24}" cy="${g.y + 25}" r="10" fill="none" stroke="${WARN}" stroke-opacity="0.85" stroke-width="1.5"/>`,
    `<path d="M${g.x + 24} ${g.y + 20}v10M${g.x + 19} ${g.y + 25}h10" stroke="${WARN}" stroke-width="1.6" stroke-linecap="round"/>`,
    `<text x="${g.x + 44}" y="${g.y + 29}" fill="${TEXT}" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="0.6">${esc(fit(g.title, 22))}</text>`,
    `<text x="${g.x + g.width - 16}" y="${g.y + 29}" fill="${WARN}" font-family="${SANS}" font-size="9" font-weight="600" letter-spacing="1.4" text-anchor="end">NEEDED</text>`,
    ...lines.map((l, k) => `<text x="${g.x + 18}" y="${g.y + 52 + k * 15}" fill="${MUTED}" font-family="${SANS}" font-size="11">${esc(l)}</text>`),
  ];
}

function renderBadge(m: ModuleDiagram['modules'][number]): string[] {
  if (!m.badge) return [];
  const bx = m.content ? m.content.x : m.x + 14;
  const by = m.content ? m.content.y - 30 : m.y + 14;
  const w = m.badge.length * 6.3 + 28;
  const color = /PRIVATE/.test(m.badge) ? '#B48EF5' : /ARTWORK/.test(m.badge) ? MUTED : WARN;
  return [
    `<rect x="${bx}" y="${by}" width="${w}" height="20" rx="10" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-opacity="0.6"/>`,
    `<circle cx="${bx + 11}" cy="${by + 10}" r="3" fill="${color}"/>`,
    `<text x="${bx + 20}" y="${by + 13.5}" fill="${color}" font-family="${SANS}" font-size="9.5" font-weight="700" letter-spacing="0.5">${esc(m.badge)}</text>`,
  ];
}

export function renderPrototypeSvg(payload: PrototypeArchitecture, artwork: Map<string, string>): string {
  const d = payload.moduleDiagram;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" font-family="${SANS}">`,
    '<defs>',
    `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1.2" cy="1.2" r="1.2" fill="${DOT}"/></pattern>`,
    `<radialGradient id="vignette" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#0A3A40" stop-opacity="0.45"/><stop offset="1" stop-color="${CANVAS}" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5FF3EE"/><stop offset="1" stop-color="#019893"/></linearGradient>`,
    `<linearGradient id="hdr-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.035"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`,
    `<filter id="glow" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>`,
    `<filter id="lift" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.45"/></filter>`,
    '</defs>',
    `<rect width="100%" height="100%" fill="${CANVAS}"/><rect width="100%" height="100%" fill="url(#dots)"/><rect width="100%" height="100%" fill="url(#vignette)"/>`
  );

  parts.push(...renderHeader(d));
  for (const b of d.buses ?? []) parts.push(...renderTrack(b));

  for (const m of d.modules) {
    const markup = artwork.get(m.instanceId);
    if (markup) {
      parts.push(`<g filter="url(#lift)">${nestArtwork(markup, m.instanceId, m.x, m.y, m.width, m.height)}</g>`);
    } else {
      const c = m.content ?? { x: m.x, y: m.y, width: m.width, height: m.height };
      parts.push(
        `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="14" fill="#0E4A50" stroke="#2BB8B6" stroke-opacity="0.6"/>`,
        `<text x="${c.x + c.width / 2}" y="${c.y + c.height / 2}" fill="${TEXT}" font-size="14" font-weight="700" text-anchor="middle">${esc(m.label)}</text>`
      );
    }
    parts.push(...renderBadge(m));
  }

  for (const b of d.buses ?? []) parts.push(...renderTaps(b));
  for (const b of d.buses ?? []) parts.push(...renderPill(b));
  for (const g of d.gapBoxes) parts.push(...renderGap(g));
  if (d.legendCard) parts.push(...renderLegend(d.legendCard));
  parts.push('</svg>');
  return parts.join('\n');
}
