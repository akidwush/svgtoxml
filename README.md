# SVG → Alight Motion XML

Tool ringan untuk mengubah SVG menjadi XML scene Alight Motion. v1.4 memakai struktur `<scene>` + `<embedScene>` color groups + `<shape>` + `<transform>` + `<fillColor>` + `<path>`. Output sengaja tidak menulis `<path-stroke>`.

## Fokus converter

- Warna SVG dikonversi ke format Alight Motion `#AARRGGBB`.
- Mendukung path, rect, circle, ellipse, line, polygon, polyline, group transform, `<use>` dan CSS sederhana.
- Semua fill dengan warna ARGB identik digabung menjadi satu color group.
- Stroke sengaja dibuang; stroke-only element dilewati.
- Gradient diratakan menjadi satu warna representatif agar satu group hanya memiliki satu warna.
- Arc diubah menjadi cubic Bézier. Node contour kompleks dikurangi secara adaptif dengan perlindungan primitive dan sudut tajam.
- Mode `accurate`, `balanced`, dan `lightweight` mengontrol tingkat pengurangan node tanpa mengubah prinsip 1 warna = 1 group.

## Jalankan lokal

```bash
npm install
npm test
npx vercel dev
```

Buka URL lokal yang diberikan Vercel CLI.

## Deploy ke Vercel

Import repo ini ke Vercel. Converter web tetap dapat dipakai tanpa memasukkan secret ke browser.

### Aktifkan Engine API untuk website lain

v1.6 memisahkan dua endpoint:

```text
POST /api/convert       -> dipakai website svgtoxml sendiri
POST /api/v1/convert    -> engine API eksternal, API key wajib
```

Buat key di Termux:

```bash
bash scripts/generate-api-key.sh website-utama
```

Di Vercel buka **Project → Settings → Environment Variables**, lalu tambahkan satu key:

```env
SVG2XML_API_KEY=amx_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Atau beberapa key, satu per website:

```env
SVG2XML_API_KEYS=website-a=amx_live_xxx,website-b=amx_live_yyy
```

Opsional batasi origin browser:

```env
API_ALLOWED_ORIGINS=https://website-a.vercel.app,https://website-b.com
```

Jika `API_ALLOWED_ORIGINS` kosong, origin tidak dibatasi tetapi API key tetap wajib. Setelah mengubah Environment Variables, redeploy project.

> **Penting:** jangan menaruh `amx_live_...` di JavaScript frontend publik website lain. Simpan key sebagai environment variable di backend/serverless function website tersebut.

## Engine API v1

### Health

```http
GET /api/v1/health
```

### Validasi API key

```http
GET /api/v1/auth
x-api-key: amx_live_...
```

### Convert

```http
POST /api/v1/convert
Content-Type: application/json
x-api-key: amx_live_...
```

Body:

```json
{
  "svg": "<svg viewBox=\"0 0 1080 1350\">...</svg>",
  "options": {
    "title": "Project Saya",
    "quality": "lossless",
    "validateBounds": true
  }
}
```

Untuk menerima XML langsung gunakan `POST /api/v1/convert?raw=1` atau header `Accept: application/xml`. `Authorization: Bearer amx_live_...` juga didukung.

Contoh curl:

```bash
curl -X POST 'https://svgtoxml.vercel.app/api/v1/convert' \
  -H 'content-type: application/json' \
  -H 'x-api-key: amx_live_KEY_KAMU' \
  --data '{"svg":"<svg viewBox=\"0 0 100 100\"><path d=\"M0 0L100 0L100 100Z\" fill=\"#000\"/></svg>","options":{"quality":"lossless"}}'
```

Untuk website Vercel lain, lihat `examples/vercel-server-proxy.js`.

## Arti opsi

- `quality`: `accurate` (default), `balanced`, atau `lightweight`.
- `maxShapes`: default Accurate `2500`; bisa dinaikkan hingga `5000`.
- `minAreaPercent`: default Accurate `0`, sehingga detail kecil tidak dibuang.
- `precision`: default Accurate `5`; rentang `0–6`.
- `duration`: durasi scene dalam ms. Default `1000`.
- `fps`: frame rate. Default `30`.

## Batas format

SVG `text`, bitmap `<image>`, filter kompleks, pattern fill, dan clip/mask kompleks tidak dapat dipetakan 1:1 ke schema path Alight Motion yang digunakan. Converter akan mempertahankan bentuk vector utama dan mengembalikan warning bila menemukan kasus tersebut. Gradient dengan lebih dari dua stop disederhanakan menjadi warna awal dan akhir karena XML referensi memakai pasangan `startColor`/`endColor`.

## Push dari Termux ke GitHub

Dari root proyek:

```bash
bash scripts/push-termux.sh https://github.com/USERNAME/NAMA-REPO.git
```

Dengan pesan commit custom:

```bash
bash scripts/push-termux.sh \
  https://github.com/USERNAME/NAMA-REPO.git \
  "feat: deploy svg alight converter"
```

Script akan `npm install`, menjalankan syntax check + test, commit, lalu push ke branch `main`.

## v1.1 — Vercel HTTP 500 fix

- API entry point memakai Web Handler `export default { fetch() {} }` sesuai runtime Vercel terbaru.
- Converter di-load dengan dynamic import agar error dependency/bundle dikembalikan sebagai JSON, bukan error 500 tanpa pesan.
- `GET /api/v1/health?deep=1` menguji apakah modul converter benar-benar bisa dimuat.
- UI menampilkan kode/detail error server sehingga debugging di HP lebih mudah.

## v1.2.0 - Alight Motion strict compatibility

Versi ini memperketat output XML agar mengikuti bentuk yang terlihat pada XML ekspor Alight Motion:

- setiap path memakai command eksplisit `M`, `L`, `C`, `Z` per segmen;
- ada spasi setelah command dan koma antar pasangan control-point cubic;
- tidak memakai compact SVG number adjacency seperti `M-5-10` atau `C1-2...`;
- setiap shape path menulis identity scale `<scale value="1.000000,1.000000" />` secara eksplisit.

Perubahan ini dibuat karena sintaks compact yang legal untuk SVG belum tentu diterima oleh parser import XML Alight Motion.

## v1.3.0 — Fidelity-first + Engine API v1

Perubahan utama:

- mode default sekarang **Accurate**, bukan pengurangan layer agresif;
- Accurate: `maxShapes=2500`, `minAreaPercent=0`, `precision=5`;
- Balanced dan Lightweight tetap tersedia untuk file yang terlalu berat;
- `preserveAspectRatio` + `viewBox` dipetakan sesuai aturan SVG (`meet`, `slice`, `none`), bukan selalu stretch X/Y;
- nested `<svg>` / `<symbol>` viewport dan `<use width/height>` ditangani lebih baik;
- selector CSS descendant sederhana seperti `.layer .skin` ikut dihitung;
- endpoint stabil untuk integrasi pihak ketiga: `POST /api/v1/convert`;
- field API key di frontend dihapus. Secret **tidak pernah ditaruh di browser**;
- bila `SVG2XML_API_KEY` di Vercel diisi, request eksternal wajib mengirim `x-api-key`, sedangkan frontend same-origin tetap bisa bekerja tanpa membocorkan secret.

### API pihak ketiga

```bash
curl -X POST 'https://DOMAIN.vercel.app/api/v1/convert' \
  -H 'content-type: application/json' \
  -H 'x-api-key: KEY_DARI_OWNER' \
  --data '{"svg":"<svg>...</svg>","options":{"quality":"accurate"}}'
```

`quality` dapat berupa `accurate`, `balanced`, atau `lightweight`.

> Catatan fidelity: `clipPath`, mask, filter kompleks, text/font eksternal, dan gradient >2 stop masih tidak selalu dapat dipetakan 1:1 ke format XML Alight Motion yang sudah tervalidasi. Engine memberi warning bila menemukan fitur tersebut.

## v1.4.0 — Color Groups + node reduction

Output Alight Motion sekarang diubah mengikuti workflow editing yang lebih praktis:

- **1 warna solid = 1 `embedScene` group**;
- semua path dengan warna ARGB yang sama digabung menjadi **1 vector path** di dalam group tersebut;
- **stroke tidak ditulis** ke XML; elemen stroke-only dilewati;
- gradient diratakan menjadi satu warna midpoint agar satu group tidak mencampur paint;
- node pada contour kompleks dikurangi secara adaptif, tetapi primitive/path sederhana dan sudut tajam dilindungi;
- default Accurate mengurangi sekitar 35% anchor yang aman, Balanced 50%, Lightweight 65%;
- statistik API mengembalikan `colorGroups`, `mergedShapes`, `nodesBefore`, `nodesAfter`, `strokesRemoved`, dan `gradientsFlattened`.

Catatan penting: grouping global per warna dapat mengubah urutan tumpukan bila warna yang sama tersebar di beberapa posisi z-order. Engine mengurutkan group berdasarkan rata-rata posisi sumber untuk meminimalkan perubahan tersebut. Jika fidelity z-order absolut lebih penting daripada satu-group-per-warna, gunakan strategi grouping per-run pada versi lanjutan.

## v1.5.0 — Lossless / 100% Akurat

Mode baru `quality: "lossless"` ditambahkan tanpa mengubah behavior tiga mode grouped lama.

Lossless memaksa:

- `nodeReduction = 0`
- `minAreaPercent = 0`
- source shape limit = unlimited
- precision output = 8 desimal
- grouping by color = OFF
- z-order = urutan SVG asli
- native Alight Motion `<path-stroke>` = ON
- 2-stop linear/radial gradient = dipertahankan
- bbox validation = ON secara default

Path dinormalisasi lewat helper `lib/path-geometry.js`. `S/T` di-expand terlebih dahulu,
`Q` dikonversi secara eksak menjadi cubic Bézier, dan `A` diubah menggunakan standard
elliptical-arc to cubic decomposition dari `svgpath.unarc()`.

### API

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "lossless",
    "validateBounds": true
  }
}
```

Response lossless memiliki `validation`:

```json
{
  "enabled": true,
  "sourceDrawable": 10,
  "emittedShapes": 10,
  "missingShapes": 0,
  "bboxMismatches": 0,
  "details": []
}
```

### Batas fitur yang dilaporkan eksplisit

XML referensi yang tersedia membuktikan native path fill, 2-color gradient, dan
`path-stroke` (color/size/join). Mapping 1:1 untuk SVG `clip-path`, `mask`, filter kompleks,
`stroke-dasharray`, dan stroke line-cap belum terbukti. Lossless tidak silent-drop fitur
tersebut: warning dikembalikan melalui API/UI.

Untuk `fill-rule="evenodd"`, engine mengubah winding subpath tertutup menjadi alternating
winding sehingga visual lubang sederhana tetap sesuai pada renderer nonzero tanpa mengubah
kurva Bézier. Self-intersection ekstrem tetap perlu verifikasi manual.


## v1.5.1 — Test reliability hotfix

- Tidak mengubah engine konversi atau behavior mode Accurate/Balanced/Lightweight/Lossless.
- Memperbaiki fixture unit test node reduction: sekarang memakai contour over-sampled yang benar-benar reducible.
- Fixture sine lama dapat berhenti di anchor yang sengaja dilindungi oleh corner-preservation (`angle < 135°`), sehingga assertion `nodesBefore > nodesAfter` tidak selalu valid.


## v1.5.2 — Android file-read reliability

- SVG dibaca sekali segera setelah file picker selesai, lalu source disimpan di memori browser.
- Tombol Convert tidak lagi memanggil `File.text()` pada reference Android yang bisa kedaluwarsa/revoked.
- Pesan error file permission sekarang meminta pilih ulang file secara eksplisit.
- Mode default UI diubah ke Lossless; tiga mode lama tetap tersedia dan behavior engine-nya tidak berubah.

## v1.5.3 — grouped reducer reliability

- Mode Lossless tidak diubah: node reduction tetap 0%, z-order/source-shape/stroke tetap dipertahankan.
- Accurate/Balanced/Lightweight sekarang mereduksi setiap source contour secara independen sebelum digabung berdasarkan warna.
- Satu contour yang gagal direduksi tidak lagi membatalkan reduction untuk seluruh group warna.
- Warning per-warna yang memenuhi layar diganti satu warning agregat; jumlah fallback tersedia di `stats.nodeReductionFallbackShapes`.


## v1.6.0 — External Engine API keys

- Website resmi memakai `POST /api/convert`.
- Integrasi eksternal memakai `POST /api/v1/convert` dan API key selalu wajib.
- Mendukung satu key via `SVG2XML_API_KEY` atau multi-key bernama via `SVG2XML_API_KEYS`.
- Perbandingan secret memakai SHA-256 + `crypto.timingSafeEqual`.
- `GET /api/v1/auth` memvalidasi key tanpa melakukan konversi.
- `API_ALLOWED_ORIGINS` dapat membatasi origin browser.
- Secret tidak pernah ditaruh di frontend converter resmi.
- Contoh proxy server-side tersedia di `examples/vercel-server-proxy.js`.


## v1.7.0 — AM Optimized / phone-first XML

Mode baru `optimized` ditambahkan dan menjadi default UI. API tetap kompatibel dengan default lama bila `quality` tidak dikirim; integrasi baru disarankan mengirim `quality: "optimized"` secara eksplisit. Mode lama `lossless`, `accurate`, `balanced`, dan `lightweight` tetap tersedia.

AM Optimized dibuat untuk SVG auto-vector yang bisa menghasilkan ribuan layer di Alight Motion:

- membuang subpath/titik mikro berdasarkan luas relatif canvas;
- melindungi detail panjang-tipis agar garis penting tidak ikut hilang;
- mengurangi node secara moderat per contour;
- mempertahankan native stroke dan gradient 2-stop bila tersedia;
- menggabungkan path dengan style sama hanya jika perpindahan z-order tidak memotong shape yang overlap;
- membatasi layer output (default 320) dengan membuang group mikro terkecil bila masih terlalu banyak;
- mengembalikan statistik `microSubpathsRemoved`, `safeColorMerges`, `zOrderBarriers`, dan `optimizedGroupsDropped`.

Contoh API:

```json
{
  "svg": "<svg>...</svg>",
  "options": {
    "quality": "optimized",
    "microDetailPercent": 0.0015,
    "maxOutputGroups": 320,
    "nodeReduction": 38
  }
}
```
