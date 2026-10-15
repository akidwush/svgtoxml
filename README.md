# SVG → Alight Motion XML v3.0.0

Converter SVG ke XML Alight Motion dengan dua engine aktif:

1. **Maximum Fidelity** — mempertahankan source order, path, native stroke, gradient, clipPath, transform, dan hierarchy sejauh schema Alight Motion yang tervalidasi mendukungnya.
2. **Smart Color Groups** — menargetkan satu effective solid color yang aman sebagai satu layer, tanpa menggabungkan geometri source path.

Semua output melewati compatibility validator secara fail-closed sebelum dikembalikan.

## Engine

### Maximum Fidelity

Gunakan `maximum-fidelity`, `lossless`, atau `maximum`.

- source order dipertahankan;
- source shape tidak digabung;
- gradient dan stroke memakai mapping native yang telah divalidasi;
- clipPath yang dapat di-resolve dipertahankan sebagai mask vector;
- group opacity dapat dipertahankan melalui nested scene;
- `requireExact: true` menolak output bila audit menemukan loss yang diketahui.

### Smart Color Groups

Gunakan `color-groups`, `color-group`, `group-by-color`, atau `color-fidelity`.

Kontrak default: `strict-one-color`.

- identitas warna berasal dari effective rendered paint, bukan raw `fill` saja;
- syntax ekuivalen seperti `#fff`, `#ffffff`, `rgb(255,255,255)`, dan `hsl(0 0% 100%)` memakai canonical color yang sama;
- CSS, presentation attribute, inherited fill, `currentColor`, dan opacity dianalisis;
- gradient, stroke, partial alpha, clip, mask, filter, marker, dan blend mode tidak dipaksa masuk color layer;
- bounds hanya menjadi broad phase; path topology menjadi narrow phase;
- touching dibedakan dari positive-area overlap;
- z-order lintas warna dibangun sebagai constraint graph;
- konflik A–B–A dilaporkan lewat `grouping.zOrderConflicts` dan `grouping.groupingExact`;
- setiap source shape tetap individual di dalam layer warna (`geometryMerged: false`).

Metadata ringkas tersedia pada `grouping`, termasuk candidate paint, fallback reason histogram, geometry checks, actual overlaps, touching pairs, constraints, dan conflict count.

## Endpoint

### Daftar engine

```http
GET /api/v1/engines
```

Endpoint ini publik dan CORS-ready.

### Convert — GET

```http
GET /api/v1/convert?engine=color-groups&svg=%3Csvg...%3E
x-api-key: amx_live_...
```

Tambahkan `raw=1` atau header `Accept: application/xml` untuk menerima XML langsung. Gunakan POST untuk SVG normal atau besar karena URL browser/CDN terbatas.

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

Smart Color Groups:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "color-groups"
  }
}
```

Engine yang tidak dikenal menghasilkan `ENGINE_NOT_SUPPORTED`; tidak ada fallback diam-diam.

## Migration v3

Small Patch Cleanup telah dihapus. Alias berikut tidak lagi didukung:

- `patch-clean`
- `small-patch`
- `small-patch-cleanup`

Request lama harus dimigrasikan secara eksplisit ke Maximum Fidelity atau Smart Color Groups sesuai kebutuhan; server tidak otomatis memilih engine lain.

## Control Surface

Maximum Fidelity menerima:

- `duration` (ms)
- `fps`
- `groupingMode`: `nested` atau `flat`
- `detectPrimitives`: boolean
- `validateBounds`: boolean
- `requireExact`: boolean

Smart Color Groups menerima `title`, `duration`, dan `fps`. Strategi grouping tetap konservatif dan tidak menyediakan near-color merge secara default.

## API key

Website resmi memakai `POST /api/convert` secara same-origin tanpa mengekspos secret. Integrasi lain memakai `/api/v1/convert` dengan API key di header.

```env
SVG2XML_API_KEY=amx_live_xxx
```

atau:

```env
SVG2XML_API_KEYS=site-a=amx_live_xxx,site-b=amx_live_yyy
```

Jangan menaruh API key di JavaScript frontend publik.

## CORS

```env
API_ALLOWED_ORIGINS=https://site-a.com,https://site-b.com
```

Jika kosong, API v1 menerima origin mana pun tetapi API key tetap wajib.

## Local verification

```bash
npm install
npm run check
npm test
npm run benchmark:color-groups
```

Compatibility validation otomatis bukan pengganti uji import pada aplikasi Alight Motion nyata.
