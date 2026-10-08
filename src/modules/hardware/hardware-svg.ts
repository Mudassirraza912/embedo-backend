/**
 * Library artwork follows the perimeter-v1 contract (plan C3): connector blocks sit on the board
 * edge and every wireable contact has an `<circle class="embedo-anchor">` outside the outline,
 * whose id equals the record's svg_anchor_id. Whole connectors (STEMMA QT / Qwiic) carry
 * `embedo-anchor-whole`.
 *
 * The SVG is served to browsers and inlined into the diagram, so it is treated as untrusted
 * markup: anything that can execute or load remote content is rejected at import, not stripped.
 */

export interface SvgAnchor {
  id: string;
  x: number;
  y: number;
  whole: boolean;
  connectorId: string | null;
  contactId: string | null;
  pinId: string | null;
}

export interface ParsedModuleSvg {
  width: number;
  height: number;
  anchors: Map<string, SvgAnchor>;
}

export class UnsafeSvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeSvgError';
  }
}

const UNSAFE_PATTERNS: Array<[RegExp, string]> = [
  [/<script\b/i, '<script> element'],
  [/<foreignObject\b/i, '<foreignObject> element'],
  [/<!DOCTYPE|<!ENTITY/i, 'DOCTYPE / entity declaration'],
  [/\son[a-z]+\s*=/i, 'inline event handler attribute'],
  [/javascript:/i, 'javascript: URL'],
  [/(?:xlink:)?href\s*=\s*["'](?!#)/i, 'external href (only #fragment references are allowed)'],
  [/url\(\s*["']?(?!#)/i, 'external url() reference'],
  [/@import/i, 'CSS @import'],
  [/<(?:iframe|embed|object|image|use)\b[^>]*\bhref\s*=\s*["'](?!#)/i, 'external resource element'],
];

/** Returns the SVG unchanged when it is safe to serve; throws UnsafeSvgError otherwise. */
export function assertSafeModuleSvg(svg: string): string {
  const trimmed = svg.trim();
  if (!/^(?:<\?xml[^>]*\?>\s*)?<svg\b/i.test(trimmed)) {
    throw new UnsafeSvgError('not an SVG document (must start with <svg>)');
  }
  for (const [pattern, label] of UNSAFE_PATTERNS) {
    if (pattern.test(trimmed)) throw new UnsafeSvgError(`contains ${label}`);
  }
  return trimmed;
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

const readAttributes = (tagBody: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const match of tagBody.matchAll(ATTRIBUTE)) {
    attrs[match[1]!] = match[2]!;
  }
  return attrs;
};

/** viewBox size of the root element, falling back to width/height. */
function readRootSize(svg: string): { width: number; height: number } {
  const root = /<svg\b([^>]*)>/i.exec(svg);
  const attrs = root ? readAttributes(root[1]!) : {};
  const viewBox = attrs['viewBox']?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  const width = parseFloat(attrs['width'] ?? '');
  const height = parseFloat(attrs['height'] ?? '');
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  throw new UnsafeSvgError('root <svg> has no usable viewBox or width/height');
}

const parseCache = new Map<string, ParsedModuleSvg>();
const PARSE_CACHE_LIMIT = 500;

/**
 * Anchor geometry is derived from the stored SVG on every use, never stored as a second truth.
 * `cacheKey` (the generation_source_hash) makes repeated renders of the same board free.
 */
export function parseModuleSvg(svg: string, cacheKey?: string): ParsedModuleSvg {
  if (cacheKey) {
    const hit = parseCache.get(cacheKey);
    if (hit) return hit;
  }

  const { width, height } = readRootSize(svg);
  const anchors = new Map<string, SvgAnchor>();
  for (const match of svg.matchAll(/<circle\b([^>]*?)\/?>/gi)) {
    const attrs = readAttributes(match[1]!);
    const classes = (attrs['class'] ?? '').split(/\s+/);
    if (!classes.includes('embedo-anchor') || !attrs['id']) continue;
    const x = Number(attrs['cx']);
    const y = Number(attrs['cy']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    anchors.set(attrs['id'], {
      id: attrs['id'],
      x,
      y,
      whole: classes.includes('embedo-anchor-whole'),
      connectorId: attrs['data-connector-id'] ?? null,
      contactId: attrs['data-contact-id'] ?? null,
      pinId: attrs['data-pin-id'] ?? null,
    });
  }

  const parsed = { width, height, anchors };
  if (cacheKey) {
    if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
    parseCache.set(cacheKey, parsed);
  }
  return parsed;
}

/** Element ids must be unique inside one artwork (validate.py). Returns the duplicates. */
export function duplicateSvgIds(svg: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const match of svg.matchAll(/\sid\s*=\s*"([^"]+)"/g)) {
    const id = match[1]!;
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}
