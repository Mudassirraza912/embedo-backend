import { stripJsonFences, safeParseOrRepairJson } from '../../src/modules/sessions/pipeline/json-utils.js';

describe('json-utils', () => {
  it('strips markdown code fences', () => {
    expect(stripJsonFences('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(stripJsonFences('```\n{"a": 1}\n```')).toBe('{"a": 1}');
    expect(stripJsonFences('{"a": 1}')).toBe('{"a": 1}');
  });

  it('parses valid json directly', () => {
    const res = safeParseOrRepairJson('{"test": 123, "arr": [1, 2, 3]}');
    expect(res).toEqual({ test: 123, arr: [1, 2, 3] });
  });

  it('repairs json truncated inside a string', () => {
    const truncated = '{"title": "My Project", "description": "This is an unfinished';
    const res = safeParseOrRepairJson(truncated) as any;
    expect(res.title).toBe('My Project');
    expect(res.description).toContain('This is an unfinished');
  });

  it('repairs json truncated inside an array', () => {
    const truncated = '{"name": "test", "items": [{"id": 1}, {"id": 2';
    const res = safeParseOrRepairJson(truncated) as any;
    expect(res.name).toBe('test');
    expect(res.items[0]).toEqual({ id: 1 });
  });

  it('prunes incomplete bom or node object when truncated in the middle of item', () => {
    const truncated = `{
      "projectMeta": {"name": "Test"},
      "bom": [
        {"partNumber": "P1", "manufacturer": "M1", "category": "C1", "description": "D1", "qty": 1},
        {"partNumber": "P2", "manufacturer": "M2"
    `;
    const res = safeParseOrRepairJson(truncated) as any;
    expect(res.bom).toHaveLength(1);
    expect(res.bom[0].partNumber).toBe('P1');
  });
});
