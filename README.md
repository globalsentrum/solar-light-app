# Lampu Solar Karak — Package 2A

Aplikasi web mudah alih (PWA) untuk merekod kerja pemasangan lampu jalan solar, Lebuhraya KL–Karak Seksyen 2, Package 2A.
Semua perkhidmatan percuma: GitHub Pages + Google Apps Script + Google Sheets + Google Drive.

- **Setup:** [guides/Panduan_Setup.md](guides/Panduan_Setup.md)
- **Pengguna (Team & Boss):** [guides/Panduan_Pengguna.md](guides/Panduan_Pengguna.md)
- **Laporan ujian:** [TEST_REPORT.md](TEST_REPORT.md)

## Struktur

```
docs/                 Aplikasi telefon (GitHub Pages: branch main, folder /docs)
  js/config.js        ← isi API_URL & CLIENT_ID
  js/app.js           Skrin & navigasi
  js/sync.js          Barisan luar talian (IndexedDB) & penghantaran
  js/watermark.js     Saiz semula, watermark, EXIF, GPS
  js/logic.js         (salinan shared/logic.js)
  sw.js               Service worker (luar talian)
apps-script/          Backend — tampal ke Apps Script
  Code.gs, Logic.gs   (+ SeedData.gs peribadi, TIDAK dalam repo)
shared/logic.js       Logik status & kebenaran (satu sumber untuk frontend + backend)
scripts/import-xlsx.js  xlsx → apps-script/SeedData.gs
tests/                Ujian unit, backend (mock Google) & pelayar (Playwright)
guides/               Panduan BM
```

## Data peribadi

Repo ini awam (diperlukan untuk GitHub Pages percuma), jadi **senarai tiang tidak disimpan di sini**.
`data/*.xlsx` dan `apps-script/SeedData.gs` ada dalam `.gitignore` dan diberi berasingan.
Gambar, nota dan Sheet hanya boleh dicapai selepas log masuk Google dengan emel yang didaftarkan.

## Pembangun

```bash
npm install
# letak xlsx dalam data/Solar_Street_Lighting_Installation_Planning_1.xlsx
npm run import      # jana apps-script/SeedData.gs
npm run test:all    # 38 ujian
```

Selepas mengubah `shared/logic.js` atau fail dalam `docs/`, jalankan `npm run build`
(menyalin logik & mengemas kini versi service worker).
