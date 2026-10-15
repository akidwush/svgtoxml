const catalog = {
  ok: true,
  version: '3.0.0',
  engines: [
    {
      id: 'maximum-fidelity',
      quality: 'lossless',
      aliases: ['lossless', 'maximum'],
      description: 'Strict fidelity pipeline: source order, native stroke, gradient, clipPath and group opacity preserved.',
      options: ['title', 'duration', 'fps', 'groupingMode', 'detectPrimitives', 'validateBounds', 'requireExact']
    },
    {
      id: 'color-groups',
      quality: 'color-group',
      aliases: ['color-group', 'group-by-color', 'color-fidelity'],
      description: 'Scene-aware effective-paint grouping with topology checks, z-order conflict detection, safe fallback layers, and unmerged source geometry.',
      options: ['title', 'duration', 'fps']
    }
  ],
  controls: {
    groupingMode: ['nested', 'flat'],
    detectPrimitives: true,
    primitiveTypes: ['rect', 'circle', 'ellipse'],
    primitiveFallback: 'path',
    fps: { min: 1, max: 240, default: 30 },
    durationMs: { min: 100, max: 600000, default: 1000 },
    colorGroups: {
      engine: 'smart-color-groups',
      strategy: 'strict-one-color',
      geometryMerged: false,
      preservesInternalShapes: true,
      zOrderAudit: 'topology-aware',
      alightImportSafe: true
    },
    compatibility: {
      contract: 'alight-xml-compatibility-v1',
      profile: 'alight-5.0.273-android-ff106',
      allEnginesValidated: true,
      failClosed: true
    }
  },
  convert: {
    endpoint: '/api/v1/convert',
    methods: ['GET', 'POST'],
    auth: 'x-api-key or Authorization: Bearer',
    rawXml: '?raw=1 or Accept: application/xml'
  }
};

function headers() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Gunakan GET.' }), {
        status: 405,
        headers: headers()
      });
    }
    return new Response(JSON.stringify(catalog), { status: 200, headers: headers() });
  }
};
