import { describe, it, expect } from '@jest/globals';
import { compactSpecsForPrompt } from '../../src/modules/sessions/pipeline/rag-grounder.js';

describe('compactSpecsForPrompt', () => {
  const bulky = {
    // written BEFORE the ratings in real ingestion output — the case that broke a blind slice(0, 1200)
    figureCaptions: Array.from({ length: 80 }, (_, i) => ({ caption: `Figure ${i}. some long descriptive caption text here`, pageNumber: i })),
    _provenance: { datasheetUrl: 'https://x', ingestedAt: 'now' },
    absoluteMaxRatings: { voltage: { min: -0.3, max: 7, unit: 'V' } },
    recommendedOperating: { voltage: { min: 2, typ: 3.3, max: 5.5, unit: 'V' } },
    pins: Array.from({ length: 10 }, (_, i) => ({ number: String(i + 1), name: `P${i}`, type: 'gpio', alternateFunctions: ['SPI'] })),
    registers: [{ address: '00h', name: 'Conversion', bitFields: new Array(50).fill({ bits: '1', name: 'x' }) }],
  };

  it('keeps recommendedOperating and absoluteMaxRatings even when bulky data precedes them', () => {
    const out = compactSpecsForPrompt(bulky);
    expect(out).toContain('"recommendedOperating"');
    expect(out).toContain('"absoluteMaxRatings"');
    expect(JSON.parse(out).recommendedOperating.voltage.typ).toBe(3.3);
  });

  it('omits captions and provenance, summarizes pins and registers', () => {
    const out = compactSpecsForPrompt(bulky);
    expect(out).not.toContain('figureCaptions');
    expect(out).not.toContain('_provenance');
    expect(out).toContain('1:P0(gpio)/SPI');
    expect(out).toContain('00h:Conversion');
    expect(out).not.toContain('bitFields');
  });

  it('always returns valid JSON within budget', () => {
    const out = compactSpecsForPrompt({ ...bulky, peripherals: Array.from({ length: 500 }, (_, i) => `periph-${i}`) });
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(4200);
    expect(out).toContain('recommendedOperating');
  });

  it('handles null / non-object specs', () => {
    expect(compactSpecsForPrompt(null)).toBe('{}');
  });

  it('includes per-mode current, interfaces, cautions and features after the ratings', () => {
    const out = compactSpecsForPrompt({
      ...bulky,
      powerModes: [{ mode: 'Active (TX)', typ: 240, max: 350, unit: 'mA', supplyVoltageV: 3.3 }, { mode: 'Deep-sleep', typ: 0.005, unit: 'mA' }],
      interfaces: [{ type: 'I2C', role: 'target', maxRate: 'up to 3.4 MHz', pullUpRequirement: 'external pull-up on SDA/SCL' }],
      cautions: [{ text: 'GPIO9 must not be pulled low at boot.', page: 30 }],
      features: ['Ultra-small packages', 'Wide supply range'],
    });
    const parsed = JSON.parse(out);
    expect(parsed.powerModes[0]).toContain('Active (TX): typ 240');
    expect(parsed.powerModes[0]).toContain('@3.3V');
    expect(parsed.interfaces[0]).toContain('external pull-up');
    expect(parsed.cautions[0]).toContain('GPIO9');
    expect(Object.keys(parsed).indexOf('recommendedOperating')).toBeLessThan(Object.keys(parsed).indexOf('powerModes'));
  });

  it('keeps rows that share a mode distinguishable by parameter and condition', () => {
    const out = compactSpecsForPrompt({
      powerModes: [
        { mode: 'active', parameter: 'TX', conditions: '802.11b, 1 Mbps, @21 dBm', typ: 335, unit: 'mA' },
        { mode: 'active', parameter: 'RX', conditions: '802.11b/g/n, HT20', typ: 84, unit: 'mA' },
      ],
    });
    const [tx, rx] = JSON.parse(out).powerModes as string[];
    expect(tx).toContain('TX');
    expect(tx).toContain('21 dBm');
    expect(rx).toContain('RX');
    expect(tx).not.toEqual(rx);
  });
});
