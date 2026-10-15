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

test('health advertises active v3 engines and GET/POST API', async () => {
  const response = await healthHandler.fetch(new Request('https://example.test/api/health'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, '3.0.1');
  assert.deepEqual(body.engines, ['maximum-fidelity', 'color-groups', 'small-patch-cleanup']);
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
  assert.equal(body.version, '3.0.1');
  assert.deepEqual(body.engines.map((engine) => engine.id), ['maximum-fidelity', 'color-groups', 'small-patch-cleanup']);
  const patchEngine = body.engines.find((engine) => engine.id === 'small-patch-cleanup');
  assert.equal(patchEngine.quality, 'patch-clean');
  assert.deepEqual(patchEngine.aliases, ['patch-clean', 'small-patch']);
  assert.ok(patchEngine.options.includes('patchAreaPercent'));
  assert.ok(patchEngine.options.includes('protectThinPercent'));
  assert.deepEqual(body.controls.smallPatchCleanup, { patchAreaPercent: 0.01, protectThinPercent: 2, thinAspectRatio: 6 });
  assert.equal(body.controls.colorGroups.engine, 'smart-color-groups');
  assert.equal(body.controls.colorGroups.alightImportSafe, true);
  assert.equal(body.controls.compatibility.allEnginesValidated, true);
  assert.equal(body.controls.compatibility.failClosed, true);
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

test('unknown engine still returns ENGINE_NOT_SUPPORTED instead of silently changing modes', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const svg = encodeURIComponent('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
    const response = await v1ConvertHandler.fetch(new Request(
      `https://example.test/api/v1/convert?engine=unknown-engine&svg=${svg}`,
      { headers: { 'x-api-key': 'amx_live_test-secret' } }
    ));
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'ENGINE_NOT_SUPPORTED');
    assert.equal(body.engine, 'unknown-engine');
  });
});

test('all Patch Cleanup aliases work over authenticated GET with cleanup parameters', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const svg = '<svg width="100" height="100"><rect width="80" height="80"/><rect id="dust" x="90" y="90" width=".5" height=".5"/></svg>';
    for (const alias of ['patch-clean', 'small-patch', 'small-patch-cleanup']) {
      for (const threshold of ['0', '0.05']) {
        const query = new URLSearchParams({ engine: alias, svg, patchAreaPercent: threshold, protectThinPercent: '3.5', title: 'Cleanup API', duration: '2000', fps: '60' });
        const response = await v1ConvertHandler.fetch(new Request(
          `https://example.test/api/v1/convert?${query}`,
          { headers: { 'x-api-key': 'amx_live_test-secret' } }
        ));
        assert.equal(response.status, 200, `${alias} threshold=${threshold}`);
        const body = await response.json();
        assert.equal(body.profile.engine, 'small-patch-cleanup');
        assert.equal(body.cleanup.patchAreaPercent, Number(threshold));
        assert.equal(body.cleanup.protectThinPercent, 3.5);
        assert.equal(body.cleanup.removedShapes, threshold === '0' ? 0 : 1);
        assert.equal(body.validation.compatibility.ok, true);
        assert.match(body.xml, /title="Cleanup API"/);
        assert.match(body.xml, /totalTime="2000" fps="60"/);
      }
    }
  });
});

test('Patch Cleanup works through website and authenticated POST handlers', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    for (const [handler, path] of [[publicConvertHandler, '/api/convert'], [v1ConvertHandler, '/api/v1/convert']]) {
      const response = await handler.fetch(new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.test', 'x-api-key': 'amx_live_test-secret' },
        body: JSON.stringify({
          svg: '<svg width="100" height="100"><rect width="80" height="80"/><rect id="dust" width=".5" height=".5"/></svg>',
          options: { quality: 'small-patch-cleanup', patchAreaPercent: 0.02, protectThinPercent: 4 }
        })
      }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.profile.quality, 'patch-clean');
      assert.equal(body.cleanup.patchAreaPercent, 0.02);
      assert.equal(body.cleanup.protectThinPercent, 4);
      assert.equal(body.cleanup.removedShapes, 1);
      assert.equal(body.profile.alightImportSafe, true);
    }
  });
});

test('Patch Cleanup raw XML export remains supported and authenticated', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const query = new URLSearchParams({ engine: 'small-patch-cleanup', raw: '1', svg: '<svg width="100" height="100"><rect width="80" height="80"/></svg>' });
    const url = `https://example.test/api/v1/convert?${query}`;
    const denied = await v1ConvertHandler.fetch(new Request(url));
    assert.equal(denied.status, 401);
    const response = await v1ConvertHandler.fetch(new Request(url, { headers: { 'x-api-key': 'amx_live_test-secret' } }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/xml/);
    assert.match(await response.text(), /Small Patch Cleanup/);
  });
});

test('external GET supports Color Groups engine', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const svg = encodeURIComponent('<svg width="20" height="10"><rect width="8" height="10" fill="red"/><rect x="10" width="8" height="10" fill="red"/></svg>');
    const response = await v1ConvertHandler.fetch(new Request(
      `https://example.test/api/v1/convert?engine=color-groups&svg=${svg}`,
      { headers: { 'x-api-key': 'amx_live_test-secret' } }
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile.quality, 'color-group');
    assert.equal(body.profile.engine, 'smart-color-groups');
    assert.equal(body.profile.version, '3.0.1');
    assert.equal(body.profile.alightImportSafe, true);
    assert.equal(body.grouping.groupedColors, 1);
    assert.equal(body.grouping.outputLayers, 1);
    assert.match(body.xml, /outTime="1000"/);
    assert.match(body.xml, /<fillColor value="#FF000000" \/>/);
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
    assert.equal(body.profile.alightImportSafe, true);
    assert.equal(body.validation.compatibility.ok, true);
    assert.equal(body.validation.compatibility.profile, 'alight-5.0.273-android-ff106');
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
