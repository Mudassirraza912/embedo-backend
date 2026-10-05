import { CanonicalDesignGraph, DesignEdge, DesignNode, EdgeType, isEdgeType } from './types.js';
import { logger } from '../../../config/logger.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationReport {
  isValid: boolean;
  issues: ValidationIssue[];
  repairedGraph: CanonicalDesignGraph;
}

/** Common MCU / wireless-SoC families, matched against a node's part number. */
const MCU_PART_PATTERN =
  /^(stm32|stm8|esp32|esp8266|nrf5|nrf9|rp2040|rp2350|atmega|attiny|atsam|samd|same|saml|pic1|pic2|pic3|dspic|msp430|msp432|efr32|efm32|cc13|cc26|cc32|gd32|ch32|ra[24]|rx\d|lpc\d|mk\d|mimxrt|imxrt|tms320|xmc|psoc|cy8c|max32|apollo|bl60|bl70|w600|rtl87|bk72|ln88|mspm0|stm32wb|stm32wl)/i;

/** Map a declared interface name onto the closed edge-type union used by the frontend contract. */
const interfaceToEdgeType = (iface: string | undefined): EdgeType => {
  if (!iface) return 'gpio';
  const v = iface.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (isEdgeType(v)) return v;
  if (v.includes('i2c') || v === 'twi' || v === 'smbus') return 'i2c';
  if (v.includes('spi') || v === 'qspi') return 'spi';
  if (v.includes('uart') || v.includes('usart') || v.includes('serial') || v.includes('rs232') || v.includes('rs485')) return 'uart';
  if (v.includes('usb')) return 'usb';
  if (v.includes('sdmmc') || v.includes('sdio') || v.includes('emmc')) return 'sdmmc';
  if (v.includes('i2s') || v.includes('pdm') || v.includes('can') || v.includes('eth') || v.includes('pwm')) return 'signal';
  if (v.includes('adc') || v.includes('dac') || v.includes('analog')) return 'analog';
  if (v.includes('vbus') || v.includes('vsys') || v.includes('rail') || v.includes('power')) return 'power';
  return 'gpio';
};

/**
 * Case C: Hardware Electrical & Topology Validator.
 * Pure function — the input graph is never mutated; a deep-copied repaired graph is returned.
 */
export function validateAndRepairDesignGraph(input: CanonicalDesignGraph): ValidationReport {
  const graph: CanonicalDesignGraph = structuredClone(input);
  const issues: ValidationIssue[] = [];

  const nodeMap = new Map<string, DesignNode>();
  for (const node of graph.nodes) nodeMap.set(node.id, node);

  // 1. Edge reference integrity
  const validEdges: DesignEdge[] = graph.edges.filter((edge) => {
    const fromExists = nodeMap.has(edge.from);
    const toExists = nodeMap.has(edge.to);
    if (!fromExists || !toExists) {
      issues.push({
        severity: 'warning',
        code: 'INVALID_EDGE_ENDPOINT',
        message: `Dropped edge referencing unknown node: '${edge.from}' -> '${edge.to}'`,
      });
      return false;
    }
    if (!isEdgeType(edge.type)) {
      const coerced = interfaceToEdgeType(edge.type);
      issues.push({
        severity: 'warning',
        code: 'EDGE_TYPE_COERCED',
        message: `Edge '${edge.from}' -> '${edge.to}' had unknown type '${String(edge.type)}', coerced to '${coerced}'`,
      });
      edge.type = coerced;
    }
    return true;
  });

  // 2. Controller presence — a real requirement, not a heuristic; without it the projection is meaningless.
  let mcuNode = graph.nodes.find((n) => n.category === 'control');
  if (!mcuNode) {
    // The graph always names its controller separately (graph.controller.partNumber). When the model
    // files that same node under another category — typically "connectivity" for a wireless SoC such
    // as an ESP32 — the controller is still unambiguous, so repair the category instead of rejecting
    // an otherwise-valid design (seen live: three consecutive refinement attempts on a Wi-Fi socket
    // design failed with NO_CONTROLLER_NODE and the change was never applied).
    const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const declared = norm(graph.controller?.partNumber);
    // A "motor controller" or "motor driver" is NOT the MCU — exactly the confusion that broke an
    // industrial motor-controller design three times in production.
    const isDriverLike = (n: DesignNode) => /\b(motor|driver|gate|h[-\s]?bridge|esc|power)\b/i.test(`${n.id} ${n.label}`);
    const candidate =
      // 1. the declared controller's part number
      (declared
        ? graph.nodes.find((n) => {
            const pn = norm(n.partNumber);
            return pn.length > 0 && (pn === declared || pn.includes(declared) || declared.includes(pn));
          })
        : undefined) ??
      // 2. a recognised MCU/SoC family by part number
      graph.nodes.find((n) => MCU_PART_PATTERN.test(n.partNumber ?? '')) ??
      // 3. a node that is plainly named as the MCU
      graph.nodes.find(
        (n) =>
          !isDriverLike(n) &&
          (['mcu', 'controller', 'soc', 'cpu', 'processor', 'microcontroller'].includes(n.id.toLowerCase()) ||
            /\b(mcu|microcontroller|micro-controller|soc|processor)\b/i.test(n.label))
      );
    if (candidate) {
      issues.push({
        severity: 'warning',
        code: 'CONTROLLER_CATEGORY_REPAIRED',
        message: `Node '${candidate.id}' is the declared controller but was categorised '${candidate.category}'; set to 'control'.`,
        nodeId: candidate.id,
      });
      candidate.category = 'control';
      mcuNode = candidate;
    }
  }
  if (!mcuNode && graph.controller?.partNumber) {
    // Last resort: the graph declares its controller but never drew it as a node. Add it rather
    // than throwing the whole design away (each NO_CONTROLLER_NODE retry re-runs the full Sol call).
    const added: DesignNode = {
      id: graph.nodes.some((n) => n.id === 'mcu') ? 'mcu_main' : 'mcu',
      label: 'Microcontroller',
      sublabel: graph.controller.partNumber,
      category: 'control',
      partNumber: graph.controller.partNumber,
      ...(graph.controller.manufacturer ? { manufacturer: graph.controller.manufacturer } : {}),
      ...(graph.controller.rationale ? { rationale: graph.controller.rationale } : {}),
    };
    graph.nodes.push(added);
    nodeMap.set(added.id, added);
    mcuNode = added;
    issues.push({
      severity: 'warning',
      code: 'CONTROLLER_NODE_ADDED',
      message: `The declared controller ${graph.controller.partNumber} was missing from the graph and was added as node '${added.id}'.`,
      nodeId: added.id,
    });
  }
  if (!mcuNode) {
    issues.push({
      severity: 'error',
      code: 'NO_CONTROLLER_NODE',
      message: 'Design graph lacks a primary control/MCU node.',
    });
  }

  // 3. Power continuity
  const poweredNodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (
      node.category === 'power' ||
      node.id.includes('usb') ||
      node.id.includes('bat') ||
      node.id.includes('regulator') ||
      node.id.includes('charger')
    ) {
      poweredNodeIds.add(node.id);
    }
  }
  for (const edge of validEdges) {
    const label = edge.label.toLowerCase();
    if (edge.type === 'power' || label.includes('3.3v') || label.includes('5v') || label.includes('vsys')) {
      poweredNodeIds.add(edge.to);
    }
  }
  for (const rail of graph.powerRails || []) {
    for (const consumer of rail.consumers) poweredNodeIds.add(consumer);
  }

  if (graph.powerRails.length === 0 && graph.nodes.some((n) => n.category !== 'power')) {
    issues.push({
      severity: 'error',
      code: 'NO_POWER_RAILS',
      message: 'Design graph declares no power rails; cannot verify that peripherals are powered.',
    });
  }

  for (const node of graph.nodes) {
    if (!poweredNodeIds.has(node.id) && node.category !== 'power') {
      issues.push({
        severity: 'warning',
        code: 'UNPOWERED_NODE',
        message: `Node '${node.label}' (${node.id}) has no explicit power feed. Auto-connecting to primary 3.3V rail.`,
        nodeId: node.id,
      });
      if (graph.powerRails.length > 0) {
        const defaultRail = graph.powerRails.find((r) => r.voltageV === 3.3) || graph.powerRails[0];
        if (defaultRail && !defaultRail.consumers.includes(node.id)) {
          defaultRail.consumers.push(node.id);
        }
      }
    }
  }

  // 4. Peripheral connectivity to the controller
  if (mcuNode) {
    for (const node of graph.nodes) {
      if (node.id === mcuNode.id || node.category === 'power') continue;

      const hasConnection = validEdges.some(
        (e) => (e.from === mcuNode.id && e.to === node.id) || (e.from === node.id && e.to === mcuNode.id)
      );
      if (!hasConnection) {
        const edgeType = interfaceToEdgeType(node.interfaces?.[0]);
        issues.push({
          severity: 'warning',
          code: 'DISCONNECTED_PERIPHERAL',
          message: `Peripheral '${node.label}' (${node.id}) is not connected to MCU. Adding default ${edgeType.toUpperCase()} link.`,
          nodeId: node.id,
        });
        validEdges.push({
          from: mcuNode.id,
          to: node.id,
          label: node.interfaces?.[0] || 'GPIO/I2C',
          type: edgeType,
        });
      }
    }
  }

  const repairedGraph: CanonicalDesignGraph = { ...graph, edges: validEdges };
  const hasCriticalErrors = issues.some((i) => i.severity === 'error');

  if (issues.length > 0) {
    logger.info({ issueCount: issues.length, hasCriticalErrors }, 'Design graph validation and repair complete');
  }

  return { isValid: !hasCriticalErrors, issues, repairedGraph };
}
