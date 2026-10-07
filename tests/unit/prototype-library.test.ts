import { describe, it, expect } from '@jest/globals';
import { prepareBundle, validateBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { assertSafeModuleSvg, parseModuleSvg, UnsafeSvgError } from '../../src/modules/hardware/hardware-svg.js';
import { buildEmbeddingSummary } from '../../src/modules/hardware/hardware-embedding.service.js';
import { FIXTURE_IDS, fixtureUpload } from './prototype-fixtures.js';

describe('hardware library upload validation', () => {
  it('accepts every fixture board with no errors', () => {
    for (const id of Object.values(FIXTURE_IDS)) {
      const { bundle, issues } = prepareBundle(fixtureUpload(id));
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(bundle?.hardwareEntityId).toBe(id);
    }
  });

  it('derives the asset metadata from the SVG when the upload has no asset.json', () => {
    const { bundle, issues } = prepareBundle(fixtureUpload(FIXTURE_IDS.gps, false));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(bundle!.asset.anchor_ids).toHaveLength(9);
    expect(bundle!.asset.generation_source_hash).toMatch(/^sha256:/);
    expect(bundle!.asset.validation_status).toBe('passed');
  });

  it('gives the same content hash however the record JSON is ordered', () => {
    const upload = fixtureUpload(FIXTURE_IDS.bme280);
    const reordered = { ...upload, record: Object.fromEntries(Object.entries(upload.record as Record<string, unknown>).reverse()) };
    expect(prepareBundle(reordered).bundle!.contentHash).toBe(prepareBundle(upload).bundle!.contentHash);
  });

  it('rejects a record that fails the v3.3 schema, with the field path', () => {
    const upload = fixtureUpload(FIXTURE_IDS.gps);
    const record = { ...(upload.record as Record<string, unknown>), pins: [] };
    const { bundle, issues } = prepareBundle({ ...upload, record });
    expect(bundle).toBeNull();
    expect(issues[0]!.message).toContain('record pins');
  });

  it('flags the BME280 string power rail (plan C2) as a warning, not an error', () => {
    const { bundle, issues } = prepareBundle(fixtureUpload(FIXTURE_IDS.bme280));
    expect(bundle).not.toBeNull();
    expect(issues.some((i) => i.severity === 'warning' && /unstructured power rail/.test(i.message))).toBe(true);
  });

  it('rejects a record whose contact anchor is missing from the artwork', () => {
    const { bundle } = prepareBundle(fixtureUpload(FIXTURE_IDS.gps));
    const svg = bundle!.svg.replace(/<circle id="a-HW-FX04-JP1-5"[^>]*\/>/, '');
    const issues = validateBundle(bundle!.record, svg, bundle!.asset);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('a-HW-FX04-JP1-5'))).toBe(true);
  });

  it('parses anchor geometry, including whole-connector anchors', () => {
    const parsed = parseModuleSvg(fixtureUpload(FIXTURE_IDS.bme280).svg);
    expect(parsed.width).toBeGreaterThan(0);
    expect(parsed.anchors.get('a-HW-FX03-CONN3')).toMatchObject({ whole: true, connectorId: 'HW-FX03:CONN3' });
    expect(parsed.anchors.get('a-HW-FX03-JP1-1')).toMatchObject({ whole: false, pinId: 'HW-FX03:VIN' });
  });

  it('builds a deterministic embedding summary from canonical facts only', () => {
    const { bundle } = prepareBundle(fixtureUpload(FIXTURE_IDS.bme280));
    const summary = buildEmbeddingSummary(bundle!.record);
    expect(summary).toBe(buildEmbeddingSummary(bundle!.record));
    expect(summary).toContain('Main silicon: BME280');
    expect(summary).toContain('I2C target (0x77, 0x76)');
    expect(summary).toContain('STEMMA QT / Qwiic');
    expect(summary).not.toMatch(/https?:\/\//);
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
