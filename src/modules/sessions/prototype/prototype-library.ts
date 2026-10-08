import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { isStemmaConnector } from './prototype-board.js';
import { HardwareLibraryEntry, PrototypeInstance, PrototypeSvgRef } from './prototype.types.js';

/**
 * The hardware library section: the library record summary of every board used in the module
 * diagram, once per board (two BME280s are one entry with two instanceIds). Governance is shown
 * as stored — a provisional board is labelled provisional, never upgraded for display.
 */

const accessoryName = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? String((value as Record<string, unknown>)['name'] ?? (value as Record<string, unknown>)['accessory'] ?? JSON.stringify(value))
      : String(value);

export function buildHardwareLibrary(
  instances: PrototypeInstance[],
  entities: Map<string, LibraryEntity>,
  svgRef: (entity: LibraryEntity) => PrototypeSvgRef | null
): { entries: HardwareLibraryEntry[] } {
  const order: string[] = [];
  const byEntity = new Map<string, string[]>();
  for (const instance of instances) {
    if (!byEntity.has(instance.hardwareEntityId)) order.push(instance.hardwareEntityId);
    byEntity.set(instance.hardwareEntityId, [...(byEntity.get(instance.hardwareEntityId) ?? []), instance.instanceId]);
  }

  const entries = order.flatMap((id): HardwareLibraryEntry[] => {
    const entity = entities.get(id);
    if (!entity) return [];
    const { identity, electrical, interfaces, connectors, dependencies, compatibility_hints } = entity.record;
    const ecosystem = new Set(compatibility_hints.ecosystem_tags);
    if (connectors.some(isStemmaConnector) && ![...ecosystem].some((t) => /stemma|qwiic/i.test(t))) ecosystem.add('STEMMA QT / Qwiic');
    return [
      {
        hardwareEntityId: id,
        productFamilyId: entity.productFamilyId,
        productName: identity.product_name,
        vendor: identity.vendor,
        vendorSku: identity.vendor_sku ?? null,
        group: identity.group,
        functionalCategories: identity.functional_categories,
        prototypeRole: identity.prototype_role ?? null,
        mainSilicon: identity.main_silicon ?? null,
        secondaryIcs: identity.secondary_ics,
        isController: entity.isController,
        instanceIds: byEntity.get(id) ?? [],
        governance: {
          reviewStatus: entity.reviewStatus,
          assetReadiness: entity.assetReadiness,
          verificationMethod: entity.verificationMethod,
          recordOrigin: entity.recordOrigin,
          lifecycleStatus: entity.lifecycleStatus,
          scope: entity.scope,
        },
        electrical: {
          supplyVoltageMinV: electrical.supply_voltage_min_v ?? null,
          supplyVoltageMaxV: electrical.supply_voltage_max_v ?? null,
          logicLevel: electrical.logic_level_summary ?? null,
          powerSourceTypes: electrical.power_source_types,
        },
        interfaces: interfaces.interfaces.map((i) => ({
          type: i.type,
          addresses: i.addresses,
          role: typeof (i.details as Record<string, unknown>)['role'] === 'string' ? ((i.details as Record<string, unknown>)['role'] as string) : null,
        })),
        hostRequirement: interfaces.host_requirement,
        ecosystemTags: [...ecosystem],
        connectors: connectors.map((c) => ({
          connectorId: c.connector_id,
          type: c.connector_type,
          mode: c.connection_mode,
          contacts: c.contacts.length,
          edge: c.position.svg_edge ?? null,
        })),
        pinCount: entity.record.pins.length,
        requiredAccessories: dependencies.required_accessories.map(accessoryName),
        knownIncompatibleNotes: compatibility_hints.known_incompatible_notes,
        sources: entity.sources,
        svg: svgRef(entity),
      },
    ];
  });

  return { entries };
}
