import { describe, it, expect } from '@jest/globals';
import { loadBundle, validateBundle } from '../../src/modules/hardware/hardware-import.service.js';
import { assertSafeModuleSvg, parseModuleSvg, UnsafeSvgError } from '../../src/modules/hardware/hardware-svg.js';
import { FIXTURE_DIR, FIXTURE_IDS } from './prototype-fixtures.js';

describe('hardware library import validation', () => {
  it('accepts every dev fixture bundle with no errors', async () => {
    for (const id of Object.values(FIXTURE_IDS)) {
      const { bundle, issues } = await loadBundle(FIXTURE_DIR, id);
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(bundle?.hardwareEntityId).toBe(id);
    }
  });

  it('flags the BME280 string power rail (plan C2) as a warning, not an error', async () => {
    const { bundle, issues } = await loadBundle(FIXTURE_DIR, FIXTURE_IDS.bme280);
    expect(bundle).not.toBeNull();
    expect(issues.some((i) => i.severity === 'warning' && /unstructured power rail/.test(i.message))).toBe(true);
  });

  it('rejects a record whose contact anchor is missing from the artwork', async () => {
    const { bundle } = await loadBundle(FIXTURE_DIR, FIXTURE_IDS.gps);
    const svg = bundle!.svg.replace(/<circle id="a-HW-FX04-JP1-5"[^>]*\/>/, '');
    const issues = validateBundle(bundle!.record, svg, bundle!.asset);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('a-HW-FX04-JP1-5'))).toBe(true);
  });

  it('parses anchor geometry, including whole-connector anchors', async () => {
    const { bundle } = await loadBundle(FIXTURE_DIR, FIXTURE_IDS.bme280);
    const parsed = parseModuleSvg(bundle!.svg);
    expect(parsed.width).toBeGreaterThan(0);
    expect(parsed.anchors.get('a-HW-FX03-CONN3')).toMatchObject({ whole: true, connectorId: 'HW-FX03:CONN3' });
    expect(parsed.anchors.get('a-HW-FX03-JP1-1')).toMatchObject({ whole: false, pinId: 'HW-FX03:VIN' });
  });

  it.each([
    ['<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', 'script'],
    ['<svg viewBox="0 0 10 10" onload="alert(1)"></svg>', 'event handler'],
    ['<svg viewBox="0 0 10 10"><image href="https://evil.example/x.png"/></svg>', 'external href'],
    ['<svg viewBox="0 0 10 10"><foreignObject/></svg>', 'foreignObject'],
    ['<html><svg/></html>', 'not an SVG'],
  ])('refuses unsafe artwork: %s', (svg, reason) => {
    expect(() => assertSafeModuleSvg(svg)).toThrow(UnsafeSvgError);
    try {
      assertSafeModuleSvg(svg);
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain(reason.toLowerCase().split(' ')[0]);
    }
  });
});
