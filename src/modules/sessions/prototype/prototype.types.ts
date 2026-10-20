/**
 * Prototype mode payload: the `architecture` of a session whose type is "prototype".
 * Persisted on design_sessions.architecture, snapshotted per version, and sent with `done`.
 *
 * Three user-facing sections, each self-contained so the frontend can render it directly:
 *  - moduleDiagram    absolute geometry for the bench: module placements, wires, cables, labels, gaps
 *  - pinList          one row per wireable contact of every placed module, wired or not
 *  - hardwareLibrary  the library record summary of every board used, with readiness and sources
 * plus the underlying instances / nets / connections / gaps / compatibility they are built from.
 *
 * SVG artwork is never inlined: modules carry a URL + hash (the JSON body limit is 1 MB).
 */

export const PROTOTYPE_SCHEMA_VERSION = '1.0';

/** CAN and RS485 are field buses: a transceiver links them to the controller, devices share the pair. */
export const LINK_INTERFACES = ['I2C', 'SPI', 'UART', 'GPIO', 'ANALOG', 'PWM', 'CAN', 'RS485'] as const;
export type LinkInterface = (typeof LINK_INTERFACES)[number];

/** "load": a motor's or pump's terminals on its driver or relay (carries load current, not logic). */
export type NetClass = 'power' | 'ground' | 'i2c' | 'spi' | 'uart' | 'can' | 'rs485' | 'gpio' | 'analog' | 'pwm' | 'load';
export type RuleStatus = 'PASS' | 'WARNING' | 'BLOCKER' | 'UNKNOWN';
/** drawn = shown as a wire; proposed = mapping shown but a board awaits wiring review; blocked = a rule failed. */
export type ConnectionState = 'drawn' | 'proposed' | 'blocked';
export type PinRowStatus = 'assigned' | 'proposed' | 'warning' | 'conflict' | 'unknown' | 'blocking' | 'optional';

export interface PrototypeSvgRef {
  url: string;
  hash: string;
  width: number;
  height: number;
}

export interface PrototypeInstance {
  instanceId: string;
  hardwareEntityId: string;
  label: string;
  role: string | null;
  isController: boolean;
  reviewStatus: string;
  assetReadiness: string;
  scope: string;
  svg: PrototypeSvgRef | null;
  /**
   * Set when the block stands in for a module the library does not have (a gap): generic pins on
   * the right bus, so the protocol design is complete, but no real part. Since 2026-10-16.
   */
  placeholder?: { kind: string; gapId: string; need: string; suggestion: string } | null;
}

export interface NetMember {
  instanceId: string;
  pinId: string;
  pinName: string;
  contactId: string | null;
  anchorId: string | null;
}

export interface PrototypeNet {
  netId: string;
  name: string;
  class: NetClass;
  members: NetMember[];
}

export interface ConnectionEndpoint {
  instanceId: string;
  anchorId: string;
  contactId: string | null;
  connectorId: string | null;
}

export interface PrototypeConnection {
  id: string;
  kind: 'wire' | 'cable';
  /** e.g. "stemma_qt_qwiic" for a cable. */
  cableType: string | null;
  netIds: string[];
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  state: ConnectionState;
}

export interface PrototypeGap {
  gapId: string;
  category: string;
  need: string;
  suggestion: string;
  /** How the missing module would connect (resolver's answer, else read from the text). */
  interface?: string | null;
  /** The placeholder block drawn for this gap, when one is. */
  instanceId?: string | null;
}

export interface CompatibilityResult {
  ruleType: string;
  status: RuleStatus;
  message: string;
  suggestedFix: string | null;
  instanceIds: string[];
  pinIds: string[];
}

export type Point = [number, number];

export interface DiagramModule {
  instanceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  /** e.g. "PROVISIONAL", "AWAITING WIRING REVIEW", "NO ARTWORK" — null when nothing to flag. */
  badge: string | null;
  /** The board itself inside the artwork (artwork minus its empty margin). Layout v2+. */
  content?: { x: number; y: number; width: number; height: number };
}

export interface DiagramWire {
  connectionId: string;
  kind: 'wire' | 'cable';
  netIds: string[];
  netClass: NetClass | 'cable';
  color: string;
  strokeWidth: number;
  /** Dashed = not asserted (awaiting review, or a rule is unresolved). */
  dashed: boolean;
  /** A check BLOCKS this connection: drawn so the canvas matches the graph, styled "do not wire". */
  blocked?: boolean;
  points: Point[];
  /** The backbone track this connection runs along. Layout v2+. */
  busId?: string;
}

/** One horizontal backbone track (a net, or one STEMMA QT cable) with its pill label. Layout v2+. */
export interface DiagramBus {
  busId: string;
  netId: string | null;
  kind: 'net' | 'cable';
  netClass: NetClass | 'cable';
  label: string;
  color: string;
  y: number;
  x1: number;
  x2: number;
  labelX: number;
  labelWidth: number;
  /** Every connection on the track is unverified. */
  dashed: boolean;
  /** Every connection on the track is blocked by a check. */
  blocked?: boolean;
  /** More than two boards tap it. */
  shared: boolean;
  /** One per board anchor on the track: the leg from the anchor down/up to the junction at (x, y). */
  taps: Array<{ x: number; instanceId: string; anchorId: string; points: Point[]; dashed: boolean; blocked?: boolean; /** Anchor is a pad (light it in the net colour). */ pad?: boolean }>;
}

export interface ModuleDiagram {
  /** Absent on v1 payloads (lane layout, vertical labels); 2 = bus backbone; 3 = backbone that wraps into stacked bands; 4 = bands joined by risers. */
  layoutVersion?: number;
  /** Layout v3: number of stacked bands. A net spanning bands has one track per band, same name and colour. */
  bands?: number;
  width: number;
  height: number;
  modules: DiagramModule[];
  wires: DiagramWire[];
  buses?: DiagramBus[];
  junctions: Array<{ x: number; y: number; netId: string | null; color: string }>;
  labels: Array<{ text: string; x: number; y: number; netId: string | null; color: string }>;
  gapBoxes: Array<{ gapId: string; x: number; y: number; width: number; height: number; title: string; subtitle: string }>;
  legend: Array<{ netClass: NetClass | 'cable'; label: string; color: string }>;
  legendCard?: {
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    caption: string;
    rows: Array<{ label: string; color: string; detail: string; dashed: boolean; blocked?: boolean; netId: string | null }>;
    /** Explain dashed lines (some wiring is proposed, not verified). */
    dashedNote: boolean;
    /** Explain blocked lines (a check says do not wire them). */
    blockedNote?: boolean;
  } | null;
  header: {
    title: string;
    summary: string;
    subtitle?: string;
    project?: string | null;
    box?: { x: number; y: number; width: number; height: number };
  };
}

export interface PinListRow {
  instanceId: string;
  component: string;
  hardwareEntityId: string;
  pinId: string;
  pin: string;
  contactId: string;
  /** "JP1:12" or "CONN1 (STEMMA QT)". */
  contact: string;
  /** Controller pin(s) on the same net, the net name for controller rows, or the cable route. */
  boardPin: string | null;
  netId: string | null;
  net: string | null;
  /** Interface role: "I2C SDA", "SPI CS", "UART TX", "GPIO", "POWER", "GROUND", "ANALOG". */
  function: string;
  functions: string[];
  direction: string;
  level: string | null;
  status: PinRowStatus;
  note: string | null;
}

export interface PinList {
  summary: {
    /** Non-controller boards with no connected contact (on the bench, wired to nothing). Since 2026-10-15. */
    unwiredModules?: Array<{ instanceId: string; label: string }>;
    rows: number;
    assigned: number;
    proposed: number;
    blocking: number;
    conflict: number;
    warning: number;
    unknown: number;
    optional: number;
  };
  rows: PinListRow[];
}

export interface HardwareLibraryEntry {
  hardwareEntityId: string;
  productFamilyId: string;
  productName: string;
  vendor: string;
  vendorSku: string | null;
  group: string;
  functionalCategories: string[];
  prototypeRole: string | null;
  mainSilicon: string | null;
  secondaryIcs: string[];
  isController: boolean;
  instanceIds: string[];
  governance: {
    reviewStatus: string;
    assetReadiness: string;
    verificationMethod: string;
    recordOrigin: string;
    lifecycleStatus: string;
    scope: string;
  };
  electrical: {
    supplyVoltageMinV: number | null;
    supplyVoltageMaxV: number | null;
    logicLevel: string | null;
    powerSourceTypes: string[];
  };
  interfaces: Array<{ type: string; addresses: string[]; role: string | null }>;
  hostRequirement: string;
  ecosystemTags: string[];
  connectors: Array<{ connectorId: string; type: string; mode: string; contacts: number; edge: string | null }>;
  pinCount: number;
  requiredAccessories: string[];
  knownIncompatibleNotes: string[];
  sources: Array<{ sourceType: string; url: string | null; official: boolean }>;
  svg: PrototypeSvgRef | null;
}

export interface PrototypeArchitecture {
  kind: 'prototype';
  schemaVersion: string;
  versionTag?: string;
  understanding: string;
  notes: string;
  stateHash: string;
  /** Mirrors the Architect payload's projectMeta so shared UI (titles, exports) keeps working. */
  projectMeta: { name: string; tagline: string; controller: string };
  instances: PrototypeInstance[];
  nets: PrototypeNet[];
  connections: PrototypeConnection[];
  gaps: PrototypeGap[];
  compatibility: { results: CompatibilityResult[]; counts: Record<RuleStatus, number> };
  moduleDiagram: ModuleDiagram;
  pinList: PinList;
  hardwareLibrary: { entries: HardwareLibraryEntry[] };
}

/** What the resolver chose, stored as the version's designGraph so refinements can build on it. */
export interface PrototypeComposition {
  kind: 'prototype_composition';
  controller: { instanceId: string; hardwareEntityId: string } | null;
  modules: Array<{
    instanceId: string;
    hardwareEntityId: string;
    role: string;
    links: Array<{ interface: LinkInterface; pinName?: string | null; purpose?: string | null }>;
  }>;
  gaps: Array<{ category: string; need: string; suggestion: string; interface?: string | null }>;
}

export const isPrototypeArchitecture = (value: unknown): value is PrototypeArchitecture =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'prototype';

export const isPrototypeComposition = (value: unknown): value is PrototypeComposition =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'prototype_composition';
