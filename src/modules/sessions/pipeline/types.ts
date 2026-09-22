import { z } from 'zod';

// NOTE: deviceType / purpose intentionally default to '' (not a placeholder) so a model
// response that omits them fails the sufficiency gate instead of silently passing it.
// Models frequently emit `null` for unknown fields; every field tolerates null.
const nullableString = z.string().nullable().optional().transform((v) => v ?? '');
const nullableStringArray = z.array(z.string()).nullable().optional();
const nullableNumber = z.number().nullable().optional();
const nullableStr = z.string().nullable().optional();

export const structuredIntentSchema = z.object({
  deviceType: nullableString,
  purpose: nullableString,
  subsystems: z
    .object({
      sensing: nullableStringArray,
      actuation: nullableStringArray,
      connectivity: nullableStringArray,
      power: nullableStringArray,
      storage: nullableStringArray,
      ui: nullableStringArray,
      audio: nullableStringArray,
    })
    .nullable()
    .optional()
    .transform((v) => v ?? {}),
  constraints: z
    .object({
      formFactor: nullableStr,
      powerSource: nullableStr,
      batteryLifeHours: nullableNumber,
      environment: nullableStr,
      costTargetUsd: nullableNumber,
    })
    .nullable()
    .optional()
    .transform((v) => v ?? {}),
  mustHaveInterfaces: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  // True when the user's message isn't a request to design/discuss embedded hardware at all
  // (general chit-chat, unrelated how-to questions, greetings) — see sufficiency-gate.ts's
  // isOffTopicChat for the zero-cost heuristic counterpart that catches the obvious cases
  // before this field is ever populated.
  isOffTopic: z.boolean().nullable().optional().transform((v) => v ?? false),
});

export type StructuredIntent = z.infer<typeof structuredIntentSchema>;
export type Subsystems = StructuredIntent['subsystems'];
export type Constraints = StructuredIntent['constraints'];

export const NODE_CATEGORIES = [
  'power', 'control', 'sensing', 'storage', 'connectivity', 'audio', 'ui', 'haptic', 'gauge', 'motor',
] as const;
export type NodeCategory = (typeof NODE_CATEGORIES)[number];

export const EDGE_TYPES = ['power', 'i2c', 'spi', 'uart', 'usb', 'sdmmc', 'gpio', 'signal', 'analog'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const isEdgeType = (value: string): value is EdgeType => (EDGE_TYPES as readonly string[]).includes(value);

export interface DesignNode {
  id: string;
  label: string;
  sublabel: string;
  category: NodeCategory;
  partNumber: string;
  manufacturer?: string;
  rationale?: string;
  voltageV?: number;
  currentMa?: number;
  interfaces?: string[];
  evidenceSources?: Array<{ source: string; docUrl?: string; reason: string }>;
}

export interface DesignEdge {
  from: string;
  to: string;
  label: string;
  type: EdgeType;
  busType?: string;
  dashed?: boolean;
}

export interface PowerRail {
  name: string;
  voltageV: number;
  source: string;
  regulatorPart?: string;
  consumers: string[];
}

export interface BomItem {
  partNumber: string;
  manufacturer: string;
  category: string;
  description: string;
  qty: number;
  unitCostUsd?: number;
  datasheetUrl?: string;
}

export interface CanonicalDesignGraph {
  projectMeta: {
    name: string;
    tagline: string;
    controller: string;
  };
  controller: {
    partNumber: string;
    manufacturer: string;
    rationale: string;
  };
  nodes: DesignNode[];
  edges: DesignEdge[];
  powerRails: PowerRail[];
  bom: BomItem[];
  engineeringDecisions?: string[];
  /** Short, chip-friendly next-refinement suggestions (e.g. "Add battery backup") grounded in
   *  what this specific design is missing — not the generic examples in CLAUDE.md's UI spec. */
  suggestedRefinements?: string[];
}

export interface DiagramNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sublabel: string;
  category: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label: string;
  type: string;
  dashed?: boolean;
}

export interface DiagramLegend {
  color: string;
  label: string;
}

export interface ProjectedDiagram {
  title: string;
  figure: string;
  caption: string;
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  legend: DiagramLegend[];
}

export interface ArchitectureMetricsSummary {
  mcu: string;
  powerInput: string;
  outputs: string;
  interfaces: string;
  inputs: string;
  estimatedBomCostUsd: number;
}

export interface ValidationSummary {
  isValid: boolean;
  errorCount: number;
  warningCount: number;
  issues: Array<{ severity: 'error' | 'warning'; code: string; message: string; nodeId?: string }>;
}

export interface ProjectedArchitecture {
  projectMeta: {
    name: string;
    tagline: string;
    controller: string;
  };
  versionTag?: string;
  /** Electrical/topology validation outcome for this snapshot (Case C). */
  validation?: ValidationSummary;
  summary: ArchitectureMetricsSummary;
  refineSuggestions?: string[];
  functionalBlock: ProjectedDiagram;
  powerTree: ProjectedDiagram;
  protocolMap: ProjectedDiagram;
  bom: BomItem[];
}

