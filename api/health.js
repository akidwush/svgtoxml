import { apiKeyStatus } from '../lib/api-auth.js';

async function health(request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get('deep') === '1';
  const keys = apiKeyStatus();

  const base = {
    ok: true,
    service: 'svg2xml-alight',
    version: '1.7.0',
    runtime: `node-${process.versions.node}`,
    publicWebEndpoint: '/api/convert',
    externalApiEndpoint: '/api/v1/convert',
    externalApiAuth: keys.configured ? 'api-key-required' : 'not-configured',
    configuredApiKeys: keys.count
  };

  if (deep) {
    try {
      const module = await import('../lib/converter.js');
      base.converter = typeof module.convertSvgToAlightXml === 'function' ? 'ready' : 'invalid-export';
      if (base.converter !== 'ready') base.ok = false;
    } catch (error) {
      console.error('[svg2xml] health deep import failed:', error);
      base.ok = false;
      base.converter = 'load-failed';
      base.detail = error?.message || String(error);
    }
  }

  return new Response(JSON.stringify(base), {
    status: base.ok ? 200 : 500,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
  });
}

export default { fetch: health };
