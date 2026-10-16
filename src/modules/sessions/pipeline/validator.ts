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
  let validEdges: DesignEdge[] = graph.edges.filter((edge) => {
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

  // 5. Power converter & battery voltage compatibility validation
  const isPrimaryBattery = (n: DesignNode) =>
    (/\b(battery|cell|pack)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`) ||
      /\b(aa|aaa|cr2032|cr2025|cr2450|coin|alkaline)\b/i.test(`${n.id} ${n.label}`)) &&
    !/\b(regulator|converter|ldo|buck|boost|switch|supply|smps|terminal|input)\b/i.test(`${n.id} ${n.label}`) &&
    !/\b(lipo|li-po|lithium-ion|li-ion|18650|rechargeable)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`);

  const batteryNode = graph.nodes.find((n) => n.category === 'power' && isPrimaryBattery(n));
  if (batteryNode) {
    // 5a. Check for incompatible buck-only regulators on primary battery supplies
    const BUCK_ONLY_PARTS = /\b(ap63203|lm2596|mp2307|lmr14030|tps54302|aoz1282)/i;
    for (const node of graph.nodes) {
      if (node.category === 'power' && BUCK_ONLY_PARTS.test(node.partNumber ?? '')) {
        const oldPart = node.partNumber;
        node.partNumber = 'TPS63031DSKR';
        node.label = 'TPS63031';
        node.sublabel = 'buck-boost converter';
        node.manufacturer = 'Texas Instruments';
        node.rationale =
          'High efficiency buck-boost converter (1.8V–5.5V input) capable of maintaining 3.3V rail as 2x AA batteries drain to 2.0V';
        issues.push({
          severity: 'warning',
          code: 'REGULATOR_TOPOLOGY_INCOMPATIBLE',
          message: `Buck converter '${oldPart}' requires input >= 3.8V and cannot operate from low-voltage battery '${batteryNode.label}' (1.8V–3.0V). Auto-repaired to TPS63031 buck-boost converter.`,
          nodeId: node.id,
        });

        // Update BOM if present
        for (const item of graph.bom || []) {
          if (BUCK_ONLY_PARTS.test(item.partNumber)) {
            item.partNumber = 'TPS63031DSKR';
            item.manufacturer = 'Texas Instruments';
            item.description = 'Buck-Boost Regulator 3.3V 800mA';
            item.category = 'Power Management';
          }
        }
      }
    }

    // 5b. Safety check: Primary non-rechargeable batteries cannot have a battery charger or USB-C charging path
    const chargerIndex = graph.nodes.findIndex(
      (n) => n.category === 'power' && /\b(charger|pmic|bq25186|mcp73831|tp4056)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`)
    );
    if (chargerIndex !== -1) {
      const charger = graph.nodes[chargerIndex];
      issues.push({
        severity: 'warning',
        code: 'PRIMARY_BATTERY_CHARGER_REMOVED',
        message: `Primary battery '${batteryNode.label}' cannot be recharged. Auto-removed hazardous charger '${charger.label}' and charging path.`,
        nodeId: charger.id,
      });
      // Remove charger from nodes
      graph.nodes.splice(chargerIndex, 1);
      nodeMap.delete(charger.id);

      // Remove charger from BOM
      graph.bom = (graph.bom || []).filter(
        (b) => !/\b(charger|pmic|bq25186|mcp73831|tp4056)\b/i.test(`${b.partNumber} ${b.description}`)
      );

      // Re-route battery to regulator if edge was from charger to regulator
      const regNode = graph.nodes.find((n) => n.category === 'power' && n.id !== batteryNode.id);
      if (regNode) {
        validEdges.push({
          from: batteryNode.id,
          to: regNode.id,
          label: 'VBAT',
          type: 'power',
        });
      }
    }
  }

  // 6. Wireless capability factual verification (LoRaWAN)
  // STM32L072CZ is a standalone MCU without integrated LoRa radio.
  // If the project specifies LoRaWAN, ensure either an integrated LoRa SoC is used or a discrete transceiver (SX1262/RFM95W) is present.
  const isLoraProject =
    /lora/i.test(graph.projectMeta.name) ||
    /lora/i.test(graph.projectMeta.tagline) ||
    graph.nodes.some((n) => /lora/i.test(`${n.label} ${n.sublabel ?? ''} ${n.rationale ?? ''}`));

  if (isLoraProject && mcuNode) {
    const isLoraMcu = /\b(stm32wl|cmwx1|lora-e5|e5)\b/i.test(mcuNode.partNumber ?? '');
    const hasLoraTransceiver = graph.nodes.some(
      (n) => n.id !== mcuNode.id && /\b(sx126|sx127|rfm9|lora)\b/i.test(`${n.partNumber} ${n.label} ${n.sublabel ?? ''}`)
    );

    if (!isLoraMcu && !hasLoraTransceiver) {
      const loraNode: DesignNode = {
        id: 'lora_transceiver',
        label: 'SX1262',
        sublabel: 'LoRaWAN Transceiver',
        category: 'connectivity',
        partNumber: 'SX1262IMLTRT',
        manufacturer: 'Semtech',
        rationale: 'Sub-GHz LoRaWAN transceiver paired with host MCU via SPI and DIO/BUSY GPIOs',
        interfaces: ['SPI', 'GPIO'],
        voltageV: 3.3,
        currentMa: 45,
      };
      graph.nodes.push(loraNode);
      nodeMap.set(loraNode.id, loraNode);

      validEdges.push({
        from: mcuNode.id,
        to: loraNode.id,
        label: 'SPI',
        type: 'spi',
      });

      if (graph.powerRails.length > 0) {
        const rail = graph.powerRails.find((r) => r.voltageV === 3.3) || graph.powerRails[0];
        if (rail && !rail.consumers.includes(loraNode.id)) {
          rail.consumers.push(loraNode.id);
        }
      }

      graph.bom.push({
        partNumber: 'SX1262IMLTRT',
        manufacturer: 'Semtech',
        category: 'Wireless / RF',
        description: 'LoRa Transceiver IC 150MHz - 960MHz',
        qty: 1,
        unitCostUsd: 3.8,
      });

      issues.push({
        severity: 'warning',
        code: 'DISCRETE_LORA_TRANSCEIVER_ADDED',
        message: `Microcontroller '${mcuNode.partNumber}' does not have an integrated LoRa radio. Added discrete Semtech SX1262 LoRaWAN transceiver connected via SPI.`,
        nodeId: loraNode.id,
      });
    }
  }

  // 7. 2-Wire 4-20 mA Loop-Powered Architecture & Power Budget
  // In a 2-wire loop-powered transmitter, all power is derived from the 4-20 mA loop current.
  // By Kirchhoff's Current Law, all internal circuitry MUST consume < 3.5 mA total.
  // High-power isolated DC/DC converters (such as ADuM5000 drawing 20-30 mA) permanently saturate the loop and violate physics.
  const is420LoopProject =
    /(4[-\s]?20\s*ma|current[-\s]?loop|hart)/i.test(
      `${graph.projectMeta.name} ${graph.projectMeta.tagline} ${graph.projectMeta.controller}`
    ) ||
    graph.nodes.some((n) => /(4[-\s]?20\s*ma|xtr11|ad5421|loop)/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`));

  if (is420LoopProject) {
    const is3Or4Wire = /(3[-\s]?wire|4[-\s]?wire|auxiliary\s*power)/i.test(
      `${graph.projectMeta.name} ${graph.projectMeta.tagline} ${(graph.engineeringDecisions ?? []).join(' ')}`
    );

    if (!is3Or4Wire) {
      // 2-Wire Loop: check for incompatible high-power DC/DC converter
      const HIGH_POWER_ISOLATORS = /(adum5000|adum6000|adum5401|adum5240|cre1|recom|dcdc)/i;
      const badIsoNode = graph.nodes.find(
        (n) =>
          HIGH_POWER_ISOLATORS.test(n.partNumber ?? '') ||
          HIGH_POWER_ISOLATORS.test(n.id) ||
          HIGH_POWER_ISOLATORS.test(n.label ?? '') ||
          HIGH_POWER_ISOLATORS.test(n.sublabel ?? '')
      );

      if (badIsoNode) {
        const oldPart = badIsoNode.partNumber || 'ADuM5000';
        badIsoNode.id = 'digital_isolator';
        badIsoNode.label = 'ADuM1441';
        badIsoNode.sublabel = 'Micropower Digital Isolator';
        badIsoNode.partNumber = 'ADuM1441ARSZ';
        badIsoNode.manufacturer = 'Analog Devices';
        badIsoNode.category = 'connectivity';
        badIsoNode.currentMa = 0.015;
        badIsoNode.rationale =
          'Quad-channel micropower digital isolator (4.5 µA/ch at 2 Mbps) replacing high-power DC/DC converter to satisfy 2-wire loop < 3.5 mA power budget.';

        // Ensure loop DAC is an ultra-low-power loop regulator/DAC (e.g. AD5421 or XTR116)
        let loopDacNode = graph.nodes.find((n) => /(ad5421|xtr11|loop[-\s]?dac)/i.test(`${n.id} ${n.partNumber ?? ''}`));
        if (!loopDacNode) {
          const firstPowerOrControl = graph.nodes.find((n) => n.id.includes('dac') || n.id.includes('xtr') || n.id.includes('loop'));
          if (firstPowerOrControl) {
            loopDacNode = firstPowerOrControl;
            loopDacNode.partNumber = 'AD5421BREZ';
            loopDacNode.label = 'AD5421';
            loopDacNode.sublabel = 'Loop DAC & Regulated DC/DC';
            loopDacNode.manufacturer = 'Analog Devices';
            loopDacNode.category = 'power';
            loopDacNode.rationale =
              'Loop-powered 4-20mA DAC with on-chip high-efficiency step-down DC/DC converter (Iq < 250 µA) stepping down 24V loop to 3.3V.';
          }
        }

        // Cap field-side node current draws to sub-milliamp levels
        for (const n of graph.nodes) {
          if (n.category === 'sensing' && (n.currentMa ?? 0) > 2) n.currentMa = 0.25;
          if (n.category === 'control' && (n.currentMa ?? 0) > 2) n.currentMa = 0.35;
          if (n.category === 'connectivity' && n.id.includes('hart') && (n.currentMa ?? 0) > 1) n.currentMa = 0.14;
        }

        // Update BOM
        for (const item of graph.bom || []) {
          if (HIGH_POWER_ISOLATORS.test(item.partNumber) || HIGH_POWER_ISOLATORS.test(item.description)) {
            item.partNumber = 'ADuM1441ARSZ';
            item.manufacturer = 'Analog Devices';
            item.description = 'Quad-Channel Micropower Digital Isolator, 2.5kV RMS';
            item.category = 'Isolation';
          }
        }

        issues.push({
          severity: 'warning',
          code: 'LOOP_POWER_BUDGET_EXCEEDED',
          message: `In a 2-wire loop-powered 4-20mA transmitter, total circuit current must strictly be < 3.5 mA (KCL) to allow 4 mA zero-scale and NAMUR NE43 fault signaling. Replaced high-power isolated DC/DC '${oldPart}' (~20 mA draw) with ADuM1441 micropower digital isolator (< 20 µA) and AD5421 loop-powered buck/DAC.`,
          nodeId: badIsoNode.id,
        });
      }
    }
  }

  // 8. Coin-Cell High Internal Resistance & Pulse Reservoir Capacitor
  // CR2032/CR2025 coin cells have high internal resistance (Ri = 10-100+ Ω).
  // RF load bursts (BLE, LoRa, Zigbee) drawing 10-15 mA cause severe IR drop and brownout reset without a bulk pulse reservoir capacitor.
  const isCoinCell = graph.nodes.some(
    (n) => n.category === 'power' && /\b(cr2032|cr2025|cr2450|coin[-\s]?cell)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`)
  );
  const hasRfLoad =
    graph.nodes.some((n) => /\b(ble|bluetooth|nrf5|esp32|lora|zigbee|wireless|radio)\b/i.test(`${n.partNumber} ${n.label} ${n.sublabel ?? ''} ${n.category}`)) ||
    /ble|beacon|lora|wireless/i.test(`${graph.projectMeta.name} ${graph.projectMeta.tagline}`);

  if (isCoinCell && hasRfLoad) {
    const hasPulseCap = graph.nodes.some(
      (n) => /\b(reservoir|pulse[-\s]?cap|buffer[-\s]?cap|47uf|100uf|bulk[-\s]?cap)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`)
    );
    const hasBOMPulseCap = (graph.bom || []).some((b) => /\b(47\s*uf|100\s*uf|reservoir|pulse)\b/i.test(`${b.description} ${b.partNumber}`));

    if (!hasPulseCap && !hasBOMPulseCap) {
      const pulseCapNode: DesignNode = {
        id: 'pulse_reservoir_cap',
        label: '47µF Pulse Reservoir Cap',
        sublabel: 'Low-Leakage Buffer',
        category: 'power',
        partNumber: 'GRM31CR61A476KE15L',
        manufacturer: 'Murata',
        rationale:
          '47µF low-leakage X5R ceramic capacitor placed directly across CR2032 coin cell to buffer 15mA peak RF transmission bursts without voltage sag across battery internal resistance (Ri = 10-100Ω).',
        voltageV: 3.0,
        currentMa: 0.0001,
      };
      graph.nodes.push(pulseCapNode);
      nodeMap.set(pulseCapNode.id, pulseCapNode);

      const coinBatNode = graph.nodes.find(
        (n) => n.category === 'power' && /\b(cr2032|cr2025|cr2450|coin)\b/i.test(`${n.id} ${n.label}`)
      );
      if (coinBatNode) {
        validEdges.push({
          from: coinBatNode.id,
          to: pulseCapNode.id,
          label: 'VBAT',
          type: 'power',
        });
      }

      graph.bom.push({
        partNumber: 'GRM31CR61A476KE15L',
        manufacturer: 'Murata',
        category: 'Passives',
        description: 'Capacitor Ceramic 47µF 10V X5R 1206 Low-Leakage',
        qty: 1,
        unitCostUsd: 0.35,
      });

      issues.push({
        severity: 'warning',
        code: 'COIN_CELL_PULSE_CAPACITOR_ADDED',
        message: 'CR2032 coin cell has high internal resistance (10–100Ω) which causes brownout reset during 15mA BLE/RF radio transmission bursts. Added 47µF low-leakage pulse reservoir capacitor in parallel with the coin cell.',
        nodeId: pulseCapNode.id,
      });
    }
  }

  // 9. Supercapacitor Sub-Zero ESR Derating & Buffering
  // Supercapacitor ESR surges 3x-5x at sub-zero temperatures (-30°C).
  // High-current pulses (NB-IoT / cellular 300-500 mA) cause premature input rail collapse without low-ESR cold-rating and parallel MLCC buffer.
  const supercapNode = graph.nodes.find(
    (n) => n.category === 'power' && /\b(supercap|supercapacitor|edlc|ultracapacitor)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`)
  );
  const isSubZeroEnv =
    /-([2-6]\d)\s*°?c/i.test(`${graph.projectMeta.name} ${graph.projectMeta.tagline} ${(graph.engineeringDecisions ?? []).join(' ')}`);

  if (supercapNode && isSubZeroEnv) {
    const hasMlccBuffer =
      graph.nodes.some((n) => /\b(mlcc|buffer|100uf|ceramic)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`)) ||
      (graph.bom || []).some((b) => /\b(100\s*uf|mlcc|buffer)\b/i.test(`${b.description} ${b.partNumber}`));

    if (!hasMlccBuffer) {
      const mlccBufferNode: DesignNode = {
        id: 'supercap_mlcc_buffer',
        label: '100µF Low-ESR MLCC Bank',
        sublabel: 'Cold Transient Buffer',
        category: 'power',
        partNumber: 'GRM32ER61C107ME20L',
        manufacturer: 'Murata',
        rationale:
          '100µF low-ESR ceramic MLCC placed in parallel with supercapacitor bank to absorb high di/dt NB-IoT transmit pulses (300-500mA) when supercapacitor ESR increases at -30°C.',
        voltageV: 5.5,
        currentMa: 0.0001,
      };
      graph.nodes.push(mlccBufferNode);
      nodeMap.set(mlccBufferNode.id, mlccBufferNode);

      validEdges.push({
        from: supercapNode.id,
        to: mlccBufferNode.id,
        label: 'V_SUPERCAP',
        type: 'power',
      });

      graph.bom.push({
        partNumber: 'GRM32ER61C107ME20L',
        manufacturer: 'Murata',
        category: 'Passives',
        description: 'Capacitor Ceramic 100µF 16V X5R 1210 Low-ESR',
        qty: 1,
        unitCostUsd: 0.65,
      });

      issues.push({
        severity: 'warning',
        code: 'SUPERCAPACITOR_COLD_ESR_DERATED',
        message: 'Supercapacitor ESR increases 3x–5x at -30°C. Added 100µF low-ESR ceramic MLCC buffer bank to absorb high di/dt NB-IoT transmit pulses without input rail collapse.',
        nodeId: mlccBufferNode.id,
      });
    }
  }

  // 10. Stratospheric & Extreme Cold (<-40°C) Crystal Stall & Silicon Check
  // Standard tuning-fork 32.768 kHz crystals stop oscillating below -40°C due to increased motional resistance.
  // Stratospheric flights (-60°C) require silicon MEMS oscillators or internal calibrated RC and EPS thermal insulation.
  const isExtremeCold =
    /-([5-9]\d)\s*°?c/i.test(`${graph.projectMeta.name} ${graph.projectMeta.tagline} ${(graph.engineeringDecisions ?? []).join(' ')}`);

  if (isExtremeCold) {
    const tuningForkCrystal = graph.nodes.find(
      (n) => /\b(crystal|xtal|32\.768|abs07|ecs|tuning[-\s]?fork)\b/i.test(`${n.id} ${n.partNumber ?? ''} ${n.label}`)
    );
    if (tuningForkCrystal) {
      tuningForkCrystal.partNumber = 'SiT1532AI-J4-DCC-32.768E';
      tuningForkCrystal.label = 'SiT1532';
      tuningForkCrystal.sublabel = 'MEMS Oscillator (-55°C to +85°C)';
      tuningForkCrystal.manufacturer = 'SiTime';
      tuningForkCrystal.rationale =
        'Ultra-low power 32.768 kHz silicon MEMS oscillator operating down to -55°C without crystal oscillator stall common to quartz tuning-fork crystals at -60°C.';

      for (const item of graph.bom || []) {
        if (/\b(crystal|xtal|32\.768|abs07)\b/i.test(`${item.partNumber} ${item.description}`)) {
          item.partNumber = 'SiT1532AI-J4-DCC-32.768E';
          item.manufacturer = 'SiTime';
          item.description = 'MEMS Oscillator 32.768kHz 1.2V-3.63V Extended Temp';
        }
      }

      issues.push({
        severity: 'warning',
        code: 'EXTREME_COLD_TEMPERATURE_DERATED',
        message: 'At stratospheric temperatures down to -60°C, standard quartz tuning-fork crystals stall. Auto-repaired to SiTime SiT1532 silicon MEMS oscillator rated for extreme low temperatures.',
        nodeId: tuningForkCrystal.id,
      });
    }
  }

  // 11. Automotive 12V Load Dump & Buck Converter Voltage Rating
  // Automotive 12V vehicle rails experience severe load dump transients (ISO 7637-2 / ISO 16750-2 Pulse 5a/5b: 35V-40V clamped by TVS, up to 87V+ unsuppressed).
  // A buck regulator rated for <= 28V (TPS54202, TPS54331, AP63203, MP2307, LM2596) will break down and destroy downstream circuitry.
  // Automotive front-ends require at least 40V–60V input rating (e.g. LMR14030-Q1 40V, LMR16030-Q1 60V, TPS54340-Q1 42V).
  const isAutomotive =
    /\b(automotive|vehicle|car|truck|12v\s*battery|iso[-\s]?7637|iso[-\s]?16750|obd|telematics)\b/i.test(
      `${graph.projectMeta.name} ${graph.projectMeta.tagline} ${(graph.engineeringDecisions ?? []).join(' ')}`
    ) ||
    graph.nodes.some((n) => n.category === 'power' && /\b(12v|automotive|vehicle|car)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`));

  if (isAutomotive) {
    const LOW_VOLTAGE_BUCKS = /(tps54202|tps54331|tps54302|ap63203|mp2307|lm2596)/i;
    const lowVoltageBuckNode = graph.nodes.find(
      (n) => n.category === 'power' && (LOW_VOLTAGE_BUCKS.test(n.partNumber ?? '') || LOW_VOLTAGE_BUCKS.test(n.label))
    );

    if (lowVoltageBuckNode) {
      const oldPart = lowVoltageBuckNode.partNumber || lowVoltageBuckNode.label;
      lowVoltageBuckNode.partNumber = 'LMR14030SDDA';
      lowVoltageBuckNode.label = 'LMR14030-Q1';
      lowVoltageBuckNode.sublabel = '40V 3.5A Automotive Buck';
      lowVoltageBuckNode.manufacturer = 'Texas Instruments';
      lowVoltageBuckNode.rationale =
        'AEC-Q100 automotive-qualified step-down converter with 40V continuous (45V transient) input range and 3.5A capability, withstanding ISO 7637-2 / ISO 16750-2 load dump surges without overvoltage failure.';

      for (const item of graph.bom || []) {
        if (LOW_VOLTAGE_BUCKS.test(item.partNumber) || LOW_VOLTAGE_BUCKS.test(item.description)) {
          item.partNumber = 'LMR14030SDDA';
          item.manufacturer = 'Texas Instruments';
          item.category = 'Power Management';
          item.description = 'Step-Down Converter AEC-Q100 4V-40V In, 3.5A Out, SO PowerPAD-8';
        }
      }

      const hasAutomotiveTvs = (graph.bom || []).some((b) => /\b(smcj36|sm8a|tvs|transient)\b/i.test(`${b.partNumber} ${b.description}`));
      if (!hasAutomotiveTvs) {
        graph.bom.push({
          partNumber: 'SMCJ36CA',
          manufacturer: 'Littelfuse',
          category: 'Circuit Protection',
          description: 'TVS Diode 1500W 36V Bidirectional SMC (ISO 7637-2 / ISO 16750-2 load dump clamp)',
          qty: 1,
          unitCostUsd: 0.45,
        });
      }

      issues.push({
        severity: 'warning',
        code: 'AUTOMOTIVE_BUCK_VOLTAGE_INSUFFICIENT',
        message: `In an automotive 12V vehicle system, ISO 7637-2 / ISO 16750-2 load dump transients surge to 35V–40V (clamped) or 87V+ (unsuppressed). Replaced 28V-rated regulator '${oldPart}' with 40V AEC-Q100 qualified LMR14030-Q1 buck converter to prevent catastrophic overvoltage breakdown.`,
        nodeId: lowVoltageBuckNode.id,
      });
    }
  }

  // 12. Cellular Modem VBAT Supply Rail Protection (3.8V Nominal, 4.5V Absolute Max)
  // Quectel (EC21, EC25, BG95, EG915), SIMCom (SIM7600), Telit (LE910) cellular modems:
  // Operating VBAT: 3.3V - 4.3V (nominal 3.8V). Absolute Maximum Rating: 4.5V!
  // Supplying 5.0V directly to VBAT causes immediate physical overvoltage breakdown of the internal RF PA and baseband.
  const CELLULAR_MODEM_PATTERN = /\b(quectel|ec21|ec25|bg95|bg96|eg915|sim7600|le910|lte[-\s]?cat|cellular[-\s]?modem)\b/i;
  const modemNode = graph.nodes.find(
    (n) => n.category === 'connectivity' && CELLULAR_MODEM_PATTERN.test(`${n.id} ${n.partNumber ?? ''} ${n.label} ${n.sublabel ?? ''}`)
  );

  if (modemNode) {
    const overvoltageRail = graph.powerRails.find(
      (r) => r.consumers.includes(modemNode.id) && (r.voltageV === 5 || r.name.toLowerCase().includes('5v'))
    );

    if (overvoltageRail) {
      overvoltageRail.consumers = overvoltageRail.consumers.filter((id) => id !== modemNode.id);

      let modemRail = graph.powerRails.find((r) => r.voltageV === 3.8 || r.name.toLowerCase().includes('3.8v'));
      if (!modemRail) {
        modemRail = {
          name: '3.8V_MODEM',
          voltageV: 3.8,
          source: 'modem_regulator',
          consumers: [modemNode.id],
        };
        graph.powerRails.push(modemRail);
      } else if (!modemRail.consumers.includes(modemNode.id)) {
        modemRail.consumers.push(modemNode.id);
      }

      modemNode.voltageV = 3.8;
      if (!modemNode.currentMa || modemNode.currentMa < 500) {
        modemNode.currentMa = 500;
      }

      let modemRegNode = graph.nodes.find((n) => n.category === 'power' && /\b(3\.8v|modem[-\s]?reg)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`));
      if (!modemRegNode) {
        modemRegNode = {
          id: 'modem_regulator',
          label: 'TPS54302 (3.8V)',
          sublabel: '3.8V 3A Buck for LTE VBAT',
          category: 'power',
          partNumber: 'TPS54302DDCR',
          manufacturer: 'Texas Instruments',
          voltageV: 3.8,
          rationale:
            'Dedicated 3.8V 3A synchronous step-down regulator supplying Quectel LTE Cat-1 modem VBAT pin (3.3V-4.3V operating range, 3.8V nominal) to prevent catastrophic overvoltage damage from 5V rails and handle 2A transmission burst pulses.',
        };
        graph.nodes.push(modemRegNode);
        nodeMap.set(modemRegNode.id, modemRegNode);

        const srcNode = graph.nodes.find((n) => n.category === 'power' && n.id !== modemRegNode?.id && !n.id.includes('pulse')) || graph.nodes[0];
        if (srcNode) {
          validEdges.push({
            from: srcNode.id,
            to: modemRegNode.id,
            label: 'PWR_IN',
            type: 'power',
          });
        }
        validEdges.push({
          from: modemRegNode.id,
          to: modemNode.id,
          label: 'VBAT_3.8V',
          type: 'power',
        });
      }

      const hasModemBulkCap = (graph.bom || []).some((b) => /\b(470\s*uf|poscap|tantalum)\b/i.test(`${b.description} ${b.partNumber}`));
      if (!hasModemBulkCap) {
        graph.bom.push({
          partNumber: '6TPB470M',
          manufacturer: 'Panasonic',
          category: 'Passives',
          description: 'Capacitor POSCAP Tantalum-Polymer 470µF 6.3V 15mΩ ESR (LTE Modem VBAT Burst Buffer)',
          qty: 1,
          unitCostUsd: 0.95,
        });
      }

      issues.push({
        severity: 'warning',
        code: 'CELLULAR_MODEM_VBAT_OVERVOLTAGE',
        message: `Cellular modem '${modemNode.label}' VBAT pin has an operating range of 3.3V–4.3V (nominal 3.8V) with an absolute maximum rating of 4.5V. Supplying 5.0V directly to VBAT causes catastrophic overvoltage destruction of the RF power amplifier. Re-routed modem VBAT to a dedicated 3.8V / 3A buck regulator with 470µF low-ESR bulk capacitance.`,
        nodeId: modemNode.id,
      });
    }
  }

  // 13. Multi-Channel Isolated RS-485 Power Sizing (2W Minimum for 4 Channels)
  // Standard RS-485 terminated buses (120 Ω at both ends = 54 Ω differential load) draw ~40 mA per active driver + 15 mA logic.
  // Driving 4 concurrent isolated RS-485 channels consumes >220 mA (>1.1W) on the isolated rail.
  // A 1W isolated DC-DC (such as B0505S-1W, 200 mA output) will brown out.
  const rs485TransceiverNodes = graph.nodes.filter(
    (n) =>
      /\b(iso1500|iso1410|adm2483|adm2587|max14853|sn65hvd)\b/i.test(`${n.partNumber ?? ''} ${n.label}`) ||
      (/\b(rs[-\s]?485)\b/i.test(`${n.id} ${n.label}`) && /\b(transceiver|phy|driver)\b/i.test(`${n.label} ${n.sublabel ?? ''}`))
  );
  const is4ChannelRs485 =
    rs485TransceiverNodes.length >= 3 ||
    /\b(4[-\s]?channel|quad|4[-\s]?ch|4\s*buses)\b/i.test(`${graph.projectMeta.name} ${graph.projectMeta.tagline}`);

  if (is4ChannelRs485) {
    const undersizedIsoDcdc = graph.nodes.find(
      (n) => n.category === 'power' && /\b(b0505s-1w|cre1s0505|1w|isolated\s*dc)\b/i.test(`${n.id} ${n.partNumber ?? ''} ${n.label} ${n.sublabel ?? ''}`)
    );

    const bomUndersized = (graph.bom || []).find((b) => /\b(b0505s-1w|1w\s*isolated)\b/i.test(`${b.partNumber} ${b.description}`));

    if (undersizedIsoDcdc || bomUndersized) {
      if (undersizedIsoDcdc) {
        undersizedIsoDcdc.partNumber = 'B0505S-2WR3';
        undersizedIsoDcdc.label = 'B0505S-2WR3';
        undersizedIsoDcdc.sublabel = '2W Isolated DC-DC (400mA)';
        undersizedIsoDcdc.manufacturer = 'Mornsun';
        undersizedIsoDcdc.rationale =
          '2W isolated 5V-to-5V DC-DC converter (400mA output) providing adequate power headroom for 4 terminated RS-485 buses (54Ω load draws ~50mA per active channel; 4 channels require >220mA peak).';
      }

      for (const item of graph.bom || []) {
        if (/\b(b0505s-1w|1w\s*isolated)\b/i.test(`${item.partNumber} ${item.description}`)) {
          item.partNumber = 'B0505S-2WR3';
          item.manufacturer = 'Mornsun';
          item.category = 'Power Management';
          item.description = 'Isolated DC/DC Converter 5V to 5V 2W 400mA SIP-4';
          item.unitCostUsd = 2.85;
        }
      }

      issues.push({
        severity: 'warning',
        code: 'ISOLATED_DCDC_UNDERSIZED',
        message: 'A 1W isolated DC/DC converter (200 mA output) is undersized for 4 terminated RS-485 channels (each channel draws ~50 mA under transmission into a 54 Ω load, totaling >220 mA peak). Auto-upgraded to Mornsun B0505S-2WR3 2W isolated DC/DC converter.',
        nodeId: undersizedIsoDcdc?.id,
      });
    }
  }

  // 14. Biomedical ECG Analog Front-End (AFE) De-Duplication
  // Dedicated medical ECG AFEs (TI ADS1292R / ADS1291 / ADS1298, ADI MAX30001 / ADAS1000) ALREADY integrate:
  // - High-CMRR Instrumentation Amplifiers (>100 dB)
  // - Programmable Gain Amplifiers (PGAs)
  // - Right Leg Drive (RLD) active common-mode rejection amplifier
  // - 24-bit delta-sigma ADCs
  // Cascading an AD8232 into an ADS1292R is an architectural redundancy that degrades SNR, doubles noise, and causes dual-RLD loop instability.
  const analogEcgNode = graph.nodes.find(
    (n) => /ad8232/i.test(`${n.id} ${n.partNumber ?? ''} ${n.label}`)
  );
  const integratedEcgNode = graph.nodes.find(
    (n) => /(ads129[1248]|max30001|adas1000)/i.test(`${n.id} ${n.partNumber ?? ''} ${n.label}`)
  );

  if (analogEcgNode && integratedEcgNode) {
    const redundantId = analogEcgNode.id;

    graph.nodes = graph.nodes.filter((n) => n.id !== redundantId);
    nodeMap.delete(redundantId);

    validEdges = validEdges.filter((e) => e.from !== redundantId && e.to !== redundantId);

    for (const rail of graph.powerRails) {
      rail.consumers = rail.consumers.filter((cid) => cid !== redundantId);
    }

    graph.bom = (graph.bom || []).filter((b) => !/ad8232/i.test(`${b.partNumber} ${b.description}`));

    integratedEcgNode.rationale =
      'Fully integrated 24-bit 2-channel medical ECG Analog Front-End with integrated low-noise high-CMRR Instrumentation Amplifiers, PGA, Right Leg Drive (RLD) amplifier, lead-off detection, and 24-bit delta-sigma ADC. Electrodes and RLD connect directly without redundant external preamps.';

    issues.push({
      severity: 'warning',
      code: 'REDUNDANT_ECG_AFE_REMOVED',
      message: `Architectural redundancy detected: Cascading AD8232 analog front-end into ADS1292R is redundant and degrades signal quality. ADS1292R already integrates high-CMRR instrumentation amplifiers, PGA, Right Leg Drive (RLD), and dual 24-bit delta-sigma ADCs. Removed redundant AD8232 and connected patient electrodes directly to ADS1292R.`,
      nodeId: integratedEcgNode.id,
    });
  }

  // 15. High-Voltage E-Bike & Industrial Battery Step-Down (72V–84V Bus)
  // Fully charged 20S Li-Ion battery reaches 84V–88V. Standard 60V bucks (LMR16030, TPS54360, LM2596HV)
  // will suffer catastrophic overvoltage breakdown. Zener dropping tricks dissipate excessive power.
  // Mandate true 100V synchronous buck (TI LM5164-Q1 or LM5017) and 100V TVS (SMCJ90A / SMCJ100A).
  const isHighVoltageBus =
    /\b(72v|84v|80v|e-bike|ebike|20s\s*li)\b/i.test(
      `${graph.projectMeta.name} ${graph.projectMeta.tagline} ${(graph.engineeringDecisions ?? []).join(' ')}`
    ) ||
    graph.powerRails.some((r) => r.voltageV >= 72) ||
    graph.nodes.some((n) => n.category === 'power' && /\b(72v|84v|80v)\b/i.test(`${n.id} ${n.label} ${n.sublabel ?? ''}`));

  if (isHighVoltageBus) {
    const UNDER_100V_BUCKS = /\b(lmr16030|tps54360|lmr14030|tps54340|tps54202|tps54331|tps54302|ap63203|mp2307|lm2596|aoz1282)/i;
    const underVoltageBuck = graph.nodes.find(
      (n) => n.category === 'power' && (UNDER_100V_BUCKS.test(n.partNumber ?? '') || UNDER_100V_BUCKS.test(n.label))
    );

    if (underVoltageBuck) {
      const oldPart = underVoltageBuck.partNumber || underVoltageBuck.label;
      underVoltageBuck.partNumber = 'LM5164QDDARQ1';
      underVoltageBuck.label = 'LM5164-Q1';
      underVoltageBuck.sublabel = '100V 1A Synchronous Buck';
      underVoltageBuck.manufacturer = 'Texas Instruments';
      underVoltageBuck.rationale =
        '100V wide-Vin synchronous step-down regulator operating up to 100V continuous input (ideal for 72V/84V e-bike bus peaking at 84V) with ultra-low 10µA quiescent current, eliminating overvoltage breakdown and lossy zener droppers.';

      for (const item of graph.bom || []) {
        if (UNDER_100V_BUCKS.test(item.partNumber) || UNDER_100V_BUCKS.test(item.description)) {
          item.partNumber = 'LM5164QDDARQ1';
          item.manufacturer = 'Texas Instruments';
          item.category = 'Power Management';
          item.description = 'Synchronous Buck Converter 100V 1A SO PowerPAD-8';
          item.unitCostUsd = 1.95;
        }
      }

      const has100vTvs = (graph.bom || []).some((b) => /\b(smcj90|smcj100|100v\s*tvs)\b/i.test(`${b.partNumber} ${b.description}`));
      if (!has100vTvs) {
        graph.bom.push({
          partNumber: 'SMCJ90A',
          manufacturer: 'Littelfuse',
          category: 'Circuit Protection',
          description: 'TVS Diode 1500W 90V Unidirectional SMC (84V E-bike input clamp)',
          qty: 1,
          unitCostUsd: 0.55,
        });
      }

      issues.push({
        severity: 'warning',
        code: 'EBIKE_BUCK_VOLTAGE_INSUFFICIENT',
        message: `In an 84V e-bike / high-voltage battery system, buck regulator '${oldPart}' rated for <= 60V will suffer catastrophic overvoltage destruction. Auto-upgraded to 100V-rated LM5164-Q1 synchronous buck converter with 100V TVS surge clamping.`,
        nodeId: underVoltageBuck.id,
      });
    }
  }

  // 16. RS-485 / CAN Switched Termination Bidirectionality
  // Differential bus signals (A/B) swing positive and negative. Switching a 120 Ω termination resistor
  // with a single discrete N-channel MOSFET (2N7002, BSS138) causes the intrinsic body diode to clip
  // negative differential swings, corrupting bus packets.
  // Mandate a bidirectional Solid-State Relay (PhotoMOS, e.g. AQY212GS) or telecom signal relay (EC2-3NU).
  const isTerminationSwitch = (text: string) =>
    /\b(terminat|120\s*ohm|120r|bus[-\s]?switch)\b/i.test(text);

  const mosfetTerminationNode = graph.nodes.find(
    (n) =>
      /\b(2n7002|bss138|fdn337|mosfet|n-ch)\b/i.test(`${n.partNumber ?? ''} ${n.label} ${n.sublabel ?? ''}`) &&
      isTerminationSwitch(`${n.id} ${n.label} ${n.sublabel ?? ''} ${n.rationale ?? ''}`)
  );

  const bomMosfetTermination = (graph.bom || []).find(
    (b) =>
      /\b(2n7002|bss138|mosfet)\b/i.test(`${b.partNumber} ${b.description}`) &&
      isTerminationSwitch(`${b.description}`)
  );

  if (mosfetTerminationNode || bomMosfetTermination) {
    if (mosfetTerminationNode) {
      mosfetTerminationNode.partNumber = 'AQY212GS';
      mosfetTerminationNode.label = 'AQY212GS';
      mosfetTerminationNode.sublabel = 'Bidirectional PhotoMOS SSR';
      mosfetTerminationNode.manufacturer = 'Panasonic';
      mosfetTerminationNode.rationale =
        'Optically isolated bidirectional Solid-State Relay (PhotoMOS, 60V 500mA AC/DC) providing true bipolar 120Ω bus termination switching without body diode conduction clipping differential RS-485 signals.';
    }

    for (const item of graph.bom || []) {
      if (
        /\b(2n7002|bss138|mosfet)\b/i.test(`${item.partNumber} ${item.description}`) &&
        isTerminationSwitch(`${item.description}`)
      ) {
        item.partNumber = 'AQY212GS';
        item.manufacturer = 'Panasonic';
        item.category = 'Relays';
        item.description = 'Solid State Relay PhotoMOS 60V 500mA SOP-4 (Bidirectional RS-485 Termination Switch)';
        item.unitCostUsd = 1.45;
      }
    }

    issues.push({
      severity: 'warning',
      code: 'RS485_TERMINATION_SWITCH_CLIPPING',
      message: 'Using a single N-channel MOSFET for RS-485 120 Ω bus termination switching causes its parasitic body diode to conduct on differential signal reversals, clipping data lines. Auto-upgraded to Panasonic AQY212GS bidirectional PhotoMOS solid-state relay.',
      nodeId: mosfetTerminationNode?.id,
    });
  }

  const repairedGraph: CanonicalDesignGraph = { ...graph, edges: validEdges };
  const hasCriticalErrors = issues.some((i) => i.severity === 'error');

  if (issues.length > 0) {
    logger.info({ issueCount: issues.length, hasCriticalErrors }, 'Design graph validation and repair complete');
  }

  return { isValid: !hasCriticalErrors, issues, repairedGraph };
}
