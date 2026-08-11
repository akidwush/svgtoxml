import crypto from 'node:crypto';

function splitConfiguredKeys(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeKeyEntry(raw, index) {
  const separator = raw.indexOf('=');
  if (separator > 0) {
    const id = raw.slice(0, separator).trim();
    const key = raw.slice(separator + 1).trim();
    if (id && key) return { id, key };
  }
  return { id: `key-${index + 1}`, key: raw.trim() };
}

export function configuredApiKeys() {
  const entries = [];
  const legacy = String(process.env.SVG2XML_API_KEY || '').trim();
  if (legacy) entries.push({ id: 'default', key: legacy });

  for (const [index, raw] of splitConfiguredKeys(process.env.SVG2XML_API_KEYS).entries()) {
    const entry = normalizeKeyEntry(raw, index);
    if (entry.key) entries.push(entry);
  }

  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

export function suppliedApiKey(request) {
  const direct = String(request.headers.get('x-api-key') || '').trim();
  if (direct) return direct;

  const authorization = String(request.headers.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function timingSafeEqualText(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function authenticateApiKey(request) {
  const configured = configuredApiKeys();
  if (!configured.length) {
    return {
      ok: false,
      configured: false,
      status: 503,
      code: 'API_KEY_NOT_CONFIGURED',
      error: 'API eksternal belum diaktifkan. Owner harus mengatur SVG2XML_API_KEY atau SVG2XML_API_KEYS di Vercel.'
    };
  }

  const supplied = suppliedApiKey(request);
  if (!supplied) {
    return {
      ok: false,
      configured: true,
      status: 401,
      code: 'API_KEY_REQUIRED',
      error: 'API key wajib dikirim melalui header x-api-key atau Authorization: Bearer.'
    };
  }

  for (const entry of configured) {
    if (timingSafeEqualText(supplied, entry.key)) {
      return {
        ok: true,
        configured: true,
        status: 200,
        keyId: entry.id,
        keyCount: configured.length
      };
    }
  }

  return {
    ok: false,
    configured: true,
    status: 401,
    code: 'INVALID_API_KEY',
    error: 'API key tidak valid.'
  };
}

export function apiKeyStatus() {
  const configured = configuredApiKeys();
  return {
    configured: configured.length > 0,
    count: configured.length,
    ids: configured.map((entry) => entry.id)
  };
}
