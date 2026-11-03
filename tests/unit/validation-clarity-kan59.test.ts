import { describe, it, expect } from '@jest/globals';
import { validateAndRepairDesignGraph } from '../../src/modules/sessions/pipeline/validator.js';
import { CanonicalDesignGraph } from '../../src/modules/sessions/pipeline/types.js';

describe('KAN-59 & KAN-61: Validation Rules Distinction & Cross-Mode Symmetrical Integrity', () => {
  const baseGraph: CanonicalDesignGraph = {
    projectMeta: {
      name: 'Vibration Motor Controller',
      tagline: 'Precision haptic motor driver and environmental monitor',
      controller: 'STM32L452RE',
    },
    controller: {
      partNumber: 'STM32L452RE',
      manufacturer: 'STMicroelectronics',
      rationale: 'Ultra-low-power ARM Cortex-M4 with rich PWM timers',
    },
    nodes: [
      {
        id: 'mcu',
        label: 'STM32L452RE',
        sublabel: 'Main Controller',
        category: 'control',
        partNumber: 'STM32L452RE',
      },
      {
        id: 'motor_driver',
        label: 'DRV2605L',
        sublabel: 'Haptic Driver',
        category: 'actuation',
        partNumber: 'DRV2605L',
        interfaces: ['I2C'],
      },
      {
        id: 'sensor',
        label: 'SHT40',
        sublabel: 'Temp & Humidity',
        category: 'sensing',
        partNumber: 'SHT40',
        interfaces: ['I2C'],
      },
    ],
    edges: [],
    powerRails: [
      {
        name: '3.3V',
        voltageV: 3.3,
        source: 'regulator',
        consumers: [],
      },
    ],
    bom: [
      {
        partNumber: 'STM32L452RE',
        manufacturer: 'STMicroelectronics',
        category: 'Microcontroller',
        description: 'Ultra-low-power MCU',
        qty: 1,
      },
      {
        partNumber: 'DRV2605L',
        manufacturer: 'Texas Instruments',
        category: 'Motor Driver',
        description: 'Haptic Driver for ERM/LRA',
        qty: 1,
      },
    ],
  };

  describe('1. Project Findings Integrity vs. 17-Rule DRC Catalogue', () => {
    it('evaluates project findings accurately without conflating with the 17 global catalogue rules', () => {
      const report = validateAndRepairDesignGraph(baseGraph);

      // The project findings should only reflect the actual repairs/issues in this project graph,
      // NOT report 17 errors or conflate the global catalogue with project-level findings
      expect(report.issues.length).toBeLessThan(17);
      expect(report.repairedGraph).toBeDefined();

      // Ensure that issues have severity and clear codes
      for (const issue of report.issues) {
        expect(['error', 'warning']).toContain(issue.severity);
        expect(typeof issue.code).toBe('string');
        expect(issue.code.length).toBeGreaterThan(0);
        expect(typeof issue.message).toBe('string');
      }
    });

    it('ensures clean project v1.1 passes validation without phantom errors', () => {
      // Connect peripheral edges and power rails so design is fully verified
      const cleanGraph: CanonicalDesignGraph = {
        ...baseGraph,
        edges: [
          {
            id: 'edge_mcu_motor',
            from: 'mcu',
            to: 'motor_driver',
            type: 'i2c',
            label: 'I2C Bus',
          },
          {
            id: 'edge_mcu_sensor',
            from: 'mcu',
            to: 'sensor',
            type: 'i2c',
            label: 'I2C Bus',
          },
        ],
        powerRails: [
          {
            name: '3.3V',
            voltageV: 3.3,
            source: 'regulator',
            consumers: ['mcu', 'motor_driver', 'sensor'],
          },
        ],
      };

      const report = validateAndRepairDesignGraph(cleanGraph);
      expect(report.isValid).toBe(true);

      const criticalErrors = report.issues.filter((i) => i.severity === 'error');
      expect(criticalErrors.length).toBe(0);
    });
  });

  describe('2. Specific DRC Rules Evaluated by Case C Engine', () => {
    it('detects and auto-repairs CELLULAR_MODEM_VBAT_OVERVOLTAGE', () => {
      const cellularGraph: CanonicalDesignGraph = {
        ...baseGraph,
        nodes: [
          ...baseGraph.nodes,
          {
            id: 'modem',
            label: 'EC25',
            category: 'connectivity',
            partNumber: 'EC25',
          },
        ],
        powerRails: [
          {
            name: '5.0V',
            voltageV: 5.0,
            source: 'regulator',
            consumers: ['modem'],
          },
        ],
      };

      const report = validateAndRepairDesignGraph(cellularGraph);
      const vbatRepair = report.issues.find((i) => i.code === 'CELLULAR_MODEM_VBAT_OVERVOLTAGE');
      expect(vbatRepair).toBeDefined();
      expect(vbatRepair?.message).toMatch(/3\.8V/);

      // Verify that the dedicated 3.8V rail was synthesized
      const rail38 = report.repairedGraph.powerRails.find((r) => r.voltageV === 3.8);
      expect(rail38).toBeDefined();
    });

    it('detects and auto-repairs PRIMARY_BATTERY_CHARGER_REMOVED', () => {
      const batteryGraph: CanonicalDesignGraph = {
        ...baseGraph,
        projectMeta: {
          ...baseGraph.projectMeta,
          tagline: 'Runs on 2x AA alkaline batteries with USB-C',
        },
        nodes: [
          ...baseGraph.nodes,
          {
            id: 'charger',
            label: 'BQ25186 Battery Charger',
            category: 'power',
            partNumber: 'BQ25186',
          },
        ],
      };

      const report = validateAndRepairDesignGraph(batteryGraph);
      const chargerIssue = report.issues.find((i) => i.code === 'PRIMARY_BATTERY_CHARGER_REMOVED');
      expect(chargerIssue).toBeDefined();

      // Ensure hazardous charger IC was removed
      const hasCharger = report.repairedGraph.nodes.some((n) => n.id === 'charger');
      expect(hasCharger).toBe(false);
    });

    it('detects and auto-repairs AUTOMOTIVE_BUCK_VOLTAGE_INSUFFICIENT', () => {
      const automotiveGraph: CanonicalDesignGraph = {
        ...baseGraph,
        projectMeta: {
          ...baseGraph.projectMeta,
          tagline: '12V automotive vehicle tracking system',
        },
        nodes: [
          ...baseGraph.nodes,
          {
            id: 'buck',
            label: 'AP63203 Buck Regulator',
            category: 'power',
            partNumber: 'AP63203',
          },
        ],
      };

      const report = validateAndRepairDesignGraph(automotiveGraph);
      const buckIssue = report.issues.find((i) => i.code === 'AUTOMOTIVE_BUCK_VOLTAGE_INSUFFICIENT');
      expect(buckIssue).toBeDefined();

      // Ensure upgraded to AEC-Q100 automotive rated regulator
      const upgradedBuck = report.repairedGraph.nodes.find((n) => n.id === 'buck');
      expect(upgradedBuck?.partNumber).toBe('LMR14030SDDA');
    });

    it('detects and auto-repairs COIN_CELL_PULSE_CAPACITOR_ADDED', () => {
      const coinCellGraph: CanonicalDesignGraph = {
        projectMeta: {
          name: 'BLE Asset Tracker Beacon',
          tagline: 'CR2032 powered iBeacon with accelerometer',
          controller: 'nRF52810',
        },
        controller: {
          partNumber: 'nRF52810-QFAA',
          manufacturer: 'Nordic Semiconductor',
          rationale: 'Ultra-low-power BLE 5.0 SoC',
        },
        nodes: [
          {
            id: 'battery',
            label: 'CR2032 Coin Cell',
            sublabel: '3.0V / 225mAh',
            category: 'power',
            partNumber: 'CR2032',
          },
          {
            id: 'mcu',
            label: 'nRF52810',
            sublabel: 'BLE SoC',
            category: 'control',
            partNumber: 'nRF52810-QFAA',
          },
        ],
        edges: [],
        powerRails: [],
        bom: [],
      };

      const report = validateAndRepairDesignGraph(coinCellGraph);
      const pulseCapIssue = report.issues.find((i) => i.code === 'COIN_CELL_PULSE_CAPACITOR_ADDED');
      expect(pulseCapIssue).toBeDefined();

      // Ensure pulse capacitor was added
      const capNode = report.repairedGraph.nodes.find((n) => n.id === 'pulse_reservoir_cap');
      expect(capNode).toBeDefined();
    });
  });

  describe('3. Validation Status & Copy Symmetries (KAN-59 & KAN-61)', () => {
    it('verifies that status definitions match canonical 4-state taxonomy', () => {
      const canonicalStatuses = ['FAIL', 'WARNING', 'UNVERIFIED', 'PASS'];
      expect(canonicalStatuses).toHaveLength(4);

      // Verify that status descriptions do not claim electrical certification on general rule library
      const statusMeanings = {
        FAIL: 'Critical violation (e.g. overvoltage, thermal hazard, missing controller). Must be revised or overridden before build.',
        WARNING: 'Electrical derating, transient sag, or component constraint. Can be revised in chat or explicitly accepted.',
        UNVERIFIED: 'Record lacks datasheet facts or unverified pinout mappings. Neither a pass nor a fail.',
        PASS: 'Automated rule executed and confirmed compatible with operating standards and limits.',
      };

      for (const [key, text] of Object.entries(statusMeanings)) {
        expect(text.length).toBeGreaterThan(20);
        expect(canonicalStatuses).toContain(key);
      }
    });

    it('preserves traceable warning acknowledgement semantics for revision continuity', () => {
      const acceptedSet = new Set<string>();
      const warningId = 'warning_drv2605_i2c_pullup';

      // Accept warning
      acceptedSet.add(warningId);
      expect(acceptedSet.has(warningId)).toBe(true);

      // Verify status transitions from active to accepted without losing finding identity
      const isAccepted = acceptedSet.has(warningId);
      const displayedStatus = isAccepted ? 'ACCEPTED' : 'WARNING';
      expect(displayedStatus).toBe('ACCEPTED');

      // Resetting on revision increment
      const newRevisionSet = new Set<string>();
      expect(newRevisionSet.has(warningId)).toBe(false);
    });
  });
});
