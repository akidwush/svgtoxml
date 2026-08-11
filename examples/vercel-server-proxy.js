// Contoh untuk WEBSITE LAIN yang di-host di Vercel.
// Simpan key di Environment Variable website pemanggil:
// SVGTOXML_ENGINE_KEY=amx_live_...
// Jangan taruh key di JavaScript browser publik.

export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false, error: 'Gunakan POST.' }), {
        status: 405,
        headers: { 'content-type': 'application/json; charset=utf-8' }
      });
    }

    const body = await request.text();
    const upstream = await fetch('https://svgtoxml.vercel.app/api/v1/convert', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.SVGTOXML_ENGINE_KEY
      },
      body
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }
};
