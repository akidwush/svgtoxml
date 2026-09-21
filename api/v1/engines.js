const catalog = {
  ok: true,
  version: '2.0.0',
  engines: [
    {
      id: 'maximum-fidelity',
      quality: 'lossless',
      aliases: ['lossless', 'maximum'],
      description: 'Strict fidelity pipeline: source order, native stroke, gradient, clipPath and group opacity preserved.',
      options: ['title', 'duration', 'fps', 'groupingMode', 'detectPrimitives', 'validateBounds', 'requireExact']
    },
    {
      id: 'small-patch-cleanup',
      quality: 'patch-clean',
      aliases: ['patch-clean', 'small-patch'],
      description: 'Maximum Fidelity pipeline plus aggressive compact micro-patch removal; elongated thin details remain protected; no grouping or node reduction.',
      options: ['title', 'duration', 'fps', 'groupingMode', 'detectPrimitives', 'patchAreaPercent', 'protectThinPercent']
    }
  ],
  controls: {
    groupingMode: ['nested', 'flat'],
    detectPrimitives: true,
    primitiveTypes: ['rect', 'circle', 'ellipse'],
    primitiveFallback: 'path',
    fps: { min: 1, max: 240, default: 30 },
    durationMs: { min: 100, max: 600000, default: 1000 },
    smallPatchCleanup: { patchAreaPercent: 0.01, protectThinPercent: 2.0, thinAspectRatio: 6 }
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
