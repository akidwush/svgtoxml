import test from 'node:test';
import assert from 'node:assert/strict';
import convertHandler from '../api/convert.js';
import healthHandler from '../api/health.js';
import v1ConvertHandler from '../api/v1/convert.js';

test('Vercel handlers expose Web Handler fetch()', () => {
  assert.equal(typeof convertHandler?.fetch, 'function');
  assert.equal(typeof healthHandler?.fetch, 'function');
  assert.equal(typeof v1ConvertHandler?.fetch, 'function');
});

test('health endpoint returns JSON without loading converter dependencies', async () => {
  const response = await healthHandler.fetch(new Request('https://example.test/api/health'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, '1.4.0');
});

test('convert endpoint validates body before dynamic converter import', async () => {
  const response = await convertHandler.fetch(new Request('https://example.test/api/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ options: {} })
  }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'SVG_REQUIRED');
});
