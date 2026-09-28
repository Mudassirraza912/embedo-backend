import { z } from 'zod';
import { aiRouterService } from '../../ai/ai-router.service.js';
import { CanonicalDesignGraph, StructuredIntent, NODE_CATEGORIES, EDGE_TYPES, NodeCategory, EdgeType } from './types.js';
import { GroundingContext } from './rag-grounder.js';
import { logger } from '../../../config/logger.js';
import { stripJsonFences } from './json-utils.js';

// The model regularly reaches for a near-synonym of an allowed enum value ("actuation" for a relay,
// "sensor" for "sensing", "wireless" for "connectivity"). Rejecting the whole graph for one
// off-vocabulary label threw away otherwise-valid designs and failed the session outright (seen
// live on a relay-driven water-pump controller), so map known synonyms onto the canonical value
// before validation. Anything unrecognised still fails validation and goes through the retry.
const NODE_CATEGORY_SYNONYMS: Readonly<Record<string, NodeCategory>> = {
  actuation: 'motor', actuator: 'motor', actuators: 'motor', relay: 'motor', driver: 'motor', output: 'motor', outputs: 'motor', load: 'motor',
  sensor: 'sensing', sensors: 'sensing', input: 'sensing', inputs: 'sensing', measurement: 'sensing',
  mcu: 'control', controller: 'control', processing: 'control', compute: 'control', protection: 'control',
  wireless: 'connectivity', communication: 'connectivity', communications: 'connectivity', comms: 'connectivity', radio: 'connectivity', interface: 'connectivity',
  memory: 'storage', display: 'ui', 'user interface': 'ui', indicator: 'ui', indicators: 'ui',
  battery: 'power', 'power management': 'power', supply: 'power', regulator: 'power',
  fuel_gauge: 'gauge', 'fuel gauge': 'gauge', speaker: 'audio', microphone: 'audio', vibration: 'haptic',
};

const EDGE_TYPE_SYNONYMS: Readonly<Record<string, EdgeType>> = {
  i2s: 'signal', pwm: 'gpio', digital: 'gpio', control: 'gpio', data: 'signal', 'i²c': 'i2c', can: 'signal', rs485: 'uart', adc: 'analog', sdio: 'sdmmc',
};

function normalizeEnum<T extends string>(allowed: readonly T[], synonyms: Readonly<Record<string, T>>) {
  return (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const key = value.trim().toLowerCase();
    if ((allowed as readonly string[]).includes(key)) return key;
    const mapped = synonyms[key];
    if (mapped) {
      logger.warn({ received: value, mappedTo: mapped }, 'Design graph enum value normalised');
      return mapped;
    }
    return value;
  };
}

const designNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  sublabel: z.string(),
  category: z.preprocess(normalizeEnum(NODE_CATEGORIES, NODE_CATEGORY_SYNONYMS), z.enum(NODE_CATEGORIES)),
  partNumber: z.string(),
  manufacturer: z.string().optional(),
  rationale: z.string().optional(),
  voltageV: z.number().optional(),
  currentMa: z.number().optional(),
  interfaces: z.array(z.string()).optional(),
  evidenceSources: z
    .array(
      z.object({
        source: z.string(),
        docUrl: z.string().optional(),
        reason: z.string(),
      })
    )
    .optional(),
});

const designEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string(),
  type: z.preprocess(normalizeEnum(EDGE_TYPES, EDGE_TYPE_SYNONYMS), z.enum(EDGE_TYPES)),
  busType: z.string().optional(),
  dashed: z.boolean().optional(),
});

const powerRailSchema = z.object({
  name: z.string(),
  voltageV: z.number(),
  source: z.string(),
  regulatorPart: z.string().optional(),
  consumers: z.array(z.string()),
});

const bomItemSchema = z.object({
  partNumber: z.string(),
  manufacturer: z.string(),
  category: z.string(),
  description: z.string(),
  qty: z.number().default(1),
  unitCostUsd: z.number().optional(),
  datasheetUrl: z.string().optional(),
});

export const canonicalDesignGraphSchema = z.object({
  projectMeta: z.object({
    name: z.string(),
    tagline: z.string(),
    controller: z.string(),
  }),
  controller: z.object({
    partNumber: z.string(),
    manufacturer: z.string(),
    rationale: z.string(),
  }),
  nodes: z.array(designNodeSchema),
  edges: z.array(designEdgeSchema),
  powerRails: z.array(powerRailSchema),
  bom: z.array(bomItemSchema),
  engineeringDecisions: z.array(z.string()).optional(),
  suggestedRefinements: z.array(z.string().max(60)).max(6).optional(),
});

/**
 * Sol Tier (gpt-4o): Deep Relational Hardware Synthesis
 * Synthesizes a unified CanonicalDesignGraph containing controllers, peripherals,
 * power distribution, electrical pin interfaces, and Bill of Materials.
 */
export async function buildCanonicalDesignGraph(
  intent: StructuredIntent,
  grounding: GroundingContext,
  sessionId?: string,
  iterationNotes?: string,
  /** Present for refinements: the design being revised and every change it already contains. */
  revision?: { baseline: unknown; appliedChanges: string[] }
): Promise<{ graph: CanonicalDesignGraph; rawResponse: string }> {
  const systemPrompt = `You are Sol, the lead embedded systems architect at Embedo.ai.
Your goal is to synthesize a production-grade, electrically consistent Canonical Design Graph for an embedded hardware system based on user specifications.

CRITICAL HARDWARE RULES:
1. Every component MUST have real, commercially available manufacturer part numbers (e.g. ESP32-S3-MINI-1, BQ25186, AP63203WU-7, DRV2605L, BQ27426, MMICT5848, ICM-42688-P, etc.).
2. Node IDs must be clean lowercase alphanumeric strings (e.g. "usbc", "mcu", "charger", "battery", "regulator", "imu", "storage", "display", "haptic", "gauge").
3. Power Path: Always include a complete power path (e.g., USB-C 5V -> Charger -> LiPo Battery -> 3.3V Buck/LDO Regulator -> MCU and loads).
4. Category values must be one of: power, control, sensing, storage, connectivity, audio, ui, haptic, gauge, motor.
5. Edge types must be one of: power, i2c, spi, uart, usb, sdmmc, gpio, signal, analog.
6. Power rails must list every active voltage domain (e.g. 5V, 3.3V, VSYS, VBAT) and all consumer node IDs connected to that rail.
7. Output valid JSON matching the exact schema without markdown formatting or code blocks.
8. "suggestedRefinements": propose 3-5 short, chip-friendly next steps (max ~6 words each, e.g. "Add battery backup", "Add Wi-Fi connectivity") for things THIS SPECIFIC design does not yet have. Ground them in what's actually missing from the current nodes/edges/powerRails — never suggest something already present in this design (e.g. don't suggest "Add battery backup" if a battery/charger node already exists).
9. When a component's grounded specs include BOTH "recommendedOperating" and "absoluteMaxRatings", the two are DIFFERENT tables from the datasheet, not one range: absoluteMaxRatings is a destructive limit the datasheet itself marks as "stress ratings only, exceeding these may cause permanent damage" — it is NEVER a value to design to. Every node's voltageV and every power rail must come from recommendedOperating (its "typ", or a value inside its min/max). If only absoluteMaxRatings is present for a part, treat its operating range as unknown rather than using the absolute-max figures directly. The same applies to currentMa: never use an absoluteMaxRatings current (e.g. a pin input limit) as a node's current draw. Take currentMa from recommendedOperating or from supply/quiescent/active current figures stated in the grounded text; if none is grounded, give a conservative engineering estimate and say so in the node's rationale.
10. Grounded specs may also list "powerModes" (supply current per operating mode, already in mA), "interfaces" (role, voltage level, max rate and pull-up requirements), "cautions" (constraints stated in the datasheet) and "pins". Use them: size a node's currentMa from its active/typical powerModes entry, put the required pull-ups and logic-level compatibility on the matching bus edges, never violate a listed caution (e.g. a pin that must not be pulled low at boot), and use the listed pin names for interface pin assignments rather than inventing pins.`;

  const userPrompt = `Synthesize the Canonical Design Graph for the following hardware intent:
${JSON.stringify(intent, null, 2)}

${
  revision
    ? `REVISION MODE — you are MODIFYING the existing design below, not starting over.
CURRENT DESIGN (baseline):
${JSON.stringify(revision.baseline)}
${
  revision.appliedChanges.length > 0
    ? `Changes already applied to this design — every one of them MUST still be present in your output:\n${revision.appliedChanges.map((c) => `- ${c}`).join('\n')}\n`
    : ''
}REQUESTED CHANGE NOW: ${iterationNotes ?? ''}
Revision rules: keep every baseline node, edge, power rail and BOM line unless the requested change explicitly removes or replaces it; keep existing node ids; add or adjust only what the requested change needs. "suggestedRefinements" must not repeat any change listed above or anything already present in the baseline.
`
    : iterationNotes
      ? `User Revision / Focus: ${iterationNotes}\n`
      : ''
}
${
  grounding.datasheetSnippets.length > 0
    ? `GROUNDED REFERENCE CONTEXT (specs.recommendedOperating = design to this; specs.absoluteMaxRatings = destructive limit, never design to this — see rule 9):\n${grounding.datasheetSnippets.map((s) => s.text).join('\n')}\n`
    : ''
}
DESIGN GUIDELINES:
${grounding.designGuidelines.join('\n')}

Output JSON adhering strictly to:
{
  "projectMeta": { "name": string, "tagline": string, "controller": string },
  "controller": { "partNumber": string, "manufacturer": string, "rationale": string },
  "nodes": [
    {
      "id": string,
      "label": string,
      "sublabel": string,
      "category": "power" | "control" | "sensing" | "storage" | "connectivity" | "audio" | "ui" | "haptic" | "gauge" | "motor",
      "partNumber": string,
      "manufacturer": string,
      "rationale": string,
      "voltageV": number,
      "currentMa": number,
      "interfaces": string[]
    }
  ],
  "edges": [
    {
      "from": string,
      "to": string,
      "label": string,
      "type": "power" | "i2c" | "spi" | "uart" | "usb" | "sdmmc" | "gpio" | "signal" | "analog",
      "busType": string,
      "dashed": boolean
    }
  ],
  "powerRails": [
    {
      "name": string,
      "voltageV": number,
      "source": string,
      "regulatorPart": string,
      "consumers": string[]
    }
  ],
  "bom": [
    {
      "partNumber": string,
      "manufacturer": string,
      "category": string,
      "description": string,
      "qty": number,
      "unitCostUsd": number
    }
  ],
  "engineeringDecisions": string[],
  "suggestedRefinements": string[]
}`;

  const parseGraph = (text: string): unknown => {
    try {
      return JSON.parse(stripJsonFences(text));
    } catch {
      return undefined;
    }
  };

  const runOnce = async (correction?: string) =>
    aiRouterService.executeTask({
      taskCase: 'A', // Sol Tier — model/maxTokens come from the model_routes row
      systemPrompt,
      userPrompt: correction ? `${userPrompt}\n\n${correction}` : userPrompt,
      sessionId,
      temperature: 0.2,
      jsonMode: true,
      validateResponse: (text) => canonicalDesignGraphSchema.safeParse(parseGraph(text)).success,
    });

  // Rule #8: schema-invalid output is retried exactly once, then surfaced.
  let aiResult = await runOnce();
  let parsed = canonicalDesignGraphSchema.safeParse(parseGraph(aiResult.content));

  if (!parsed.success) {
    logger.warn(
      { sessionId, issues: parsed.error.issues.slice(0, 5) },
      'Sol design graph failed schema validation — retrying once'
    );
    await aiRouterService.markSchemaResult(aiResult.aiCallId, false, parsed.error.message);
    // Tell the model exactly what was wrong — re-sending the identical prompt just reproduced the
    // same invalid value on the retry.
    const problems = parsed.error.issues
      .slice(0, 8)
      .map((i) => `- ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    aiResult = await runOnce(
      `CORRECTION: your previous response did not match the schema:\n${problems}\nReturn the complete JSON again, using ONLY the allowed enum values listed above.`
    );
    parsed = canonicalDesignGraphSchema.safeParse(parseGraph(aiResult.content));
    if (!parsed.success) {
      logger.error({ sessionId, issues: parsed.error.issues.slice(0, 5) }, 'Sol design graph failed schema validation twice');
      await aiRouterService.markSchemaResult(aiResult.aiCallId, false, parsed.error.message);
      throw new DesignGraphSchemaError('AI generation returned a design graph that does not match the expected schema');
    }
  }

  return {
    graph: parsed.data as CanonicalDesignGraph,
    rawResponse: aiResult.content,
  };
}

/**
 * Rule #8 already retried this once with an explicit correction instruction (see runOnce
 * above); a second schema failure is a strong, repeatable signal, not a transient blip, so the
 * queue must not spend a further 3 blanket retries re-asking the same question. Mirrors
 * intent-parser.ts's IntentExtractionError classification.
 */
export class DesignGraphSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignGraphSchemaError';
  }
}
