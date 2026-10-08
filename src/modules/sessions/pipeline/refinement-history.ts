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

/**
 * What a refinement actually changed between two versions of the design graph, as short lines
 * ("Replaced Buck Regulator: TPS62840 → TPS63020"). Drives the version label and the card's
 * "what changed" list — the user's request is not a description of the result, and a revision
 * that changes nothing must be caught rather than saved as a new version.
 */
export function describeGraphChanges(before: CanonicalDesignGraph, after: CanonicalDesignGraph): string[] {
  const changes: string[] = [];
  const named = (label: string, partNumber?: string) => (partNumber ? `${label} (${partNumber})` : label);

  if (before.controller.partNumber !== after.controller.partNumber) {
    changes.push(`Changed controller: ${before.controller.partNumber} → ${after.controller.partNumber}`);
  }

  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      changes.push(`Added ${named(node.label, node.partNumber)}`);
    } else if ((prev.partNumber ?? '') !== (node.partNumber ?? '') && (prev.partNumber || node.partNumber)) {
      changes.push(`Replaced ${node.label}: ${prev.partNumber || 'unspecified'} → ${node.partNumber || 'unspecified'}`);
    } else if (prev.label !== node.label) {
      changes.push(`Changed ${prev.label} → ${node.label}`);
    } else if ((prev.sublabel ?? '') !== (node.sublabel ?? '')) {
      changes.push(`Updated ${node.label}: ${node.sublabel}`);
    }
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) changes.push(`Removed ${named(node.label, node.partNumber)}`);
  }

  const beforeRails = new Map(before.powerRails.map((r) => [r.name, r]));
  const afterRails = new Map(after.powerRails.map((r) => [r.name, r]));
  for (const rail of after.powerRails) {
    const prev = beforeRails.get(rail.name);
    if (!prev) changes.push(`Added ${rail.name} power rail (${rail.voltageV}V)`);
    else if (prev.voltageV !== rail.voltageV) changes.push(`Changed ${rail.name} rail: ${prev.voltageV}V → ${rail.voltageV}V`);
    else if (prev.source !== rail.source) changes.push(`${rail.name} rail now supplied by ${rail.source}`);
  }
  for (const rail of before.powerRails) {
    if (!afterRails.has(rail.name)) changes.push(`Removed ${rail.name} power rail`);
  }

  // BOM lines not already explained by a node change above.
  const nodeParts = new Set([...before.nodes, ...after.nodes].map((n) => n.partNumber).filter(Boolean));
  const beforeBom = new Set(before.bom.map((b) => b.partNumber));
  const afterBom = new Set(after.bom.map((b) => b.partNumber));
  for (const part of afterBom) if (!beforeBom.has(part) && !nodeParts.has(part)) changes.push(`Added ${part} to the BOM`);
  for (const part of beforeBom) if (!afterBom.has(part) && !nodeParts.has(part)) changes.push(`Removed ${part} from the BOM`);

  const edgeKey = (e: { from: string; to: string; type: string }) => `${e.from}→${e.to}:${e.type}`;
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  const labelOf = (id: string) => afterNodes.get(id)?.label ?? beforeNodes.get(id)?.label ?? id;
  const touched = new Set(changes.length ? [...afterNodes.keys(), ...beforeNodes.keys()].filter((id) => !beforeNodes.has(id) || !afterNodes.has(id)) : []);
  for (const e of after.edges) {
    // Wiring to a node that was just added/removed is implied by that line; only list rewiring.
    if (!beforeEdges.has(edgeKey(e)) && !touched.has(e.from) && !touched.has(e.to)) {
      changes.push(`Connected ${labelOf(e.from)} → ${labelOf(e.to)} (${e.type})`);
    }
  }
  for (const e of before.edges) {
    if (!afterEdges.has(edgeKey(e)) && !touched.has(e.from) && !touched.has(e.to)) {
      changes.push(`Disconnected ${labelOf(e.from)} → ${labelOf(e.to)} (${e.type})`);
    }
  }

  return changes;
}
