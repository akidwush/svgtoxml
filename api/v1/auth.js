import { authenticateApiKey, apiKeyStatus } from '../../lib/api-auth.js';
import { corsHeaders, externalOriginAllowed, jsonResponse } from '../../lib/api-http.js';

async function handle(request) {
  if (request.method === 'OPTIONS') {
    if (!externalOriginAllowed(request)) {
      return jsonResponse(request, { ok: false, error: 'Origin tidak diizinkan untuk API ini.', code: 'ORIGIN_NOT_ALLOWED' }, 403, 'external');
    }
    return new Response(null, { status: 204, headers: corsHeaders(request, 'external') });
  }

  if (!externalOriginAllowed(request)) {
    return jsonResponse(request, { ok: false, error: 'Origin tidak diizinkan untuk API ini.', code: 'ORIGIN_NOT_ALLOWED' }, 403, 'external');
  }

  if (request.method !== 'GET') {
    return jsonResponse(request, { ok: false, error: 'Gunakan GET.', code: 'METHOD_NOT_ALLOWED' }, 405, 'external');
  }

  const auth = authenticateApiKey(request);
  if (!auth.ok) {
    return jsonResponse(request, { ok: false, error: auth.error, code: auth.code }, auth.status, 'external');
  }

  const status = apiKeyStatus();
  return jsonResponse(request, {
    ok: true,
    service: 'svg2xml-alight',
    apiVersion: 'v1',
    authenticated: true,
    keyId: auth.keyId,
    configuredKeys: status.count
  }, 200, 'external', { 'X-API-Key-Id': auth.keyId });
}

export default { fetch: handle };
