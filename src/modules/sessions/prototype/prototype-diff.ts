import { PrototypeArchitecture } from './prototype.types.js';

/**
 * Plain-text views of a stored bench, read straight from its nets. They ground every model that
 * talks about the bench (resolver, chat replies) in what is actually wired, and they produce the
 * "What changed" list of a new version, so a summary can never claim a change the graph lacks.
 */

type Bench = Pick<PrototypeArchitecture, 'instances' | 'nets' | 'compatibility'>;

const pinKey = (m: { instanceId: string; pinName: string }) => `${m.instanceId}.${m.pinName}`;

/** One line per net: "3V3 (power): regulator1.VOUT, mcu.VIN, gps1.VIN". */
export function describeNets(bench: Pick<Bench, 'nets'>): string[] {
  return bench.nets.map((n) => `${n.name} (${n.class}): ${n.members.map(pinKey).join(', ')}`);
}

/** Compact bench description for prompts: boards, every net, and the open problems. */
export function describeBench(bench: Bench, maxIssues = 8): string {
  const boards = bench.instances.map((i) => `${i.instanceId}: ${i.label}${i.isController ? ' (controller)' : ''}`);
  const issues = bench.compatibility.results
    .filter((r) => r.status !== 'PASS')
    .slice(0, maxIssues)
    .map((r) => `${r.status}: ${r.message}`);
  return [
    'Boards:',
    ...boards.map((b) => `- ${b}`),
    'Nets (every electrical connection on the bench; nothing else is wired):',
    ...describeNets(bench).map((n) => `- ${n}`),
    ...(issues.length > 0 ? ['Open checks:', ...issues.map((i) => `- ${i}`)] : []),
  ].join('\n');
}

export interface BenchDiff {
  /** Human-readable lines, empty when the two benches are electrically identical. */
  lines: string[];
  changed: boolean;
}

/**
 * What changed between two versions: boards added, removed or swapped, and nets whose members
 * changed. Compared by the pins on each net, so a renamed net with the same members is no change.
 */
export function diffBenches(previous: Bench | null, next: Bench): BenchDiff {
  if (!previous) return { lines: [], changed: true };
  const lines: string[] = [];

  const before = new Map(previous.instances.map((i) => [i.instanceId, i]));
  const after = new Map(next.instances.map((i) => [i.instanceId, i]));
  for (const [id, inst] of after) {
    const old = before.get(id);
    if (!old) lines.push(`Added ${inst.label} (${id})`);
    else if (old.hardwareEntityId !== inst.hardwareEntityId) lines.push(`Swapped ${id}: ${old.label} → ${inst.label}`);
  }
  for (const [id, inst] of before) if (!after.has(id)) lines.push(`Removed ${inst.label} (${id})`);

  // A net is identified by its member pins; names only label it.
  const signature = (members: Array<{ instanceId: string; pinName: string }>) => members.map(pinKey).sort().join('|');
  const beforeNets = new Map(previous.nets.map((n) => [signature(n.members), n]));
  const afterNets = new Map(next.nets.map((n) => [signature(n.members), n]));
  const removed = previous.nets.filter((n) => !afterNets.has(signature(n.members)));
  const added = next.nets.filter((n) => !beforeNets.has(signature(n.members)));
  // Pair a removed and an added net that share a pin as one rewired net.
  const pairedRemoved = new Set<string>();
  for (const net of added) {
    const pins = new Set(net.members.map(pinKey));
    const old = removed.find((r) => !pairedRemoved.has(r.netId) && r.members.some((m) => pins.has(pinKey(m))));
    if (old) {
      pairedRemoved.add(old.netId);
      const oldPins = new Set(old.members.map(pinKey));
      const gained = net.members.map(pinKey).filter((p) => !oldPins.has(p));
      const lost = old.members.map(pinKey).filter((p) => !pins.has(p));
      const parts = [gained.length > 0 ? `now ${gained.join(', ')}` : null, lost.length > 0 ? `no longer ${lost.join(', ')}` : null].filter(Boolean);
      lines.push(`Rewired ${net.name}${old.name !== net.name ? ` (was ${old.name})` : ''}: ${parts.join('; ')}`);
    } else {
      lines.push(`Connected ${net.name}: ${net.members.map(pinKey).join(' ↔ ')}`);
    }
  }
  for (const old of removed) if (!pairedRemoved.has(old.netId)) lines.push(`Disconnected ${old.name}: ${old.members.map(pinKey).join(' ↔ ')}`);

  return { lines, changed: lines.length > 0 };
}
