import { z } from 'zod';
import { aiRouterService } from '../../ai/ai-router.service.js';
import { CanonicalDesignGraph, StructuredIntent, NODE_CATEGORIES, EDGE_TYPES } from './types.js';
import { GroundingContext } from './rag-grounder.js';
import { logger } from '../../../config/logger.js';
import { stripJsonFences } from './json-utils.js';

const designNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  sublabel: z.string(),
  category: z.enum(NODE_CATEGORIES),
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
  type: z.enum(EDGE_TYPES),
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
  iterationNotes?: string
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
8. "suggestedRefinements": propose 3-5 short, chip-friendly next steps (max ~6 words each, e.g. "Add battery backup", "Add Wi-Fi connectivity") for things THIS SPECIFIC design does not yet have. Ground them in what's actually missing from the current nodes/edges/powerRails — never suggest something already present in this design (e.g. don't suggest "Add battery backup" if a battery/charger node already exists).`;

  const userPrompt = `Synthesize the Canonical Design Graph for the following hardware intent:
${JSON.stringify(intent, null, 2)}

${iterationNotes ? `User Revision / Focus: ${iterationNotes}\n` : ''}
${
  grounding.datasheetSnippets.length > 0
    ? `GROUNDED REFERENCE CONTEXT:\n${grounding.datasheetSnippets.map((s) => s.text).join('\n')}\n`
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

  const runOnce = async () =>
    aiRouterService.executeTask({
      taskCase: 'A', // Sol Tier — model/maxTokens come from the model_routes row
      systemPrompt,
      userPrompt,
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
    aiResult = await runOnce();
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
