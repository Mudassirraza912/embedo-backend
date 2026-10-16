/** Remove ```json fences and surrounding whitespace from a model response. */
export const stripJsonFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

/**
 * Attempts to parse JSON, and if it fails due to truncation (e.g. LLM hitting max token limit mid-stream),
 * repairs the syntax by closing strings, stripping dangling commas/incomplete keys, and closing brackets.
 */
export function safeParseOrRepairJson(raw: string): unknown {
  const text = stripJsonFences(raw);
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to progressive repair
  }

  let candidate = text;
  for (let attempts = 0; attempts < 100 && candidate.length > 20; attempts++) {
    let inString = false;
    let escaped = false;
    const stack: string[] = [];

    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
          if (stack.length > 0 && stack[stack.length - 1] === ch) {
            stack.pop();
          }
        }
      }
    }

    let repaired = candidate;
    if (inString) {
      repaired += '"';
    }
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    repaired = repaired.replace(/,\s*$/g, '');
    repaired = repaired.replace(/:\s*"?$/g, ': null');

    let closing = '';
    for (let i = stack.length - 1; i >= 0; i--) {
      closing += stack[i];
    }

    try {
      const parsed = JSON.parse(repaired + closing) as Record<string, any>;
      // Prune any partial array tail objects (e.g. incomplete node, edge, or bom item cut off mid-stream)
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.bom) && parsed.bom.length > 0) {
          const lastBom = parsed.bom[parsed.bom.length - 1];
          if (!lastBom || typeof lastBom !== 'object' || !lastBom.partNumber || !lastBom.manufacturer || !lastBom.category || !lastBom.description) {
            parsed.bom.pop();
          }
        }
        if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
          const lastNode = parsed.nodes[parsed.nodes.length - 1];
          if (!lastNode || typeof lastNode !== 'object' || !lastNode.id || !lastNode.label || !lastNode.category || !lastNode.partNumber) {
            parsed.nodes.pop();
          }
        }
        if (Array.isArray(parsed.edges) && parsed.edges.length > 0) {
          const lastEdge = parsed.edges[parsed.edges.length - 1];
          if (!lastEdge || typeof lastEdge !== 'object' || !lastEdge.from || !lastEdge.to || !lastEdge.type) {
            parsed.edges.pop();
          }
        }
        if (Array.isArray(parsed.powerRails) && parsed.powerRails.length > 0) {
          const lastRail = parsed.powerRails[parsed.powerRails.length - 1];
          if (!lastRail || typeof lastRail !== 'object' || !lastRail.name || typeof lastRail.voltageV !== 'number' || !lastRail.source) {
            parsed.powerRails.pop();
          }
        }
      }
      return parsed;
    } catch {
      // Step backwards to the previous element/property separator
      const lastComma = candidate.lastIndexOf(',');
      const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
      const cutoff = Math.max(lastComma, lastBrace);
      if (cutoff <= 0 || cutoff >= candidate.length - 1) {
        candidate = candidate.slice(0, -20);
      } else {
        candidate = candidate.slice(0, cutoff);
      }
    }
  }

  return undefined;
}
