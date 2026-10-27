import {
  CanonicalDesignGraph,
  RequestedRequirement,
  RequirementCoverageItem,
  RequirementsCoverageReport,
  CoverageStatus,
  LeftOutReason,
} from './types.js';

/**
 * Normalizes text for loose substring / token matching.
 */
function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extracts meaningful tokens (length >= 3) ignoring generic stopwords.
 */
function getTokens(str: string): string[] {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'via', 'into', 'from', 'per', 'sensor', 'module', 'interface', 'device', 'unit', 'high', 'ultra', 'low', 'precision']);
  return normalize(str)
    .split(' ')
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

/**
 * Reconciles parsed user requirements against the synthesized Canonical Design Graph.
 * Categorizes each requirement into:
 *   - 'included' (with matched nodes, part numbers, or explicit consolidation)
 *   - 'left_out' (with honest reason: tradeoff, not_supported, not_parsed, merged, unexplained)
 *   - 'needs_clarification' (when missing essential electrical parameters)
 */
export function reconcileRequirements(
  requestedRequirements: RequestedRequirement[] = [],
  graph: CanonicalDesignGraph,
  rawBrief?: string,
  isTruncated: boolean = false
): RequirementsCoverageReport {
  const items: RequirementCoverageItem[] = [];

  const nodes = graph.nodes || [];
  const powerRails = graph.powerRails || [];
  const decisions = (graph.engineeringDecisions || []).join(' ').toLowerCase();

  for (const req of requestedRequirements) {
    const reqTokens = getTokens(req.name);
    const reqNorm = normalize(req.name);

    let status: CoverageStatus = 'left_out';
    let matchedNodeIds: string[] | undefined;
    let matchedPartNumber: string | undefined;
    let consolidationNote: string | undefined;
    let reason: LeftOutReason | undefined;
    let explanation: string | undefined;
    let clarificationQuestion: string | undefined;

    // 1. Direct Node Matching
    const matchedNode = nodes.find((node) => {
      const nodeText = normalize(`${node.id} ${node.label} ${node.sublabel} ${node.partNumber || ''} ${node.category}`);
      if (nodeText.includes(reqNorm) || reqNorm.includes(normalize(node.label))) return true;

      // Token overlap match: if 2+ key tokens match, or 1 highly specific token (e.g. "accelerometer", "supercapacitor", "nor")
      const matchedTokens = reqTokens.filter((t) => nodeText.includes(t));
      if (reqTokens.length === 1 && matchedTokens.length === 1) return true;
      if (matchedTokens.length >= 2) return true;

      // Special category matches
      if (req.category === 'power' && node.category === 'power') {
        if ((reqNorm.includes('battery') || reqNorm.includes('cell')) && (nodeText.includes('battery') || nodeText.includes('cell'))) return true;
        if ((reqNorm.includes('pulse') || reqNorm.includes('supercap') || reqNorm.includes('hlc') || reqNorm.includes('hpc')) &&
            (nodeText.includes('pulse') || nodeText.includes('supercap') || nodeText.includes('hpc') || nodeText.includes('hlc') || nodeText.includes('capacitor'))) {
          return true;
        }
        if ((reqNorm.includes('switch') || reqNorm.includes('fet')) && (nodeText.includes('switch') || nodeText.includes('fet'))) return true;
      }
      if (req.category === 'control' && node.category === 'control') return true;
      if (req.category === 'storage' && node.category === 'storage') return true;

      return false;
    });

    if (matchedNode) {
      status = 'included';
      matchedNodeIds = [matchedNode.id];
      matchedPartNumber = matchedNode.partNumber || undefined;

      // Check if consolidated
      if (
        (reqNorm.includes('humidity') && matchedNode.label.toLowerCase().includes('temp') && matchedNode.label.toLowerCase().includes('humidity')) ||
        (reqNorm.includes('temperature') && matchedNode.label.toLowerCase().includes('temp') && matchedNode.label.toLowerCase().includes('humidity'))
      ) {
        consolidationNote = `Consolidated into combined sensor ${matchedNode.label} (${matchedNode.partNumber || 'multi-sensor'})`;
      }
    } else {
      // 2. Power Rail Matching
      const matchedRail = powerRails.find((rail) => {
        const railText = normalize(`${rail.name} ${rail.source}`);
        return railText.includes(reqNorm) || reqTokens.some((t) => railText.includes(t));
      });

      if (matchedRail) {
        status = 'included';
        consolidationNote = `Satisfied by system power rail ${matchedRail.name} (${matchedRail.voltageV}V) from ${matchedRail.source}`;
      } else {
        // 3. Left Out / Needs Clarification Classification
        const isTradeoff = reqTokens.some((t) => decisions.includes(t)) && (decisions.includes('tradeoff') || decisions.includes('omit') || decisions.includes('deferred'));

        if (isTradeoff) {
          status = 'left_out';
          reason = 'tradeoff';
          explanation = 'Omitted or modified based on architectural tradeoff described in engineering decisions.';
        } else if (reqNorm.includes('analog') && reqNorm.includes('input') && !nodes.some((n) => n.id.includes('adc'))) {
          status = 'needs_clarification';
          clarificationQuestion = 'Specify signal range (e.g. 0-10V, 4-20mA), isolation requirements, and sampling rate.';
        } else if (isTruncated && rawBrief && rawBrief.length >= 6000 && !rawBrief.slice(0, 5800).toLowerCase().includes(reqNorm)) {
          status = 'left_out';
          reason = 'not_parsed';
          explanation = 'Excluded because input exceeded character acceptance bounds.';
        } else {
          status = 'left_out';
          reason = 'unexplained';
          explanation = 'Not represented in current baseline design. You can add this requirement using chat refinement.';
        }
      }
    }

    items.push({
      id: req.id,
      name: req.name,
      category: req.category,
      status,
      matchedNodeIds,
      matchedPartNumber,
      consolidationNote,
      reason,
      explanation,
      clarificationQuestion,
    });
  }

  const totalRequested = items.length;
  const includedCount = items.filter((i) => i.status === 'included').length;
  const leftOutCount = items.filter((i) => i.status === 'left_out').length;
  const needsClarificationCount = items.filter((i) => i.status === 'needs_clarification').length;
  const coveragePercentage = totalRequested > 0 ? Math.round((includedCount / totalRequested) * 100) : 100;

  let inputWarning: string | undefined;
  if (isTruncated) {
    inputWarning = 'User engineering specification reached input character limit (6,000 characters); trailing text may have been unparsed.';
  }

  return {
    totalRequested,
    includedCount,
    leftOutCount,
    needsClarificationCount,
    coveragePercentage,
    items,
    inputWarning,
  };
}
