import { z } from 'zod';

/**
 * Prototype Hardware Database v3.3 record — the parts the runtime reads.
 *
 * Every block is `.passthrough()`: the stored metadata_json keeps the whole document, and fields
 * this slice does not use (physical, family_revision details, admin notes, …) are carried along
 * untouched. Fields the allocator depends on (pins, connectors, contacts) are required; everything
 * else defaults so a record with an unresolved field still imports and is flagged instead.
 *
 * Controlled vocabularies mirror validate.py (plan Appendix B).
 */

export const REVIEW_STATUSES = ['provisional', 'confirmed', 'rejected'] as const;
export const LIFECYCLE_STATUSES = ['active', 'nrnd', 'discontinued', 'unknown'] as const;
export const SCOPES = ['shared_library', 'private_project'] as const;
export const VERIFICATION_METHODS = ['vendor_live', 'manual_verified', 'verified_third_party', 'generic_reference', 'inferred'] as const;
export const RECORD_ORIGINS = [
  'embedo_curated',
  'vendor_agent',
  'admin_created',
  'user_created',
  'community_submitted',
  'generic_reference',
] as const;
export const ASSET_READINESS = ['catalog_only', 'metadata_ready', 'visual_ready', 'wiring_ready', 'needs_review', 'failed'] as const;
export const SIGNAL_CLASSES = ['power', 'ground', 'data', 'control', 'debug', 'analog', 'other'] as const;
export const DIRECTIONS = ['input', 'output', 'bidirectional', 'power_in', 'power_out', 'ground'] as const;
export const CONNECTION_MODES = ['whole_connector', 'individual_contacts', 'both'] as const;
export const SOURCE_TYPES = ['product_page', 'schematic', 'guide', 'datasheet', 'user_upload', 'admin_reference'] as const;
export const HOST_REQUIREMENTS = ['standalone', 'host_required', 'optional_host'] as const;
export const FUNCTIONAL_CATEGORIES = [
  'Processing',
  'Power',
  'Sensing',
  'Connectivity',
  'Storage',
  'Interface',
  'Display/UI',
  'Motor/Actuation',
  'Debug/Programming',
] as const;
export const SVG_EDGES = ['top', 'bottom', 'left', 'right'] as const;

export type AssetReadiness = (typeof ASSET_READINESS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type PinDirection = (typeof DIRECTIONS)[number];
export type SvgEdge = (typeof SVG_EDGES)[number];

const nullableString = z.string().nullable().optional();
const nullableNumber = z.number().nullable().optional();

const identitySchema = z
  .object({
    hardware_entity_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, 'hardware_entity_id must be a short id such as HW-0001'),
    product_family_id: z.string().min(1).max(120),
    product_name: z.string().min(1),
    vendor: z.string().min(1).max(120),
    vendor_sku: nullableString,
    group: z.string().max(60).default('Uncategorized'),
    functional_categories: z.array(z.enum(FUNCTIONAL_CATEGORIES)).default([]),
    prototype_role: nullableString,
    main_silicon: nullableString,
    secondary_ics: z.array(z.string()).default([]),
  })
  .passthrough();

const statusGovernanceSchema = z
  .object({
    review_status: z.enum(REVIEW_STATUSES).default('provisional'),
    lifecycle_status: z.enum(LIFECYCLE_STATUSES).default('unknown'),
    scope: z.enum(SCOPES).default('shared_library'),
    verification_method: z.enum(VERIFICATION_METHODS).default('inferred'),
    record_origin: z.enum(RECORD_ORIGINS).default('embedo_curated'),
    asset_readiness: z.enum(ASSET_READINESS).default('catalog_only'),
    metadata_schema_version: z.string().max(10).optional(),
    created_by: nullableString,
  })
  .passthrough();

const sourceSchema = z
  .object({
    source_type: z.enum(SOURCE_TYPES),
    url: nullableString,
    official: z.boolean().default(false),
    verified_at: nullableString,
    content_fingerprint: nullableString,
  })
  .passthrough();

/** §8.5 wants structured rails; the seed records sometimes carry a plain string ("3.0-5.0 V on VIN"). */
const powerRailSchema = z.union([
  z
    .object({
      rail_name: z.string(),
      voltage_min_v: nullableNumber,
      voltage_max_v: nullableNumber,
    })
    .passthrough(),
  z.string(),
]);

const electricalSchema = z
  .object({
    supply_voltage_min_v: nullableNumber,
    supply_voltage_max_v: nullableNumber,
    logic_level_summary: nullableString,
    power_source_types: z.array(z.string()).default([]),
    required_power_rails: z.array(powerRailSchema).default([]),
  })
  .passthrough();

const interfaceSchema = z
  .object({
    type: z.string().min(1),
    addresses: z.array(z.string()).default([]),
    details: z.record(z.unknown()).default({}),
  })
  .passthrough();

const interfacesBlockSchema = z
  .object({
    host_requirement: z.enum(HOST_REQUIREMENTS).default('host_required'),
    required_host_interfaces: z.array(z.string()).default([]),
    interfaces: z.array(interfaceSchema).default([]),
  })
  .passthrough();

const pinSchema = z
  .object({
    pin_id: z.string().min(1),
    pin_name: z.string().min(1),
    signal_class: z.enum(SIGNAL_CLASSES),
    voltage_domain: nullableString,
    direction: z.enum(DIRECTIONS),
    functions: z.array(z.string()).default([]),
  })
  .passthrough();

const contactSchema = z
  .object({
    contact_id: z.string().min(1),
    pin_id: z.string().min(1),
    svg_anchor_id: nullableString,
  })
  .passthrough();

const connectorSchema = z
  .object({
    connector_id: z.string().min(1),
    connector_type: z.string().min(1),
    connection_mode: z.enum(CONNECTION_MODES),
    position: z
      .object({ svg_edge: z.enum(SVG_EDGES).optional() })
      .passthrough()
      .default({}),
    /** Anchor for a whole-connector (cable) connection. Also read from the SVG when absent. */
    svg_anchor_id: nullableString,
    whole_connector_svg_anchor_id: nullableString,
    contacts: z.array(contactSchema).default([]),
  })
  .passthrough();

const dependenciesSchema = z
  .object({
    required_accessories: z.array(z.union([z.string(), z.record(z.unknown())])).default([]),
    related_modules: z.array(z.unknown()).default([]),
  })
  .passthrough();

const compatibilityHintsSchema = z
  .object({
    ecosystem_tags: z.array(z.string()).default([]),
    known_incompatible_notes: z.array(z.string()).default([]),
  })
  .passthrough();

export const hardwareRecordSchema = z
  .object({
    metadata_schema_version: z.string().max(10).optional(),
    identity: identitySchema,
    status_governance: statusGovernanceSchema.default({}),
    family_revision: z
      .object({ hardware_revision: nullableString })
      .passthrough()
      .default({}),
    provenance: z
      .object({ sources: z.array(sourceSchema).default([]), license_note: nullableString })
      .passthrough()
      .default({}),
    electrical: electricalSchema.default({}),
    interfaces: interfacesBlockSchema.default({}),
    pins: z.array(pinSchema).min(1, 'a record needs at least one pin'),
    connectors: z.array(connectorSchema).min(1, 'a record needs at least one connector'),
    physical: z.record(z.unknown()).default({}),
    dependencies: dependenciesSchema.default({}),
    compatibility_hints: compatibilityHintsSchema.default({}),
  })
  .passthrough();

export type HardwareRecord = z.infer<typeof hardwareRecordSchema>;
export type HardwarePin = HardwareRecord['pins'][number];
export type HardwareConnector = HardwareRecord['connectors'][number];
export type HardwareContact = HardwareConnector['contacts'][number];
export type HardwareInterface = HardwareRecord['interfaces']['interfaces'][number];

/** `<HW>.asset.json` beside each record (plan C2). */
export const svgAssetFileSchema = z
  .object({
    hardware_entity_id: z.string(),
    file_name: z.string(),
    storage_path: z.string(),
    build_status: z.string().default('complete'),
    validation_status: z.string().default('not_run'),
    anchor_ids: z.array(z.string()).default([]),
    generation_source_hash: z.string(),
    generated_at: nullableString,
    approved_by: nullableString,
    approved_at: nullableString,
    artwork_original: z.boolean().default(true),
  })
  .passthrough();

export type SvgAssetFile = z.infer<typeof svgAssetFileSchema>;

/** A board is a controller when the library says it runs standalone as the main processor (plan C4). */
export const isControllerRecord = (record: HardwareRecord): boolean =>
  record.interfaces.host_requirement === 'standalone' &&
  (record.identity.functional_categories.includes('Processing') || /main controller/i.test(record.identity.prototype_role ?? ''));

/** Whole-connector anchor id for a connector, from the record. The SVG is the fallback (svg.ts). */
export const wholeConnectorAnchorId = (connector: HardwareConnector): string | null =>
  connector.whole_connector_svg_anchor_id ?? connector.svg_anchor_id ?? null;
