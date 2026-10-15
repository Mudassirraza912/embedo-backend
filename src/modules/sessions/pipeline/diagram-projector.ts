import {
  CanonicalDesignGraph,
  DiagramEdge,
  DiagramLegend,
  DiagramNode,
  ProjectedArchitecture,
  ProjectedDiagram,
} from './types.js';

const LEGEND_COLORS: Record<string, string> = {
  power: '#075F69',
  rail: '#019893',
  i2c: '#9CD7D5',
  spi: '#F59E0B',
  uart: '#3B82F6',
  usb: '#021316',
  sdmmc: '#019893',
  signal: '#20E6E0',
  gpio: '#075F69',
  analog: '#EC4899',
};

/**
 * Pure deterministic diagram projection algorithm.
 * Converts semantic CanonicalDesignGraph into 3 pixel-positioned diagrams
 * matching the Embedo Frontend visualization engine.
 */
export function projectArchitecture(graph: CanonicalDesignGraph): ProjectedArchitecture {
  const functionalBlock = projectFunctionalBlock(graph);
  const powerTree = projectPowerTree(graph);
  const protocolMap = projectProtocolMap(graph);

  // Calculate estimated total BOM cost
  const totalCost = (graph.bom || []).reduce((acc, item) => {
    return acc + (item.unitCostUsd || 0) * (item.qty || 1);
  }, 0);

  // Derive power input description
  const powerNodes = graph.nodes.filter((n) => n.category === 'power');
  const batNode = powerNodes.find(
    (n) => n.id.includes('bat') || n.label.toLowerCase().includes('battery') || n.label.toLowerCase().includes('cell')
  );
  const hasUsb = powerNodes.some((n) => n.id.includes('usb') || n.label.toLowerCase().includes('usb'));
  const dcNode = powerNodes.find(
    (n) => n.label.includes('9V') || n.label.includes('12V') || n.label.includes('24V') || n.label.toLowerCase().includes('dc')
  );

  let powerInputStr = '5V USB-C / DC Input';
  if (dcNode) {
    powerInputStr = dcNode.label.includes('9V') || dcNode.label.includes('12V') || dcNode.label.includes('24V')
      ? '9V – 24V DC Input'
      : `${dcNode.label} Input`;
  } else if (batNode && !hasUsb) {
    powerInputStr = batNode.sublabel ? `${batNode.label} (${batNode.sublabel})` : batNode.label;
  } else if (batNode && hasUsb) {
    powerInputStr = `${batNode.sublabel || batNode.label} / 5V USB-C`;
  } else if (powerNodes.length > 0) {
    powerInputStr = powerNodes[0].label;
  }

  // Derive outputs
  const outputNodes = graph.nodes.filter((n) => n.category === 'motor' || n.category === 'haptic' || n.category === 'ui');
  const outputsStr = outputNodes.length > 0
    ? outputNodes.map((n) => n.label).slice(0, 3).join(', ')
    : 'Status LEDs & Actuation';

  // Derive interfaces & inputs
  const sensingNodes = graph.nodes.filter((n) => n.category === 'sensing');
  const interfaceNodes = graph.nodes.filter(
    (n) => n.category === 'connectivity' || n.category === 'storage' || n.category === 'ui'
  );

  const interfacesStr = interfaceNodes.length > 0
    ? interfaceNodes.map((n) => n.label).slice(0, 4).join(', ')
    : 'I2C, SPI, UART, BLE';

  const inputsStr = sensingNodes.length > 0
    ? sensingNodes.map((n) => n.label).slice(0, 3).join(', ')
    : 'User Inputs, Sensors';

  // The design's own (already de-duplicated) suggestions — this used to be a fixed list that
  // offered e.g. "Add battery backup" to designs that already had one.
  const refineSuggestions: string[] = graph.suggestedRefinements ?? [];

  return {
    projectMeta: {
      name: graph.projectMeta.name || 'Embedded System Design',
      tagline: graph.projectMeta.tagline || 'AI-generated embedded hardware architecture',
      controller: graph.controller.partNumber || graph.projectMeta.controller || 'MCU',
    },
    summary: {
      mcu: graph.controller.partNumber || 'ESP32-S3',
      powerInput: powerInputStr,
      outputs: outputsStr,
      interfaces: interfacesStr,
      inputs: inputsStr,
      estimatedBomCostUsd: Number(totalCost.toFixed(2)),
    },
    refineSuggestions,
    functionalBlock,
    powerTree,
    protocolMap,
    bom: graph.bom || [],
  };
}

/**
 * 01 — Functional Block Diagram Projection
 */
function projectFunctionalBlock(graph: CanonicalDesignGraph): ProjectedDiagram {
  const nodes: DiagramNode[] = [];
  const mcuNode = graph.nodes.find((n) => n.category === 'control') || graph.nodes[0];
  const powerNodes = graph.nodes.filter(
    (n) => n.category === 'power' && n.id !== mcuNode?.id
  );
  const centerBottomNodes = graph.nodes.filter(
    (n) => (n.category === 'gauge' || (n.category === 'ui' && n.id.includes('btn'))) && n.id !== mcuNode?.id
  );
  const peripheralNodes = graph.nodes.filter(
    (n) =>
      n.id !== mcuNode?.id &&
      !powerNodes.includes(n) &&
      !centerBottomNodes.includes(n)
  );

  // 1. Left Column: Power components
  let leftY = 70;
  for (const pNode of powerNodes) {
    nodes.push({
      id: pNode.id,
      x: 50,
      y: leftY,
      w: 160,
      h: leftY === 70 ? 70 : 80,
      label: pNode.label,
      sublabel: pNode.sublabel,
      category: pNode.category,
    });
    leftY += 130;
  }

  // 2. Center Column: MCU + lower center accessories
  if (mcuNode) {
    nodes.push({
      id: mcuNode.id,
      x: 410,
      y: 300,
      w: 180,
      h: 100,
      label: mcuNode.label,
      sublabel: mcuNode.sublabel,
      category: mcuNode.category,
    });
  }

  let centerY = 470;
  for (const cNode of centerBottomNodes) {
    nodes.push({
      id: cNode.id,
      x: 410,
      y: centerY,
      w: 180,
      h: 65,
      label: cNode.label,
      sublabel: cNode.sublabel,
      category: cNode.category,
    });
    centerY += 90;
  }

  // 3. Right Column: Peripherals (Storage, Audio, UI, Sensors, Actuators)
  let rightY = 70;
  for (const pNode of peripheralNodes) {
    nodes.push({
      id: pNode.id,
      x: 760,
      y: rightY,
      w: 180,
      h: 65,
      label: pNode.label,
      sublabel: pNode.sublabel,
      category: pNode.category,
    });
    rightY += 95;
  }

  const maxHeight = Math.max(leftY, centerY, rightY, 690) + 40;

  // Edges mapping
  const edges: DiagramEdge[] = graph.edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.label,
    type: e.type,
    dashed: e.dashed,
  }));

  const usedTypes = new Set(edges.map((e) => e.type));
  const legend: DiagramLegend[] = [];

  if (usedTypes.has('power')) {
    legend.push({ color: LEGEND_COLORS['power'] ?? '#075F69', label: 'Power / critical path' });
  }
  if (usedTypes.has('i2c')) {
    legend.push({ color: LEGEND_COLORS['i2c'] ?? '#9CD7D5', label: 'Shared I²C bus' });
  }
  if (usedTypes.has('signal') || usedTypes.has('gpio')) {
    legend.push({ color: LEGEND_COLORS['signal'] ?? '#20E6E0', label: 'Signal / data (I²S, GPIO)' });
  }
  if (usedTypes.has('sdmmc') || usedTypes.has('spi')) {
    legend.push({ color: LEGEND_COLORS['sdmmc'] ?? '#019893', label: 'High-speed storage / bus' });
  }

  return {
    title: 'Functional Block Diagram',
    figure: 'Figure 1 — Functional block diagram',
    caption: `${graph.projectMeta.name || 'System'} functional block architecture with ${graph.controller.partNumber} as central controller.`,
    width: 1000,
    height: maxHeight,
    nodes,
    edges,
    legend,
  };
}

/**
 * 02 — Power Tree Diagram Projection
 */
function projectPowerTree(graph: CanonicalDesignGraph): ProjectedDiagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  // 1. Identify actual power components from graph
  const powerNodes = graph.nodes.filter((n) => n.category === 'power');
  const chargerNode = powerNodes.find(
    (n) => n.id.includes('charger') || n.label.toLowerCase().includes('charger') || n.id.includes('pmic')
  );
  const batteryNode = powerNodes.find(
    (n) =>
      (n.id.includes('bat') || n.label.toLowerCase().includes('battery') || n.label.toLowerCase().includes('cell')) &&
      n !== chargerNode
  );
  const usbInputNode = powerNodes.find(
    (n) =>
      (n.id.includes('usb') || n.id.includes('vbus') || n.label.toLowerCase().includes('usb')) &&
      n !== chargerNode &&
      n !== batteryNode
  );
  const dcInputNode = powerNodes.find(
    (n) =>
      (n.id.includes('dc') || n.label.toLowerCase().includes('dc') || n.label.includes('9V') || n.label.includes('12V') || n.label.includes('24V')) &&
      n !== chargerNode &&
      n !== batteryNode &&
      n !== usbInputNode
  );
  const regulatorNode = powerNodes.find(
    (n) =>
      n !== chargerNode &&
      n !== batteryNode &&
      n !== usbInputNode &&
      n !== dcInputNode
  );

  const primaryRail = graph.powerRails.find((r) => r.voltageV === 3.3) || graph.powerRails[0] || {
    name: '3.3V',
    voltageV: 3.3,
    source: 'regulator',
    consumers: [],
  };
  const railVoltageStr = `${primaryRail.voltageV ?? 3.3}V`;

  // Determine Power Tree Topology
  if (batteryNode && !chargerNode && !usbInputNode) {
    // Case A: Battery Only (e.g. 2x AA, AAA, CR2032, non-rechargeable)
    nodes.push({
      id: batteryNode.id,
      x: 50,
      y: 90,
      w: 180,
      h: 80,
      label: batteryNode.label,
      sublabel: batteryNode.sublabel || 'battery power',
      category: 'power',
    });

    if (regulatorNode) {
      nodes.push({
        id: regulatorNode.id,
        x: 50,
        y: 240,
        w: 180,
        h: 75,
        label: regulatorNode.label,
        sublabel: regulatorNode.sublabel || 'voltage converter',
        category: 'power',
      });
      const vbatLabel = batteryNode.sublabel?.includes('V') ? batteryNode.sublabel.split(' ')[0] : 'VBAT';
      edges.push({ from: batteryNode.id, to: regulatorNode.id, label: vbatLabel || 'VBAT', type: 'power' });
      edges.push({ from: regulatorNode.id, to: 'rail', label: railVoltageStr, type: 'rail' });
    } else {
      edges.push({ from: batteryNode.id, to: 'rail', label: railVoltageStr, type: 'rail' });
    }
  } else if (chargerNode || (usbInputNode && batteryNode)) {
    // Case B: Rechargeable System with Charger (USB-C + Charger + LiPo)
    const vbusId = usbInputNode?.id || 'vbus';
    nodes.push({
      id: vbusId,
      x: 50,
      y: 50,
      w: 170,
      h: 70,
      label: usbInputNode?.label || 'USB-C VBUS',
      sublabel: usbInputNode?.sublabel || '5V input',
      category: 'power',
    });

    const cId = chargerNode?.id || 'charger';
    nodes.push({
      id: cId,
      x: 50,
      y: 170,
      w: 170,
      h: 80,
      label: chargerNode?.label || 'BQ25186',
      sublabel: chargerNode?.sublabel || '1-cell charger',
      category: 'power',
    });

    const bId = batteryNode?.id || 'battery';
    nodes.push({
      id: bId,
      x: 270,
      y: 170,
      w: 160,
      h: 80,
      label: batteryNode?.label || '1S Li-Po',
      sublabel: batteryNode?.sublabel || '3.7V · 800mAh',
      category: 'power',
    });

    const rId = regulatorNode?.id || 'regulator';
    nodes.push({
      id: rId,
      x: 50,
      y: 300,
      w: 170,
      h: 70,
      label: regulatorNode?.label || 'AP63203WU-7',
      sublabel: regulatorNode?.sublabel || 'buck regulator',
      category: 'power',
    });

    edges.push({ from: vbusId, to: cId, label: '5V', type: 'power' });
    edges.push({ from: cId, to: bId, label: 'charge', type: 'power' });
    edges.push({ from: cId, to: rId, label: 'VSYS', type: 'power' });
    edges.push({ from: rId, to: 'rail', label: railVoltageStr, type: 'rail' });
  } else {
    // Case C: DC or USB direct to regulator (no battery)
    const inNode = dcInputNode || usbInputNode || powerNodes[0];
    const inId = inNode?.id || 'vin';
    nodes.push({
      id: inId,
      x: 50,
      y: 90,
      w: 180,
      h: 75,
      label: inNode?.label || 'DC Input',
      sublabel: inNode?.sublabel || '5V / DC supply',
      category: 'power',
    });

    const rId = regulatorNode?.id || 'regulator';
    nodes.push({
      id: rId,
      x: 50,
      y: 240,
      w: 180,
      h: 75,
      label: regulatorNode?.label || 'Voltage Regulator',
      sublabel: regulatorNode?.sublabel || 'step-down regulator',
      category: 'power',
    });

    edges.push({ from: inId, to: rId, label: 'VIN', type: 'power' });
    edges.push({ from: rId, to: 'rail', label: railVoltageStr, type: 'rail' });
  }

  // 2. Load peripherals
  const loadNodes = graph.nodes.filter(
    (n) => n.category !== 'power' && !nodes.some((pn) => pn.id === n.id)
  );

  const numLoads = Math.max(loadNodes.length, 4);
  const railHeight = Math.max(260, Math.ceil(numLoads / 2) * 85);

  nodes.push({
    id: 'rail',
    x: 360,
    y: 240,
    w: 30,
    h: railHeight,
    label: railVoltageStr,
    sublabel: 'rail',
    category: 'rail',
  });

  // Grid layout for loads: 2 columns
  for (let i = 0; i < loadNodes.length; i++) {
    const load = loadNodes[i];
    if (!load) continue;
    const col = i % 2; // 0 = left load column (470), 1 = right load column (650)
    const row = Math.floor(i / 2);
    const x = col === 0 ? 470 : 650;
    const y = 240 + row * 80;
    const loadId = `load_${load.id}`;

    nodes.push({
      id: loadId,
      x,
      y,
      w: 150,
      h: 60,
      label: load.label,
      sublabel: load.sublabel,
      category: load.category,
    });

    edges.push({
      from: 'rail',
      to: loadId,
      label: railVoltageStr,
      type: 'rail',
    });
  }

  const legend: DiagramLegend[] = [
    { color: '#075F69', label: 'Power path' },
    { color: '#019893', label: '3.3V rail distribution' },
  ];

  const totalHeight = Math.max(640, 300 + Math.ceil(loadNodes.length / 2) * 80 + 40);

  return {
    title: 'Power Tree',
    figure: 'Figure 2 — Power tree',
    caption: 'Power distribution tree detailing voltage conversion, battery charging, and peripheral power rails.',
    width: 1000,
    height: totalHeight,
    nodes,
    edges,
    legend,
  };
}

/**
 * 03 — Protocol / Interface Map Projection
 */
function projectProtocolMap(graph: CanonicalDesignGraph): ProjectedDiagram {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];

  const mcuNode = graph.nodes.find((n) => n.category === 'control') || graph.nodes[0];
  const storageNodes = graph.nodes.filter((n) => n.category === 'storage');
  const uiNodes = graph.nodes.filter((n) => n.category === 'ui');
  const otherPeripherals = graph.nodes.filter(
    (n) => n.id !== mcuNode?.id && n.category !== 'storage' && n.category !== 'ui' && n.category !== 'power'
  );

  // 1. Controller in center
  if (mcuNode) {
    nodes.push({
      id: mcuNode.id,
      x: 410,
      y: 290,
      w: 180,
      h: 90,
      label: mcuNode.label,
      sublabel: 'interface controller',
      category: mcuNode.category,
    });
  }

  // 2. Host / Programming interface on left
  const hasUsb = graph.nodes.some((n) => n.id.includes('usb') || n.label.toLowerCase().includes('usb'));
  if (hasUsb) {
    nodes.push({
      id: 'usbc',
      x: 60,
      y: 300,
      w: 170,
      h: 70,
      label: 'USB-C',
      sublabel: 'native USB · flash + debug',
      category: 'power',
    });
    if (mcuNode) {
      edges.push({ from: 'usbc', to: mcuNode.id, label: 'USB', type: 'usb' });
    }
  } else {
    nodes.push({
      id: 'debug_header',
      x: 60,
      y: 300,
      w: 170,
      h: 70,
      label: 'SWD / Debug Header',
      sublabel: 'SWDIO / SWCLK flash + debug',
      category: 'control',
    });
    if (mcuNode) {
      edges.push({ from: 'debug_header', to: mcuNode.id, label: 'SWD', type: 'gpio' });
    }
  }

  // 3. Storage nodes on Top Right
  let topX = 500;
  for (const sNode of storageNodes) {
    nodes.push({
      id: sNode.id,
      x: topX,
      y: 70,
      w: 180,
      h: 70,
      label: sNode.label,
      sublabel: sNode.sublabel,
      category: sNode.category,
    });
    if (mcuNode) {
      edges.push({ from: mcuNode.id, to: sNode.id, label: 'SDMMC', type: 'sdmmc' });
    }
    topX += 230;
  }

  // 4. Peripherals on Right Column
  let rightY = 210;
  for (const pNode of otherPeripherals) {
    nodes.push({
      id: pNode.id,
      x: 770,
      y: rightY,
      w: 180,
      h: 60,
      label: pNode.label,
      sublabel: pNode.sublabel,
      category: pNode.category,
    });

    const edge = graph.edges.find(
      (e) => (e.from === mcuNode?.id && e.to === pNode.id) || (e.from === pNode.id && e.to === mcuNode?.id)
    );
    const busType = edge?.type || 'i2c';

    if (mcuNode) {
      edges.push({
        from: mcuNode.id,
        to: pNode.id,
        label: edge?.label || busType.toUpperCase(),
        type: busType,
        dashed: edge?.dashed,
      });
    }

    rightY += 75;
  }

  // 5. UI nodes on Bottom
  let bottomX = 300;
  for (const uNode of uiNodes) {
    nodes.push({
      id: uNode.id,
      x: bottomX,
      y: Math.max(540, rightY + 20),
      w: 170,
      h: 60,
      label: uNode.label,
      sublabel: uNode.sublabel,
      category: uNode.category,
    });
    if (mcuNode) {
      edges.push({ from: mcuNode.id, to: uNode.id, label: 'GPIO/PWM', type: 'gpio' });
    }
    bottomX += 230;
  }

  const legend: DiagramLegend[] = [
    { color: '#20E6E0', label: 'I²S — digital MEMS audio' },
    { color: '#019893', label: 'SDMMC / High-speed bus' },
    { color: '#9CD7D5', label: 'I²C — sensor & peripheral bus' },
    { color: '#021316', label: 'USB — native flash / debug' },
    { color: '#075F69', label: 'GPIO / PWM — LEDs · buttons' },
  ];

  const totalHeight = Math.max(660, rightY + 120);

  return {
    title: 'Protocol / Interface Map',
    figure: 'Figure 3 — Protocol / interface map',
    caption: 'Each peripheral grouped by bus interface and assigned controller pin domains.',
    width: 1000,
    height: totalHeight,
    nodes,
    edges,
    legend,
  };
}
