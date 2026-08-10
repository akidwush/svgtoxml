import crypto from 'node:crypto';
import { convertSvgToAlightXml } from '../lib/converter.js';

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const configured = String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let allowed = '*';
  if (configured.length) allowed = origin && configured.includes(origin) ? origin : configured[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff'
  };
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function suppliedApiKey(request) {
  const direct = request.headers.get('x-api-key');
  if (direct) return direct;
  const auth = request.headers.get('authorization') || '';
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
}

function secureEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== 'POST') return jsonResponse(request, { ok: false, error: 'Gunakan POST.' }, 405);

  const expectedKey = process.env.SVG2XML_API_KEY || '';
  if (expectedKey && !secureEqual(suppliedApiKey(request), expectedKey)) {
    return jsonResponse(request, { ok: false, error: 'API key tidak valid.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { ok: false, error: 'Body wajib JSON yang valid.' }, 400);
  }

  const svg = body?.svg;
  if (typeof svg !== 'string') return jsonResponse(request, { ok: false, error: 'Field "svg" wajib berupa string SVG.' }, 400);

  const maxBytes = Math.max(1000, Number.parseInt(process.env.MAX_SVG_BYTES || '3000000', 10) || 3000000);
  const size = Buffer.byteLength(svg, 'utf8');
  if (size > maxBytes) return jsonResponse(request, { ok: false, error: `SVG terlalu besar. Maksimum ${maxBytes} byte.` }, 413);

  try {
    const result = convertSvgToAlightXml(svg, body.options || {});
    const url = new URL(request.url);
    const raw = url.searchParams.get('raw') === '1' || (request.headers.get('accept') || '').includes('application/xml');
    if (raw) {
      return new Response(result.xml, {
        status: 200,
        headers: {
          ...corsHeaders(request),
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="alight-motion.xml"'
        }
      });
    }
    return jsonResponse(request, { ok: true, ...result });
  } catch (error) {
    return jsonResponse(request, { ok: false, error: error?.message || 'Konversi gagal.' }, 400);
  }
}
