import test from 'node:test';
import assert from 'node:assert/strict';
import publicConvertHandler from '../api/convert.js';
import healthHandler from '../api/health.js';
import v1ConvertHandler from '../api/v1/convert.js';
import v1AuthHandler from '../api/v1/auth.js';

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
});

test('health endpoint reports external API auth state without loading converter dependencies', async () => {
  await withEnv('SVG2XML_API_KEY', undefined, async () => {
    await withEnv('SVG2XML_API_KEYS', undefined, async () => {
      const response = await healthHandler.fetch(new Request('https://example.test/api/health'));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.version, '1.7.0');
      assert.equal(body.externalApiAuth, 'not-configured');
      assert.equal(body.configuredApiKeys, 0);
    });
  });
});

test('public website convert validates body without API key', async () => {
  const response = await publicConvertHandler.fetch(new Request('https://example.test/api/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.test' },
    body: JSON.stringify({ options: {} })
  }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, 'SVG_REQUIRED');
});

test('public website endpoint rejects cross-origin browser usage', async () => {
  const response = await publicConvertHandler.fetch(new Request('https://example.test/api/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://other.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ options: {} })
  }));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'USE_EXTERNAL_API');
});

test('external v1 API refuses requests until owner configures a key', async () => {
  await withEnv('SVG2XML_API_KEY', undefined, async () => {
    await withEnv('SVG2XML_API_KEYS', undefined, async () => {
      const response = await v1ConvertHandler.fetch(new Request('https://example.test/api/v1/convert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: {} })
      }));
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, 'API_KEY_NOT_CONFIGURED');
    });
  });
});

test('external v1 API rejects invalid API key', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const response = await v1ConvertHandler.fetch(new Request('https://example.test/api/v1/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-key' },
      body: JSON.stringify({ options: {} })
    }));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'INVALID_API_KEY');
  });
});

test('valid external API key reaches request body validation', async () => {
  await withEnv('SVG2XML_API_KEY', 'amx_live_test-secret', async () => {
    const response = await v1ConvertHandler.fetch(new Request('https://example.test/api/v1/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'amx_live_test-secret' },
      body: JSON.stringify({ options: {} })
    }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'SVG_REQUIRED');
  });
});

test('multi-key configuration identifies the client key', async () => {
  await withEnv('SVG2XML_API_KEY', undefined, async () => {
    await withEnv('SVG2XML_API_KEYS', 'site-a=amx_live_a,site-b=amx_live_b', async () => {
      const response = await v1AuthHandler.fetch(new Request('https://example.test/api/v1/auth', {
        method: 'GET',
        headers: { 'x-api-key': 'amx_live_b' }
      }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.keyId, 'site-b');
      assert.equal(body.configuredKeys, 2);
    });
  });
});
