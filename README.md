# SVG → Alight Motion XML v2

Engine SVG ke XML Alight Motion sekarang memiliki **tiga mode**:

1. **Maximum Fidelity** — pipeline strict yang mempertahankan z-order, native stroke, gradient, clipPath geometris, group opacity, dan presisi tinggi.
2. **Small Patch Cleanup** — memakai pipeline Maximum Fidelity yang sama, lalu hanya membuang island/subpath SVG yang sangat kecil.
3. **Color Groups** — memakai parser geometri Maximum Fidelity, lalu menggabungkan shape dengan paint identik. Untuk SVG solid sederhana, 100 shape dengan 10 warna dapat menjadi 10 layer warna di dalam satu group XML.

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
    "patchAreaPercent": 0.01,
    "protectThinPercent": 2.0
  }
}
```

Color Groups:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "color-groups"
  }
}
```

Color Groups hanya menggabungkan paint yang aman dan identik. Gradient, clipPath, dan shape transparan yang berisiko mengubah compositing tetap diisolasi. Jika warna yang sama muncul berselang-seling pada z-order asli, response mengembalikan `colorGrouping.zOrderBarriers` sebagai warning audit.

### Engine IDs dan alias

- `lossless`, `maximum-fidelity`, `maximum` → Maximum Fidelity.
- `patch-clean`, `small-patch`, `small-patch-cleanup` → Small Patch Cleanup.
- `color-groups`, `color-group`, `group-by-color`, `color-layers` → Color Groups.


## Control Surface v2.1

Maximum Fidelity dan Small Patch Cleanup menerima kontrol export berikut melalui `options`:

- `duration` (ms)
- `fps`
- `groupingMode`: `nested` atau `flat`
- `detectPrimitives`: boolean

Primitive detection bersifat konservatif: hanya shape sederhana yang aman dipetakan ke primitive native Alight Motion; bentuk lain otomatis fallback ke path agar visual tetap diprioritaskan.

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

Color Groups mengembalikan `colorGrouping.sourceShapes`, `colorGrouping.colorLayers`, `colorGrouping.mergedShapes`, dan `colorGrouping.zOrderBarriers`. Tujuan engine ini adalah struktur layer ringkas: satu paint solid identik menjadi satu layer bila aman digabung.
