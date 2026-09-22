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
  const powerInputStr = powerNodes.find((n) => n.label.includes('9V') || n.label.includes('12V') || n.label.includes('24V'))
    ? '9V – 24V DC Input'
    : powerNodes.find((n) => n.id.includes('bat'))
    ? '3.7V Li-Po / 5V USB-C'
    : '5V USB-C / DC Input';

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

  const refineSuggestions: string[] = [
    'Add battery backup',
    'Add Wi-Fi connectivity',
    'Optimize for low power',
    'Add tamper detection',
    'Change to PoE',
    'Add enclosure sensor',
  ];

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

  // 1. Power Source / Inputs
  nodes.push({
    id: 'vbus',
    x: 50,
    y: 50,
    w: 170,
    h: 70,
    label: 'USB-C VBUS',
    sublabel: '5V input',
    category: 'power',
  });

  nodes.push({
    id: 'charger',
    x: 50,
    y: 170,
    w: 170,
    h: 80,
    label: 'BQ25186',
    sublabel: '1-cell charger',
    category: 'power',
  });

  nodes.push({
    id: 'battery',
    x: 270,
    y: 170,
    w: 160,
    h: 80,
    label: '1S Li-Po',
    sublabel: '3.7V · 800mAh',
    category: 'power',
  });

  nodes.push({
    id: 'regulator',
    x: 50,
    y: 300,
    w: 170,
    h: 70,
    label: 'AP63203WU-7',
    sublabel: 'buck regulator',
    category: 'power',
  });

  // 2. Load peripherals
  const loadNodes = graph.nodes.filter(
    (n) => n.category !== 'power' && n.id !== 'vbus' && n.id !== 'charger' && n.id !== 'battery'
  );

  const numLoads = Math.max(loadNodes.length, 4);
  const railHeight = Math.max(260, Math.ceil(numLoads / 2) * 85);

  nodes.push({
    id: 'rail',
    x: 360,
    y: 300,
    w: 30,
    h: railHeight,
    label: '3.3V',
    sublabel: 'rail',
    category: 'rail',
  });

  // Base power edges
  edges.push({ from: 'vbus', to: 'charger', label: '5V', type: 'power' });
  edges.push({ from: 'charger', to: 'battery', label: 'charge', type: 'power' });
  edges.push({ from: 'charger', to: 'regulator', label: 'VSYS', type: 'power' });
  edges.push({ from: 'regulator', to: 'rail', label: '3.3V', type: 'rail' });

  // Grid layout for loads: 2 columns
  for (let i = 0; i < loadNodes.length; i++) {
    const load = loadNodes[i];
    if (!load) continue;
    const col = i % 2; // 0 = left load column (470), 1 = right load column (650)
    const row = Math.floor(i / 2);
    const x = col === 0 ? 470 : 650;
    const y = 300 + row * 80;
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
      label: '3.3V',
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

  // 2. USB-C on left
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
