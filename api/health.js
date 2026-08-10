export default function handler(request) {
  return new Response(JSON.stringify({
    ok: true,
    service: 'svg2xml-alight',
    version: '1.0.0',
    auth: process.env.SVG2XML_API_KEY ? 'api-key' : 'open'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
  });
}
