import { authenticateApiKey } from './api-auth.js';

function configuredOrigins() {
  return String(process.env.API_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestOrigin(request) {
  return String(request.headers.get('origin') || '').trim();
}

function sameOrigin(request) {
  const origin = requestOrigin(request);
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function externalOriginAllowed(request) {
  const origin = requestOrigin(request);
  if (!origin) return true;

  const allowed = configuredOrigins();
  if (!allowed.length || allowed.includes('*')) return true;
  return allowed.includes(origin);
}

export function corsHeaders(request, mode = 'external') {
  const origin = requestOrigin(request);
  const allowed = configuredOrigins();

  let allowOrigin = '*';
  if (mode === 'public') {
    allowOrigin = origin && sameOrigin(request) ? origin : new URL(request.url).origin;
  } else if (origin && allowed.length && !allowed.includes('*') && allowed.includes(origin)) {
    allowOrigin = origin;
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  };
}

export function jsonResponse(request, data, status = 200, mode = 'external', extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, mode),
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function publicRequestAllowed(request) {
  const secFetchSite = String(request.headers.get('sec-fetch-site') || '').toLowerCase();
  if (secFetchSite === 'cross-site') return false;
  return sameOrigin(request);
}

async function parseAndConvert(request, mode, authResult = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, {
      ok: false,
      error: 'Body wajib JSON yang valid.',
      code: 'INVALID_JSON'
    }, 400, mode);
  }

  const svg = body?.svg;
  if (typeof svg !== 'string') {
    return jsonResponse(request, {
      ok: false,
      error: 'Field "svg" wajib berupa string SVG.',
      code: 'SVG_REQUIRED'
    }, 400, mode);
  }

  const maxBytes = Math.max(
    1000,
    Number.parseInt(process.env.MAX_SVG_BYTES || '3000000', 10) || 3000000
  );
  const size = Buffer.byteLength(svg, 'utf8');
  if (size > maxBytes) {
    return jsonResponse(request, {
      ok: false,
      error: `SVG terlalu besar. Maksimum ${maxBytes} byte.`,
      code: 'SVG_TOO_LARGE'
    }, 413, mode);
  }

  let convertSvgToAlightXml;
  try {
    ({ convertSvgToAlightXml } = await import('./converter.js'));
  } catch (error) {
    console.error('[svg2xml] converter module load failed:', error);
    return jsonResponse(request, {
      ok: false,
      error: 'Modul converter gagal dimuat di server.',
      code: 'CONVERTER_LOAD_FAILED',
      detail: error?.message || String(error)
    }, 500, mode);
  }

  let result;
  try {
    result = convertSvgToAlightXml(svg, body.options || {});
  } catch (error) {
    if (error?.code !== 'FIDELITY_REQUIREMENT_FAILED') {
      console.error('[svg2xml] conversion failed:', error);
    }
    return jsonResponse(request, {
      ok: false,
      error: error?.message || 'Konversi gagal.',
      code: error?.code || 'CONVERSION_FAILED',
      ...(error?.fidelity ? { fidelity: error.fidelity } : {}),
      ...(error?.warnings ? { warnings: error.warnings } : {})
    }, 422, mode);
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get('raw') === '1' ||
    (request.headers.get('accept') || '').includes('application/xml');
  const authHeaders = authResult?.keyId ? { 'X-API-Key-Id': authResult.keyId } : {};

  if (raw) {
    return new Response(result.xml, {
      status: 200,
      headers: {
        ...corsHeaders(request, mode),
        ...authHeaders,
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="alight-motion.xml"'
      }
    });
  }

  const api = authResult?.keyId
    ? { version: 'v1', authenticated: true, keyId: authResult.keyId }
    : { version: 'public', authenticated: false };

  return jsonResponse(request, { ok: true, api, ...result }, 200, mode, authHeaders);
}

export function createConvertHandler({ mode }) {
  if (!['public', 'external'].includes(mode)) throw new Error(`Unknown API mode: ${mode}`);

  return async function handleRequest(request) {
    try {
      if (request.method === 'OPTIONS') {
        if (mode === 'external' && !externalOriginAllowed(request)) {
          return jsonResponse(request, { ok: false, error: 'Origin tidak diizinkan untuk API ini.', code: 'ORIGIN_NOT_ALLOWED' }, 403, mode);
        }
        if (mode === 'public' && !publicRequestAllowed(request)) {
          return jsonResponse(request, { ok: false, error: 'Endpoint website hanya untuk same-origin. Gunakan /api/v1/convert untuk integrasi eksternal.', code: 'USE_EXTERNAL_API' }, 403, mode);
        }
        return new Response(null, { status: 204, headers: corsHeaders(request, mode) });
      }

      if (request.method !== 'POST') {
        return jsonResponse(request, { ok: false, error: 'Gunakan POST.', code: 'METHOD_NOT_ALLOWED' }, 405, mode);
      }

      if (mode === 'public') {
        if (!publicRequestAllowed(request)) {
          return jsonResponse(request, { ok: false, error: 'Endpoint website hanya untuk same-origin. Gunakan /api/v1/convert dengan API key untuk integrasi eksternal.', code: 'USE_EXTERNAL_API' }, 403, mode);
        }
        return parseAndConvert(request, mode);
      }

      if (!externalOriginAllowed(request)) {
        return jsonResponse(request, { ok: false, error: 'Origin tidak diizinkan untuk API ini.', code: 'ORIGIN_NOT_ALLOWED' }, 403, mode);
      }

      const auth = authenticateApiKey(request);
      if (!auth.ok) {
        return jsonResponse(request, { ok: false, error: auth.error, code: auth.code }, auth.status, mode);
      }

      return parseAndConvert(request, mode, auth);
    } catch (error) {
      console.error('[svg2xml] unhandled API error:', error);
      return jsonResponse(request, { ok: false, error: 'Terjadi error internal pada API.', code: 'INTERNAL_ERROR', detail: error?.message || String(error) }, 500, mode);
    }
  };
}
