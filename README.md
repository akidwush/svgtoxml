# SVG → Alight Motion XML

Tool ringan untuk mengubah SVG menjadi XML scene Alight Motion. Struktur output mengikuti pola XML referensi Alight Motion 5.0.273: `<scene>`, `<shape>`, `<transform>`, `<fillColor>`, `<gradient>`, `<path-stroke>`, dan `<path>`.

## Fokus converter

- Warna SVG dikonversi ke format Alight Motion `#AARRGGBB`.
- Mendukung path, rect, circle, ellipse, line, polygon, polyline, group transform, `<use>`, CSS sederhana, fill, stroke, linear gradient, dan radial gradient.
- Arc diubah menjadi cubic Bézier agar path lebih dekat ke pola XML Alight Motion.
- Detail sangat kecil dibuang berdasarkan luas relatif terhadap canvas.
- Jika shape masih terlalu banyak, shape terkecil dibuang sampai `maxShapes`.
- Koordinat path dilokalkan ke pusat shape, sedangkan posisi disimpan pada `<transform><location>` agar angka path tidak terlalu besar.

## Jalankan lokal

```bash
npm install
npm test
npx vercel dev
```

Buka URL lokal yang diberikan Vercel CLI.

## Deploy ke Vercel

Import repo ini ke Vercel. Tidak membutuhkan database.

Environment variable yang disarankan:

```env
SVG2XML_API_KEY=buat_key_rahasia_sendiri
ALLOWED_ORIGINS=https://domain-kamu.vercel.app
MAX_SVG_BYTES=3000000
```

Buat API key acak dari Termux:

```bash
bash scripts/generate-api-key.sh
```

Salin hasilnya ke `SVG2XML_API_KEY` di Vercel.

Jika `SVG2XML_API_KEY` kosong, endpoint converter bersifat terbuka. Jika diisi, request wajib mengirim salah satu:

```http
x-api-key: KEY_KAMU
```

atau:

```http
Authorization: Bearer KEY_KAMU
```

Jangan menaruh API key rahasia di frontend publik. Untuk pemakaian dari website lain, lebih aman panggil endpoint ini melalui backend/server route milikmu.

## API

### Health

```http
GET /api/health
```

### Convert

```http
POST /api/convert
Content-Type: application/json
x-api-key: KEY_KAMU
```

Body:

```json
{
  "svg": "<svg viewBox=\"0 0 1080 1350\">...</svg>",
  "options": {
    "title": "Project Saya",
    "maxShapes": 180,
    "minAreaPercent": 0.003,
    "precision": 3,
    "duration": 1000,
    "fps": 30
  }
}
```

Response JSON berisi `xml`, `stats`, dan `warnings`.

Untuk response langsung XML:

```text
POST /api/convert?raw=1
```

atau kirim header `Accept: application/xml`.

## Arti opsi

- `maxShapes`: batas maksimum layer shape. Default `180`.
- `minAreaPercent`: bentuk dengan bounding-box di bawah persentase area canvas ini dibuang. Default `0.003` persen.
- `precision`: jumlah digit desimal path, `0–6`. Default `3`.
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
- `GET /api/health?deep=1` menguji apakah modul converter benar-benar bisa dimuat.
- UI menampilkan kode/detail error server sehingga debugging di HP lebih mudah.
