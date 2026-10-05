import { prisma } from '../../../db/prisma.js';
import type { CanonicalDesignGraph } from './types.js';

const INITIAL_CHANGE = 'Initial architecture generated';
const RESTORE_PREFIX = /^Restored snapshot from (v\d+\.\d+)/;

/**
 * The refinements the ACTIVE version actually contains, oldest first.
 *
 * Versions form a lineage rather than a flat list: restoring v1.0 creates a new version whose
 * contents are v1.0's, so refinements made after v1.0 are no longer part of the design. Walking
 * the history and resetting on each restore keeps "what has been applied" in step with what the
 * user is looking at.
 */
export async function getAppliedChangeLineage(sessionId: string): Promise<string[]> {
  const versions = await prisma.sessionVersion.findMany({
    where: { sessionId },
    orderBy: { versionNumber: 'asc' },
    select: { versionTag: true, appliedChanges: true },
  });

  const lineageByTag = new Map<string, string[]>();
  let current: string[] = [];
  for (const v of versions) {
    const changes = Array.isArray(v.appliedChanges) ? v.appliedChanges.filter((c): c is string => typeof c === 'string') : [];
    const restoredFrom = changes.map((c) => RESTORE_PREFIX.exec(c)?.[1]).find(Boolean);
    current = restoredFrom
      ? [...(lineageByTag.get(restoredFrom) ?? [])]
      : [...current, ...changes.filter((c) => c !== INITIAL_CHANGE)];
    lineageByTag.set(v.versionTag, current);
  }
  return current;
}

// Words that carry no identity for a change: the imperative verb, articles, glue words.
const FILLER = new Set([
  'add', 'adding', 'include', 'including', 'implement', 'integrate', 'incorporate', 'enable', 'use', 'support', 'provide',
  'introduce', 'put', 'build', 'insert', 'please', 'also', 'a', 'an', 'the', 'for', 'with', 'to', 'of', 'and', 'in', 'on',
  'some', 'new', 'extra', 'feature', 'capability', 'option', 'design', 'it', 'its', 'this',
]);

/** Order-, verb- and plural-insensitive identity of a change ("Include ESD protection" == "Add ESD protections"). */
export function changeKey(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length > 1 && !FILLER.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  );
}

/** Same change if one key contains the other (e.g. "ESD protection" vs "USB ESD protection"). */
export function isSameChange(a: string, b: string): boolean {
  const ka = changeKey(a);
  const kb = changeKey(b);
  if (ka.size === 0 || kb.size === 0) return false;
  const [small, big] = ka.size <= kb.size ? [ka, kb] : [kb, ka];
  return [...small].every((w) => big.has(w));
}

/** Drops suggestions the design already received — they read as "the AI forgot what it just did". */
export function filterAppliedSuggestions(suggestions: string[] | undefined, applied: string[]): string[] {
  if (!suggestions) return [];
  const seen: string[] = [];
  return suggestions.filter((s) => {
    if (applied.some((a) => isSameChange(s, a)) || seen.some((x) => isSameChange(s, x))) return false;
    seen.push(s);
    return true;
  });
}

/** A compact view of the current graph for the revision prompt — enough to preserve it, not the whole payload. */
export function compactGraphForRevision(graph: CanonicalDesignGraph): unknown {
  return {
    controller: graph.controller,
    nodes: graph.nodes.map((n) => ({ id: n.id, label: n.label, sublabel: n.sublabel, category: n.category, partNumber: n.partNumber })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, label: e.label })),
    powerRails: graph.powerRails.map((r) => ({ name: r.name, voltageV: r.voltageV, source: r.source, consumers: r.consumers })),
    bom: graph.bom.map((b) => ({ partNumber: b.partNumber, manufacturer: b.manufacturer, category: b.category, qty: b.qty })),
  };
}
