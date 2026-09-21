# SVG → Alight Motion XML v2

Engine SVG ke XML Alight Motion sekarang hanya memiliki **dua mode**:

1. **Maximum Fidelity** — pipeline strict yang mempertahankan z-order, native stroke, gradient, clipPath geometris, group opacity, dan presisi tinggi.
2. **Small Patch Cleanup** — memakai pipeline Maximum Fidelity yang sama, lalu hanya membuang island/subpath SVG yang sangat kecil. Tidak ada color grouping, node reduction, atau penghapusan stroke.

Engine lama `optimized`, `accurate`, `balanced`, dan `lightweight` tidak lagi tersedia sebagai mode eksekusi. Nilai quality lama/asing akan fallback ke Maximum Fidelity.

## Endpoint

### Daftar engine — GET publik

```http
GET /api/v1/engines
```

Response berisi ID engine, alias, dan opsi yang didukung. Endpoint ini CORS public dan tidak memerlukan API key.

### Convert — GET

Cocok untuk SVG kecil yang aman dimasukkan ke query string:

```http
GET /api/v1/convert?engine=small-patch-cleanup&svg=%3Csvg...%3E
x-api-key: amx_live_...
```

Tambahkan `raw=1` atau header `Accept: application/xml` untuk menerima XML langsung.

> GET memiliki batas panjang URL dari browser/CDN. Untuk SVG normal/besar gunakan POST.

### Convert — POST

```http
POST /api/v1/convert
Content-Type: application/json
x-api-key: amx_live_...
```

Maximum Fidelity:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "maximum-fidelity",
    "requireExact": true
  }
}
```

Small Patch Cleanup:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "small-patch-cleanup",
    "patchAreaPercent": 0.002,
    "protectThinPercent": 3.5
  }
}
```

### Engine IDs dan alias

- `lossless`, `maximum-fidelity`, `maximum` → Maximum Fidelity.
- `patch-clean`, `small-patch`, `small-patch-cleanup` → Small Patch Cleanup.

## API key

Website resmi memakai `POST /api/convert` secara same-origin tanpa mengekspos secret.

Integrasi website/app lain memakai `/api/v1/convert` dan wajib mengirim API key lewat header:

```env
SVG2XML_API_KEY=amx_live_xxx
```

atau multi-key:

```env
SVG2XML_API_KEYS=site-a=amx_live_xxx,site-b=amx_live_yyy
```

Jangan taruh API key di JavaScript frontend publik. Simpan key di backend/serverless website pemanggil.

## CORS

Opsional batasi origin browser:

```env
API_ALLOWED_ORIGINS=https://site-a.com,https://site-b.com
```

Jika kosong, API v1 menerima origin mana pun tetapi API key tetap wajib.

## Local check

```bash
npm install
npm run check
npm test
npx vercel dev
```

## Fidelity

Maximum Fidelity dapat menolak output dengan HTTP `422 FIDELITY_REQUIREMENT_FAILED` jika `requireExact: true` dan audit menemukan fitur SVG yang belum punya mapping 1:1.

Small Patch Cleanup secara sengaja menandai fidelity sebagai degraded bila ada patch yang benar-benar dibuang, dan mengembalikan statistik `cleanup.removedSubpaths`, `cleanup.removedShapes`, dan `cleanup.removedNodes`.
