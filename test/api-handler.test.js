import test from 'node:test';
import assert from 'node:assert/strict';
import publicConvertHandler from '../api/convert.js';
import healthHandler from '../api/health.js';
import v1ConvertHandler from '../api/v1/convert.js';
import v1AuthHandler from '../api/v1/auth.js';
import enginesHandler from '../api/v1/engines.js';

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('Vercel handlers expose Web Handler fetch()', () => {
  assert.equal(typeof publicConvertHandler?.fetch, 'function');
  assert.equal(typeof healthHandler?.fetch, 'function');
  assert.equal(typeof v1ConvertHandler?.fetch, 'function');
  assert.equal(typeof v1AuthHandler?.fetch, 'function');
  assert.equal(typeof enginesHandler?.fetch, 'function');
});

test('health advertises v2 engines and GET/POST API', async () => {
  const response = await healthHandler.fetch(new Request('https://example.test/api/health'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, '2.1.0');
  assert.deepEqual(body.engines, ['maximum-fidelity', 'small-patch-cleanup', 'color-groups']);
  assert.deepEqual(body.externalApiMethods, ['GET', 'POST']);
});

test('engine catalog is public and CORS-ready', async () => {
  const response = await enginesHandler.fetch(new Request('https://example.test/api/v1/engines', {
    headers: { origin: 'https://any-site.example' }
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.engines.length, 3);
});

test('public website endpoint remains same-origin POST only', async () => {
  const response = await publicConvertHandler.fetch(new Request('https://example.test/api/convert', {
    method: 'GET',
    headers: { origin: 'https://example.test' }
  }));
  assert.equal(response.status, 405);
});

test('external GET conversion requires API key', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const svg = encodeURIComponent('<svg width="10" height="10"><rect width="10" height="10"/></svg>');
    const response = await v1ConvertHandler.fetch(new Request(
      `https://example.test/api/v1/convert?engine=maximum-fidelity&svg=${svg}`
    ));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'API_KEY_REQUIRED');
  });
});

test('external GET conversion works for small SVG and engine alias', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const svg = encodeURIComponent('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const response = await v1ConvertHandler.fetch(new Request(
      `https://example.test/api/v1/convert?engine=small-patch-cleanup&patchAreaPercent=0.01&svg=${svg}`,
      { headers: { 'x-api-key': 'amx_live_test-secret' } }
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.profile.quality, 'patch-clean');
    assert.equal(body.api.authenticated, true);
  });
});


test('external GET conversion supports Color Groups engine', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const colors = ['red','green','blue','orange'];
    const shapes = Array.from({ length: 20 }, (_, i) =>
      `<rect x="${i}" y="0" width="1" height="1" fill="${colors[i % colors.length]}"/>`
    ).join('');
    const svg = encodeURIComponent(`<svg width="20" height="2">${shapes}</svg>`);
    const response = await v1ConvertHandler.fetch(new Request(
      `https://example.test/api/v1/convert?engine=color-groups&svg=${svg}`,
      { headers: { 'x-api-key': 'amx_live_test-secret' } }
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.profile.quality, 'color-groups');
    assert.equal(body.colorGrouping.sourceShapes, 20);
    assert.equal(body.colorGrouping.colorLayers, 4);
  });
});

test('external POST remains supported', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const response = await v1ConvertHandler.fetch(new Request('https://example.test/api/v1/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'amx_live_test-secret' },
      body: JSON.stringify({
        svg: '<svg width="10" height="10"><rect width="10" height="10"/></svg>',
        options: { quality: 'maximum-fidelity' }
      })
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile.quality, 'lossless');
  });
});

test('strict maximum fidelity still returns structured 422', async () => {
  const response = await publicConvertHandler.fetch(new Request('https://example.test/api/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.test' },
    body: JSON.stringify({
      svg: '<svg width="100" height="100"><text x="5" y="20">Nexora</text></svg>',
      options: { quality: 'maximum-fidelity', requireExact: true }
    })
  }));
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.code, 'FIDELITY_REQUIREMENT_FAILED');
  assert.equal(body.xml, undefined);
});
