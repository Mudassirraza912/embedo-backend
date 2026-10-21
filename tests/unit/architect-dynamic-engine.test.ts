import { routeMessage } from '../../src/modules/sessions/conversation-router.service.js';
import {
  isExpansionRequest,
  extractExpansionCount,
  getExpansionCataloguePrompt,
  expandDesignGraphWithModules,
  EXPANSION_CATALOGUE,
} from '../../src/modules/sessions/pipeline/expansion-engine.js';
import { validateAndRepairDesignGraph } from '../../src/modules/sessions/pipeline/validator.js';
import { describeGraphChanges } from '../../src/modules/sessions/pipeline/refinement-history.js';
import { CanonicalDesignGraph } from '../../src/modules/sessions/pipeline/types.js';

describe('Architect Dynamic Engine — Router & Directives', () => {
  it('correctly identifies expansion requests across multiple phrasing styles', () => {
    expect(isExpansionRequest('add 30 more modules')).toBe(true);
    expect(isExpansionRequest('please add 20 more modules')).toBe(true);
    expect(isExpansionRequest('add 15 sensors to the system')).toBe(true);
    expect(isExpansionRequest('expand the system with more peripherals')).toBe(true);
    expect(isExpansionRequest('scale the architecture')).toBe(true);
    expect(isExpansionRequest('include all of these')).toBe(true);
    expect(isExpansionRequest('add these recommended modules')).toBe(true);
    expect(isExpansionRequest('what is I2C?')).toBe(false);
    expect(isExpansionRequest('how does CAN bus work?')).toBe(false);
  });

  it('extracts expansion counts accurately with safe boundary clamping', () => {
    expect(extractExpansionCount('add 30 more modules', 10)).toBe(30);
    expect(extractExpansionCount('add 5 modules', 10)).toBe(5);
    expect(extractExpansionCount('expand with 12 sensors', 10)).toBe(12);
    expect(extractExpansionCount('add 100 modules', 10)).toBe(32); // safely clamped
    expect(extractExpansionCount('add more modules', 10)).toBe(10); // default fallback
  });

  it('generates an expansion catalogue prompt containing verified ICs', () => {
    const prompt = getExpansionCataloguePrompt(15);
    expect(prompt).toContain('SYSTEM EXPANSION DIRECTIVE');
    expect(prompt).toContain('TCA9548APWR');
    expect(prompt).toContain('BME280');
    expect(prompt).toContain('ICM-42688-P');
    expect(prompt).toContain('INA226AIDGSR');
  });
});

describe('Architect Dynamic Engine — Multi-Module Expansion Synthesizer', () => {
  const createBaseGraph = (): CanonicalDesignGraph => ({
    projectMeta: {
      name: 'Smart Sensor Hub',
      tagline: 'IoT Environmental Node',
      controller: 'ESP32-S3-MINI-1',
    },
    controller: {
      partNumber: 'ESP32-S3-MINI-1',
      manufacturer: 'Espressif',
      rationale: 'Primary dual-core Wi-Fi & BLE MCU host',
    },
    nodes: [
      {
        id: 'mcu',
        label: 'ESP32-S3 Host',
        sublabel: 'Dual-core MCU',
        category: 'control',
        partNumber: 'ESP32-S3-MINI-1',
        manufacturer: 'Espressif',
        voltageV: 3.3,
        currentMa: 80,
        interfaces: ['I2C', 'SPI', 'UART'],
      },
      {
        id: 'regulator',
        label: '3.3V Buck Regulator',
        sublabel: 'TPS62840 Buck',
        category: 'power',
        partNumber: 'TPS62840DLYR',
        manufacturer: 'Texas Instruments',
        voltageV: 3.3,
        currentMa: 750,
        interfaces: ['power'],
      },
    ],
    edges: [
      {
        from: 'regulator',
        to: 'mcu',
        label: '3.3V',
        type: 'power',
      },
    ],
    powerRails: [
      {
        name: '3V3',
        voltageV: 3.3,
        source: 'regulator',
        consumers: ['mcu'],
      },
    ],
    bom: [
      {
        partNumber: 'ESP32-S3-MINI-1',
        manufacturer: 'Espressif',
        category: 'Microcontrollers',
        description: 'Wi-Fi & BLE Dual-Core 240MHz MCU Module',
        qty: 1,
        unitCostUsd: 2.8,
      },
      {
        partNumber: 'TPS62840DLYR',
        manufacturer: 'Texas Instruments',
        category: 'Power Management',
        description: 'Ultra-low Iq 750mA Buck Converter',
        qty: 1,
        unitCostUsd: 1.15,
      },
    ],
    engineeringDecisions: ['Initial architecture baseline with ESP32-S3 and ultra-low Iq regulator'],
    suggestedRefinements: ['Add environmental sensor', 'Add external storage'],
  });

  it('dynamically expands the baseline by 5 modules with zero duplicate IDs or parts', () => {
    const base = createBaseGraph();
    const expanded = expandDesignGraphWithModules(base, 5, 'add 5 modules');

    expect(expanded.nodes.length).toBe(7); // 2 baseline + 5 new
    expect(expanded.bom.length).toBe(7);
    expect(expanded.powerRails[0].consumers.length).toBe(6); // mcu + 5 modules

    // Verify all added nodes have unique IDs
    const nodeIds = expanded.nodes.map((n) => n.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);

    // Verify describeGraphChanges captures the additions
    const diff = describeGraphChanges(base, expanded);
    expect(diff.length).toBeGreaterThanOrEqual(5);

    // Electrical validation check
    const validation = validateAndRepairDesignGraph(expanded);
    expect(validation.isValid).toBe(true);
  });

  it('dynamically expands the architecture by 20 modules and inserts I2C multiplexer for bus stability', () => {
    const base = createBaseGraph();
    const expanded = expandDesignGraphWithModules(base, 20, 'add 20 more modules');

    expect(expanded.nodes.length).toBe(22); // 2 baseline + 20 new
    expect(expanded.bom.length).toBe(22);

    // Should include TCA9548APWR I2C multiplexer to handle large bus expansion
    const muxNode = expanded.nodes.find((n) => n.partNumber === 'TCA9548APWR');
    expect(muxNode).toBeDefined();

    // Verify electrical validation passes with zero critical errors
    const validation = validateAndRepairDesignGraph(expanded);
    expect(validation.isValid).toBe(true);
    expect(validation.issues.filter((i) => i.severity === 'error').length).toBe(0);
  });

  it('handles massive expansion ("add 30 more modules") flawlessly up to catalogue capacity', () => {
    const base = createBaseGraph();
    const expanded = expandDesignGraphWithModules(base, 30, 'add 30 more modules');

    expect(expanded.nodes.length).toBeGreaterThanOrEqual(25);
    expect(expanded.bom.length).toBeGreaterThanOrEqual(25);

    // Tagline reflects expansion
    expect(expanded.projectMeta.tagline).toContain('Expanded with');

    // Engineering decisions record expansion
    expect(expanded.engineeringDecisions[0]).toContain('Expanded architecture with');

    // Diff cleanly detects all additions
    const diff = describeGraphChanges(base, expanded);
    expect(diff.length).toBeGreaterThanOrEqual(20);

    // Validates cleanly
    const validation = validateAndRepairDesignGraph(expanded);
    expect(validation.isValid).toBe(true);
  });
});

describe('Architect Dynamic Engine — Intentional DRC Validation Cases', () => {
  it('detects and auto-repairs incompatible buck regulator on 2x AA alkaline battery', () => {
    const flawedGraph: CanonicalDesignGraph = {
      projectMeta: { name: 'Battery Sensor', tagline: '2x AA Node', controller: 'STM32L031K6T6' },
      controller: { partNumber: 'STM32L031K6T6', manufacturer: 'STMicroelectronics', rationale: 'Ultra-low power MCU' },
      nodes: [
        {
          id: 'battery',
          label: '2x AA Battery Pack',
          sublabel: '3.0V nominal (2.0V-3.0V)',
          category: 'power',
          partNumber: 'BAT-2XAA-HOLDER',
          voltageV: 3.0,
        },
        {
          id: 'regulator',
          label: 'Buck Converter',
          sublabel: 'Buck-only regulator',
          category: 'power',
          partNumber: 'AP63203WU-7', // Incompatible: requires >= 3.8V input!
          voltageV: 3.3,
        },
        {
          id: 'mcu',
          label: 'STM32 MCU',
          sublabel: 'Cortex-M0+',
          category: 'control',
          partNumber: 'STM32L031K6T6',
          voltageV: 3.3,
        },
      ],
      edges: [
        { from: 'battery', to: 'regulator', label: 'VBAT', type: 'power' },
        { from: 'regulator', to: 'mcu', label: '3.3V', type: 'power' },
      ],
      powerRails: [{ name: '3V3', voltageV: 3.3, source: 'regulator', consumers: ['mcu'] }],
      bom: [
        { partNumber: 'AP63203WU-7', manufacturer: 'Diodes Inc', category: 'Power', description: 'Buck Converter', qty: 1 },
      ],
      engineeringDecisions: ['Battery powered node'],
      suggestedRefinements: [],
    };

    const report = validateAndRepairDesignGraph(flawedGraph);
    expect(report.isValid).toBe(true);
    // Flagged the DRC issue
    const drcIssue = report.issues.find((i) => i.code === 'REGULATOR_TOPOLOGY_INCOMPATIBLE');
    expect(drcIssue).toBeDefined();
    expect(drcIssue?.message).toContain('AP63203');
    // Repaired to TPS63031 buck-boost
    expect(report.repairedGraph.nodes.find((n) => n.id === 'regulator')?.partNumber).toBe('TPS63031DSKR');
  });

  it('detects and flags overvoltage hazard when 28V buck is placed on 12V automotive battery', () => {
    const autoFlawedGraph: CanonicalDesignGraph = {
      projectMeta: { name: 'Vehicle Telematics', tagline: '12V Auto Tracker', controller: 'STM32G431' },
      controller: { partNumber: 'STM32G431KBT6', manufacturer: 'STMicroelectronics', rationale: 'Automotive MCU' },
      nodes: [
        {
          id: 'car_battery',
          label: '12V Vehicle Battery',
          sublabel: '12V Automotive Lead-Acid (ISO 7637-2 load dump to 40V)',
          category: 'power',
          partNumber: 'AUTO-12V-BATTERY',
          voltageV: 12.0,
        },
        {
          id: 'buck',
          label: 'Buck Converter',
          sublabel: '28V Max Buck',
          category: 'power',
          partNumber: 'TPS54202DDCR', // Overvoltage risk: rated only 28V, will blow on 35V-40V load dump!
          voltageV: 3.3,
        },
        {
          id: 'mcu',
          label: 'Automotive MCU',
          sublabel: 'STM32G4',
          category: 'control',
          partNumber: 'STM32G431KBT6',
          voltageV: 3.3,
        },
      ],
      edges: [
        { from: 'car_battery', to: 'buck', label: '12V Rail', type: 'power' },
        { from: 'buck', to: 'mcu', label: '3.3V', type: 'power' },
      ],
      powerRails: [{ name: '3V3', voltageV: 3.3, source: 'buck', consumers: ['mcu'] }],
      bom: [],
      engineeringDecisions: [],
      suggestedRefinements: [],
    };

    const report = validateAndRepairDesignGraph(autoFlawedGraph);
    const drcIssue = report.issues.find((i) => i.code === 'AUTOMOTIVE_BUCK_VOLTAGE_INSUFFICIENT');
    expect(drcIssue).toBeDefined();
    expect(drcIssue?.message).toContain('TPS54202DDCR');
    // Auto-repaired to automotive-rated 40V buck
    expect(report.repairedGraph.nodes.find((n) => n.id === 'buck')?.partNumber).toBe('LMR14030SDDA');
  });

  it('detects and prevents 5.0V overvoltage destruction on cellular modem VBAT pin', () => {
    const modemFlawedGraph: CanonicalDesignGraph = {
      projectMeta: { name: 'Cellular Gateway', tagline: 'LTE-M Gateway', controller: 'ESP32-S3' },
      controller: { partNumber: 'ESP32-S3', manufacturer: 'Espressif', rationale: 'Gateway MCU' },
      nodes: [
        {
          id: 'mcu',
          label: 'ESP32-S3 Host',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'ESP32-S3',
          voltageV: 3.3,
        },
        {
          id: 'modem',
          label: 'Quectel BG95',
          sublabel: 'LTE-M / NB-IoT Modem',
          category: 'connectivity',
          partNumber: 'BG95-M3',
          voltageV: 5.0, // Flawed: cellular modems have absolute max 4.5V!
          interfaces: ['UART'],
        },
        {
          id: 'reg_5v',
          label: '5V Main Supply',
          sublabel: '5V Buck',
          category: 'power',
          partNumber: 'AP63203',
          voltageV: 5.0,
        },
      ],
      edges: [
        { from: 'reg_5v', to: 'modem', label: '5V VBAT', type: 'power' },
        { from: 'mcu', to: 'modem', label: 'AT Commands', type: 'uart' },
      ],
      powerRails: [{ name: '5V', voltageV: 5.0, source: 'reg_5v', consumers: ['modem'] }],
      bom: [],
      engineeringDecisions: [],
      suggestedRefinements: [],
    };

    const report = validateAndRepairDesignGraph(modemFlawedGraph);
    const drcIssue = report.issues.find((i) => i.code === 'CELLULAR_MODEM_VBAT_OVERVOLTAGE');
    expect(drcIssue).toBeDefined();
    expect(drcIssue?.message).toContain('5.0V');
    // Voltage corrected to 3.8V nominal
    expect(report.repairedGraph.nodes.find((n) => n.id === 'modem')?.voltageV).toBe(3.8);
  });
});
