import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { buildInfo } from '../../src/config/build-info.js';

describe('build info', () => {
  it('a local run (placeholder build-info.json) reports the package version with "-local"', () => {
    expect(buildInfo.channel).toBe('local');
    expect(buildInfo.version).toMatch(/^\d+\.\d+\.\d+-local$/);
    expect(buildInfo.commit).toBeNull();
  });

  it('every response says which build answered it', async () => {
    const res = await request(createApp()).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['x-embedo-version']).toBe(buildInfo.version);
  });
});
