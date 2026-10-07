import { PrototypeArchitecture } from './prototype.types.js';

/**
 * Server-side SVG of the module diagram (the `svg` export of a Prototype session). Uses the same
 * geometry the frontend draws; each board's library artwork is nested at its placement with its
 * element ids prefixed per instance, so two copies of one board never collide.
 */

const NAVY = '#06262B';
const GRID = '#0E3A40';
const TEXT = '#EAF6F6';
const MUTED = '#8EA7AA';
const WARN = '#F5B84B';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

export function renderPrototypeSvg(payload: PrototypeArchitecture, artwork: Map<string, string>): string {
  const d = payload.moduleDiagram;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" font-family="Inter, Arial, sans-serif">`,
    `<defs><pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="${GRID}" stroke-width="0.6" opacity="0.5"/></pattern></defs>`,
    `<rect width="100%" height="100%" fill="${NAVY}"/><rect width="100%" height="100%" fill="url(#grid)"/>`,
    `<text x="24" y="28" fill="${TEXT}" font-size="14" font-weight="600">${esc(d.header.title)}</text>`,
    `<text x="${d.width - 24}" y="28" fill="${MUTED}" font-size="12" text-anchor="end">${esc(d.header.summary)}</text>`
  );

  for (const wire of d.wires) {
    const points = wire.points.map(([x, y]) => `${x},${y}`).join(' ');
    const dash = wire.dashed ? ' stroke-dasharray="6 4"' : '';
    if (wire.kind === 'cable') {
      parts.push(
        `<polyline points="${points}" fill="none" stroke="${wire.color}" stroke-width="${wire.strokeWidth}" stroke-linejoin="round" opacity="0.35"${dash}/>`,
        `<polyline points="${points}" fill="none" stroke="${wire.color}" stroke-width="1.6" stroke-linejoin="round"${dash}/>`
      );
    } else {
      parts.push(`<polyline points="${points}" fill="none" stroke="${wire.color}" stroke-width="${wire.strokeWidth}" stroke-linejoin="round"${dash}/>`);
    }
  }
  for (const j of d.junctions) parts.push(`<circle cx="${j.x}" cy="${j.y}" r="3.2" fill="${j.color}"/>`);

  for (const m of d.modules) {
    const instance = payload.instances.find((i) => i.instanceId === m.instanceId);
    const markup = instance ? artwork.get(instance.hardwareEntityId) : undefined;
    if (markup) {
      parts.push(nestArtwork(markup, m.instanceId, m.x, m.y, m.width, m.height));
    } else {
      parts.push(
        `<rect x="${m.x}" y="${m.y}" width="${m.width}" height="${m.height}" rx="7" fill="#0A3A40" stroke="#075F69"/>`,
        `<text x="${m.x + m.width / 2}" y="${m.y + m.height / 2}" fill="${TEXT}" font-size="11" text-anchor="middle">${esc(m.label)}</text>`
      );
    }
    if (m.badge) {
      parts.push(
        `<rect x="${m.x - 3}" y="${m.y - 3}" width="${m.width + 6}" height="${m.height + 6}" rx="9" fill="none" stroke="${WARN}" stroke-dasharray="6 4"/>`,
        `<text x="${m.x}" y="${m.y - 8}" fill="${WARN}" font-size="9" font-weight="600">${esc(m.badge)}</text>`
      );
    }
  }

  for (const l of d.labels) parts.push(`<text x="${l.x}" y="${l.y}" fill="${l.color}" font-size="9" font-family="monospace" text-anchor="middle">${esc(l.text)}</text>`);
  for (const g of d.gapBoxes) {
    parts.push(
      `<rect x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" rx="7" fill="none" stroke="${MUTED}" stroke-dasharray="6 4"/>`,
      `<text x="${g.x + 12}" y="${g.y + 24}" fill="${MUTED}" font-size="11" font-weight="600">${esc(g.title)}</text>`,
      `<text x="${g.x + 12}" y="${g.y + 42}" fill="${MUTED}" font-size="9">${esc(g.subtitle.slice(0, 48))}</text>`
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}
