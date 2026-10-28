# SVG → Alight Motion XML v3.1.0

Converter SVG ke XML Alight Motion dengan tiga engine aktif:

1. **Maximum Fidelity** — mempertahankan source order, path, native stroke, gradient, clipPath, transform, dan hierarchy sejauh schema Alight Motion yang tervalidasi mendukungnya.
2. **Smart Color Groups** — menargetkan satu effective solid color yang aman sebagai satu layer, tanpa menggabungkan geometri source path.
3. **Small Patch Cleanup** — memakai pipeline Maximum Fidelity lalu menghapus patch/island kecil, sambil melindungi detail panjang-tipis. Mode ini tetap terpisah dari Smart Color Groups.

Semua output melewati compatibility validator secara fail-closed sebelum dikembalikan.

## Perbaikan warna v3.1

Parser paint bersama kini memakai Culori dan CSS Tree pada server. Warna legacy
(hex, nama SVG, RGB/RGBA dan HSL/HSLA, termasuk huruf besar) serta warna CSS modern
(`hwb`, `lab`, `lch`, `oklab`, `oklch`, dan profil standar `color()`) dipetakan ke
ARGB sRGB 8-bit yang digunakan XML Alight Motion. Variabel CSS mempertahankan huruf
besar/kecil, fallback bertingkat, inheritance, `currentColor`, cascade `!important`,
dan selector list di dalam `:is()`/`:where()`. Ketiga mode memakai parser yang sama.
Warna stop gradient memakai konteks CSS stop/gradient, bukan warna shape pemakainya.
Offset dua stop gradient linear dipertahankan. Child dengan visibility eksplisit
tetap diproses meskipun container-nya tersembunyi.

Ini bukan janji seluruh spesifikasi SVG/future SVG dapat dipetakan 100% ke XML.
Warna di luar gamut sRGB, interpolasi gradient dengan color-space yang belum
dipetakan, fungsi warna belum didukung, dan CSS dinamis/kondisional dicatat sebagai
fidelity loss. `maximum-fidelity` dengan `requireExact: true` menolak hasil tersebut.
Tidak ada penggantian warna diam-diam agar hasil terlihat sukses, raster fallback,
atau penggabungan/pengurangan geometri baru. Batas multi-stop gradient, filter,
mask, pattern, teks dan animasi yang ada tetap berlaku.

Rincian, bukti dan batas pengujian: [SVG paint fidelity](docs/SVG_PAINT_FIDELITY.md).

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

## Experimental contour masks (optional, not production default)

For SVG compound paths where Alight Motion Edit Points displays long fan-shaped
connector lines, Maximum Fidelity and Small Patch Cleanup now accept
`compoundPathMode: "masks"` as an experimental POST option:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "maximum-fidelity",
    "compoundPathMode": "masks"
  }
}
```

This attempts to convert one closed outer contour and its disjoint inner holes
into an isolated Alight nested scene with editable per-hole shapes using
`blending="exclude"`. It preserves the source Bézier curves and avoids
fabricated bridge segments in those supported shapes. It does **not** promise
universal SVG topology: strokes, complex paint, disjoint islands, intersecting
contours, and unsupported nesting remain on the existing geometry path.

**The masks option has not been verified with the native Android Alight
renderer.** Keep the default `bridges` until device testing confirms correct
transparency, source ordering, layer isolation and edit-point behavior.

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

### Small Patch Cleanup (dipulihkan di v3.0.1)

Ketiga alias kembali didukung tanpa migrasi:

- `patch-clean`
- `small-patch`
- `small-patch-cleanup`

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

GET juga menerima `engine=small-patch-cleanup`, `patchAreaPercent`, dan `protectThinPercent`.

- `patchAreaPercent`: persentase luas scene; default `0.01`, rentang `0–0.25`. Nilai `0` menonaktifkan penghapusan. Alias opsi legacy `microDetailPercent` tetap diterima melalui POST.
- `protectThinPercent`: panjang minimum detail relatif terhadap sisi scene terpanjang; default `2`, rentang `0–100`. Rasio panjang:pendek minimal `6` agar detail dilindungi.
- Ukuran patch dihitung dari bounding box tiap subpath dalam koordinat scene, sesuai perilaku engine sebelumnya, bukan luas area terisi yang eksak.
- Urutan sumber, native stroke, gradient, clipPath, hierarchy, dan group opacity tetap memakai pipeline fidelity yang sama. Tidak ada grouping warna atau node simplification.
- `cleanup` memuat `removedSubpaths`, `removedShapes`, `removedNodes`, dan ambang yang digunakan. Penghapusan disengaja tercatat sebagai fidelity loss `small-patch-cleanup`.

Pemulihan ini tidak mengganti Smart Color Groups atau mengaktifkan cleanup pada engine lain. Nama engine asing tetap ditolak dengan `ENGINE_NOT_SUPPORTED`.

## Control Surface

Maximum Fidelity dan Small Patch Cleanup menerima `title`, `duration`, `fps`, `groupingMode`, dan `detectPrimitives`. Kontrol lengkap Maximum Fidelity:

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
