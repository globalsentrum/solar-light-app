# Laporan Ujian — Aplikasi Lampu Solar Karak

Tarikh: 22/11/2026 · Keputusan: **38 / 38 lulus** (28 unit + backend, 10 pelayar)
Cara jalankan semula: `npm install` → letak xlsx dalam `data/` → `npm run import` → `npm run test:all`

## Apa yang diuji, dan bagaimana

| Bahagian | Cara ujian |
|---|---|
| Logik status, kelengkapan, CH tepat, kebenaran | Ujian unit Node (`tests/logic.test.js`) |
| Backend Apps Script | Kod **sebenar** `Code.gs` + `Logic.gs` + `SeedData.gs`, dijalankan dengan tiruan (mock) Google Sheets/Drive/Docs (`tests/gas-mock.js`, `tests/backend.test.js`) |
| Aplikasi telefon (PWA) | Chromium (Playwright 1.63), skrin 390×844 (saiz telefon), disambung ke backend sebenar di atas mock (`tests/e2e.test.js`) |

⚠️ **Tidak dapat diuji di sini** (perlu anda uji selepas setup, lihat senarai semak di bawah):
log masuk Google sebenar, Google Sheets/Drive/Docs sebenar (termasuk PDF sebenar), iPhone Safari dan Android Chrome sebenar, kamera & GPS sebenar.

## 1. Ujian unit (12 lulus)
- Salinan `logic.js` untuk frontend & Apps Script adalah sama.
- **CH tepat**: `CH.40045` ✔; julat `CH.42400 – CH.42600`, 4/6 digit, huruf kecil, tanpa titik ✘.
- **Jumlah import dari xlsx**: 123 = 33 + 44 + 46; EB 54 / WB 69; SL-056…060 kekal *Perlu pasang* dengan "CH belum tepat"; 51 CH belum tepat; lajur Zone diabaikan.
- **Status kerja**: Sudah dipasang → Siap; Tunggu kelulusan; Belum mula; gambar tersembunyi tidak dikira; gambar "Ambil semula" masih dikira *Dalam proses*; Siap; Batal siap kembali ke Dalam proses / Belum mula.
- **Status gambar**: Lengkap / Belum lengkap (x/7); sembunyi & Ambil semula → 6/7; gambar baru selepas Ambil semula → Lengkap; Siap dengan 6/7 (berasingan).
- **Slot tidak aktif**: 6/6 = Lengkap; slot ke-8 → x/8; gambar dalam slot tidak aktif tidak dikira.
- **Pilihan gambar PDF**: pilihan admin diutamakan; jika tiada → terkini yang tidak ditanda; pilihan tersembunyi diabaikan.
- **Matriks kebenaran** Seksyen 3 untuk Admin / Team / Boss; tiada tindakan "padam gambar".

## 2. Ujian backend (16 lulus)
- `setup()` mencipta 8 tab dengan pengepala Inggeris, 123 tiang, 7 slot, admin; selamat dijalankan dua kali.
- **Log masuk Google**: token sah → sesi + nonce; Client ID salah / emel tiada / emel tidak disahkan / pengguna tidak aktif → ralat.
- **Sesi 30 hari**: token diubah / tamat → ditolak. **Active = FALSE, buang pengguna, atau taip FALSE terus dalam Sheet → permintaan seterusnya terus ditolak.** Tukar peranan berkuat kuasa serta-merta.
- **Kebenaran dikuatkuasa di backend**: 14 tindakan × 3 peranan, semua betul (FORBIDDEN untuk yang tidak dibenarkan).
- **Kategori**: tiada gambar/Siap untuk Tunggu kelulusan; Sudah dipasang boleh gambar tetapi tiada Siap; nota dibenarkan semua.
- **Muat naik idempoten**: hantar 3× = 1 baris, 1 fail + 1 thumbnail, 1 log; folder `Solar Photos/SL-040/`; semua lajur Photos betul; tanpa GPS.
- **Sembunyi**: Team/Boss tidak nampak (senarai, gambar penuh, thumbnail); Admin nampak; tunjuk semula; tidak dipadam; dilog.
- Siap/Batal siap + log; editor tiang (CH tepat dikira semula, kategori, pengesahan input, setiap medan dilog); Ambil semula; satu pilihan laporan per slot; slot (tukar nama kekalkan pautan gambar, tambah, nyahaktif, susun); pengguna (tidak boleh kunci diri sendiri); nota (idempoten, Boss ditolak, teks `=formula` kekal teks).
- **PDF**: slot dengan 3 gambar: tanpa pilihan → gambar terkini yang tidak ditanda; dengan pilihan admin → gambar dipilih; kapsyen (nama slot + spec, tarikh/masa, GPS, pengambil, Kamera/Galeri); "Tiada gambar"; status kerja dalam pengepala; dokumen sementara dibuang; disimpan dalam `Solar Reports/`; had 10 tiang; muat turun berpecah (chunk) menghasilkan bait yang sama; semua peranan boleh muat turun.
- Log audit: admin sahaja, terbaru dahulu, boleh dicari; suapan aktiviti untuk semua tanpa urusan pengguna.

## 3. Ujian pelayar (10 lulus)
- **Dashboard**: 33/123, 0/44, 44, 46, 0, 44; EB 23/54, WB 10/69. **Jadual**: 123 / EB 54 / WB 69 / Tunggu 46 / Perlu pasang 44 / Siap 33; carian; susunan chainage; label CH belum tepat.
- **Luar talian**: 1 gambar kamera + 1 galeri + nota + Siap semasa offline → "⏳ 4 item menunggu line" → **muat semula aplikasi semasa offline** (dari service worker + IndexedDB) → semua masih ada → online, dengan **jawapan muat naik pertama sengaja "hilang"** → aplikasi cuba lagi → pelayan: tepat 2 gambar, 1 nota, Siap, 2 log (**tiada pendua, tiada yang hilang**). Tiada CORS preflight.
- **Sesi tamat semasa offline**: banner "Sesi log masuk tamat — 2 item belum dihantar" → skrin log masuk menunjukkan item masih disimpan → log masuk → semua dihantar sekali.
- Nonce salah ditolak; mesej `#loginerror` dalam BM.
- **UI peranan**: Boss tiada kamera/nota/Siap/Edit/Admin/Jana PDF; Team tiada Edit/Admin; Tunggu kelulusan: hanya nota; Sudah dipasang: gambar ya, Siap tidak.
- **Admin**: Ambil semula, ★ Pilih untuk laporan, Sembunyikan (Team tidak nampak), edit tiang (CH tepat + kategori), jana PDF (2 tiang) & muat turun (Admin dan Team).
- Skrin Pengguna & Slot (tambah, tukar peranan, nyahaktif, buang; tukar nama slot, susun, slot ke-8 → 0/8); log audit.
- **Watermark** (gambar contoh dalam `test-output/`):
  1. Kamera tanpa EXIF: 2400×1800 → 1600×1200, `21/11/2026 14:05` + `GPS: 3.12346, 101.65432 ±8 m`, sudut kanan bawah
  2. Galeri dengan EXIF: masa & GPS dari EXIF, tiada label, GPS telefon tidak diminta
  3. Galeri tanpa EXIF: masa muat naik + GPS semasa + **"Dari galeri"**, potret kekal
  4. Galeri ada tarikh EXIF tetapi tiada GPS: tarikh EXIF + GPS semasa + "Dari galeri"
  5. Tiada GPS: **"GPS tidak tersedia"**, GPSAvailable = FALSE
- **GPS**: tunggu sehingga had masa lalu null; fix lambat diterima; fix segar diguna semula; ditolak → null serta-merta; aplikasi guna had 15 saat. Gambar sebenar tanpa kebenaran lokasi → `GPSAvailable = FALSE`.

## Pepijat yang ditemui & dibaiki semasa ujian
1. Pustaka EXIF versi "legacy" gagal membaca tarikh pada gambar tanpa GPS → ditukar ke versi standard (iOS 12+ / Android moden).
2. Skrin log masuk menyimpan nonce hanya selepas skrip Google dimuatkan → kini disimpan dahulu.
3. Fail Apps Script dimuatkan dalam susunan rawak → kod tidak lagi bergantung pada susunan fail (diuji dengan Code.gs dimuatkan dahulu).

## Senarai semak untuk anda — telefon sebenar (selepas setup)

Uji pada **satu Android (Chrome)** dan **satu iPhone (Safari)**:

- [ ] Pasang ke skrin utama, buka dari ikon (tiada bar alamat)
- [ ] Log masuk Google dari ikon → "Teruskan ke aplikasi" → kembali ke aplikasi dan kekal log masuk selepas ditutup/dibuka
- [ ] Emel yang tiada dalam Users → mesej ditolak
- [ ] Benarkan Lokasi & Kamera; **📷 Kamera** membuka kamera belakang
- [ ] Gambar kamera: watermark tarikh/masa betul (waktu Malaysia) + GPS ±m; semak koordinat dengan Google Maps (ketik gambar → Peta)
- [ ] **🖼️ Galeri**: gambar lama → tarikh/GPS asal (iPhone kadang-kadang buang GPS → akan keluar "Dari galeri"; ini dijangka)
- [ ] Gambar muncul dalam Drive `Solar Photos/SL-xxx/` dan baris dalam tab Photos
- [ ] **Mod kapal terbang**: ambil 2 gambar + nota + Siap → "⏳ 4 item menunggu line" → tutup aplikasi sepenuhnya → buka semula (masih offline) → item masih ada → matikan mod kapal terbang → "✅ Semua disimpan" → semak Sheet: tiada pendua
- [ ] GPS di kawasan terbuka tanpa data mudah alih (mod kapal terbang + lokasi ON) → GPS masih dapat
- [ ] Akaun Boss: tiada butang kamera/nota/Siap
- [ ] Admin: nyahaktif seorang pengguna → telefonnya ditolak pada tindakan seterusnya
- [ ] Admin: Ambil semula / Sembunyikan / ★ Pilih untuk laporan / Edit tiang / tukar kategori
- [ ] Jana PDF 2–3 tiang → buka dalam Drive `Solar Reports/` → semak gambar & kapsyen → muat turun dari telefon Boss
- [ ] Teks dalam watermark mudah dibaca pada skrin telefon
- [ ] Ambil gambar ketika bateri jimat kuasa / memori rendah (iPhone lama): aplikasi tidak tergantung
