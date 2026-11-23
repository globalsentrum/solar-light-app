# Laporan Ujian — Aplikasi Lampu Solar Karak (versi 2)

Tarikh: 23/11/2026 · Keputusan: **47 / 47 lulus** (33 unit + backend, 14 pelayar)
Jalankan semula: `npm install` → `npm run test:all`. Ujian guna **data tiang dummy** (`tests/fixtures/dummy-data.js`:
123 tiang, jumlah sama, chainage rekaan), jadi ia boleh dijalankan dari repo sahaja. Semakan bilangan pada xlsx
sebenar dijalankan hanya jika fail peribadi itu ada (`data/`). Satu ujian memastikan tiada chainage sebenar dalam fail ujian.

| Bahagian | Cara ujian |
|---|---|
| Logik (status, ukuran, pilihan laporan, tarikh Malaysia, ID) | Ujian unit Node — `tests/logic.test.js` |
| Backend Apps Script | Kod **sebenar** `Code.gs` + `Logic.gs` dengan tiruan Google Sheets/Drive/Docs yang **ketat** (kaedah Docs yang tidak dikenali = ralat; `setText()` pulangkan kosong seperti Google) — `tests/backend.test.js` |
| Aplikasi telefon | Chromium (Playwright), skrin 390×844, jam dikawal untuk ujian tarikh — `tests/e2e.test.js` |
| Susun atur laporan | Pratonton PDF + Word dari definisi susun atur yang sama — `npm run preview` |

⚠️ **Tidak dapat diuji di sini:** Google Docs/Drive/Sheets sebenar (termasuk eksport Word sebenar), log masuk Google,
telefon sebenar. Pratonton laporan dibuat dengan LibreOffice; laporan sebenar dibuat oleh Google Docs (fon/jarak mungkin
berbeza sedikit). Sila jana satu laporan sebenar bagi setiap aktiviti selepas deploy.

## 1. Ujian unit (17)
- Salinan logik frontend = Apps Script.
- Aktiviti & 8 jenis gambar: ID, minimum (C1 = 4), ukuran (B2–B4) tetap; nama/spesifikasi dari Sheet sahaja.
- **ID tiang**: SL-034 → SSL034; carian `SSL034`, `34`, `034`, `SL-034`, `ssl34`, `SSL05` (awalan).
- **Ukuran**: `1.3`, `1,3`, `1.3m`, `2` diterima; kosong / `abc` / `-1` / `.5` / `1.355` / `0` ditolak dengan mesej BM.
- **Kelengkapan gambar**: semua minimum; C1 dikira 4; contoh `Pegging ✓ · Trial Pit 3/4 · Installation 2/6`;
  tersembunyi, Ambil semula dan tanpa ukuran tidak dikira; gambar lebih daripada minimum tidak lebih dikira.
- Status kerja (Belum mula / Dalam proses / Siap / Batal siap / kategori) dan bebas daripada status gambar.
- **Pilihan laporan**: lalai = terkini yang baik (C1 = 4 terkini, lama → baru); pilihan admin (1, atau 4 ikut susunan);
  pilihan yang tidak lengkap (cth. satu disembunyikan) → kembali ke automatik.
- Senarai kekurangan per aktiviti; susun atur laporan (tajuk, lajur, kapsyen, pemisah halaman, saiz muat dalam A4).
- **Tarikh Malaysia (UTC+8)**: 23:59:59 vs 00:00:01, sempadan tahun; tarikh tidak sah ditolak; beberapa pelan per tiang.
- Import xlsx dummy: 123 = 33 + 44 + 46, EB 54 / WB 69, 51 CH belum tepat, ID SSL.
- Matriks kebenaran termasuk tindakan baru (pelan, pilihan laporan, nama).

## 2. Ujian backend (16)
- `setup()` untuk Sheet baru: tab Activities / PhotoTypes / WorkPlan, Settings `ReportMaxPhotos = 60`, tiada tab Slots.
- Log masuk Google + sesi 30 hari; Active = FALSE / buang pengguna → ditolak serta-merta.
- **Kebenaran di backend**: 17 tindakan × 3 peranan (termasuk `addPlans`, `editPlan`, `removePlan`, `setReportSelection`,
  `saveNames`, `reportCheck`, `generateReport`); muat turun PDF & Word untuk semua peranan.
- Muat naik: ukuran wajib & disahkan untuk B2–B4 (ditolak = tidak disimpan); idempoten; nama fail `SSL040_B2_…`.
- Pilihan laporan: tepat 1 / tepat 4 ikut susunan; berulang, jenis/tiang lain, tersembunyi ditolak; kosongkan; log.
- Nama aktiviti/jenis: tukar nama kekalkan pautan gambar; peraturan tetap.
- **Pelan kerja**: beberapa tiang sekali gus; beberapa pelan per tiang; pendua dilangkau; ubah (tidak boleh jadi pendua);
  buang; tarikh/aktiviti/tiang tidak sah ditolak; setiap perubahan dalam AuditLog; semua peranan menerima pelan.
- **Laporan**: `reportCheck` menyenaraikan tiang tidak lengkap; `generateReport` menolak tiang tidak lengkap;
  had ikut bilangan gambar (60 → Pegging 60 / Trial Pit 15 / Installation 10).
- **Susun atur laporan** (struktur Google Doc yang dibina): PEGGING 3 sebaris + "Total pegging : 4 nos";
  TRIAL PIT 3 blok/halaman, kapsyen `SSL034 · WIDTH : 1.3M · LENGTH : 1.6M · DEPTH : 1.5M`, pilihan admin digunakan;
  INSTALLATION 1 tiang/halaman, 4 gambar progress ikut susunan admin, siang & malam lebih besar; nisbah gambar dikekalkan
  (potret 118×157, landskap 118×89); PDF **dan** Word dalam `Solar Reports/`; Doc sementara dibuang; muat turun berpecah sama bait.
- **Migrasi v1 → v2**: ID ditukar dalam Poles, Photos, Notes, WorkPlan, Reports; folder & fail Drive ditukar nama (termasuk
  kes folder lama + baru wujud); slot lama dipetakan; Slots → Slots_old; satu entri `MigrationV2`; sejarah AuditLog lama
  tidak diubah; **jalankan kali kedua = tiada perubahan langsung**; ID tidak dikenali → berhenti **sebelum** apa-apa ditukar.
- Item yang masih dalam barisan telefon dari aplikasi v1 (SL-040, slot S1) masih diterima selepas migrasi.

## 3. Ujian pelayar (14)
- Dashboard & Jadual (admin: tab Semua, tapis, carian `34`).
- **Esok / Hari ini**: Team/Boss dibuka pada Esok; jam 23:59 (5 Jan) → Esok = 6 Jan; jam 00:00:30 (6 Jan) → 6 Jan
  menjadi Hari ini dan Esok kosong ("Tiada kerja dirancang untuk esok."); disusun ikut chainage; label aktiviti
  (beberapa pelan → "Trial Pit · Installation"; kosong → tiada label); **dimuat semula tanpa line → pelan masih ada**.
- Admin rancang kerja dari Jadual (tanda 2 tiang → tarikh lalai esok → aktiviti) → pendua dilangkau → ubah & buang di skrin tiang.
- Skrin tiang: 3 kumpulan, spesifikasi Trial Pit, bilangan/minimum; dialog ukuran (kosong/huruf/3 perpuluhan/0 ditolak,
  `1,3` diterima → "1.3 m" di bawah gambar); "Buang gambar ini" tidak menyimpan apa-apa.
- **Luar talian**: gambar (termasuk ukuran), nota, Siap → muat semula aplikasi → ukuran masih dipaparkan → online dengan
  jawapan hilang → tepat 2 gambar, tiada pendua, ukuran tersimpan.
- Sesi tamat semasa luar talian → log masuk semula → semua dihantar sekali.
- Peranan UI: Boss tiada kamera/nota/Siap/pilihan laporan/tanda tiang; Team tiada pilihan laporan & tanda tiang.
- **Admin**: pilih 4 gambar Progress ikut susunan (Simpan hanya aktif pada 4), Ambil semula; laporan Trial Pit dengan satu
  tiang tidak lengkap → senarai amaran → "Teruskan tanpa tiang ini" → laporan 2 tiang; muat turun **PDF dan Word**;
  semua tiang tidak lengkap → tiada laporan dijana.
- Tukar nama jenis/spesifikasi → dipaparkan pada skrin tiang; pengguna; log audit.
- Watermark (5 kes), GPS 15 saat, tanpa kebenaran lokasi, `config.js` dikemas kini dari GitHub.

## Pepijat ditemui & dibaiki
1. Carian `ssl34` tidak menjumpai SSL034 → dibaiki (dan `SSL05` kini awalan + bentuk berpad).
2. Ujian dahulu mengandungi chainage sebenar → kini data dummy; ujian penjaga ditambah.

## Senarai semak telefon sebenar (selepas kemas kini v2)
- [ ] `migrateV2` → log "selesai"; jalankan sekali lagi → "tiada perubahan"
- [ ] Deploy → Manage deployments → New version; URL sama; log masuk masih berfungsi
- [ ] Telefon: "Versi baru aplikasi dipasang" → buka semula → ID `SSL…`
- [ ] Pasukan: tab **Esok** menunjukkan pelan admin; mod kapal terbang → buka semula → pelan masih ada
- [ ] Trial Pit → Lebar: papan kekunci nombor muncul (Android & iPhone); `1,3` diterima; kosong ditolak
- [ ] Progress pemasangan: ambil 5 gambar; admin pilih 4 ikut susunan
- [ ] Jana laporan **Pegging**, **Trial Pit**, **Installation** → buka PDF dalam Drive; buka **.docx dalam Microsoft Word**
      (jadual, saiz gambar, kapsyen kekal); muat turun dari telefon Boss
- [ ] Laporan dengan tiang tidak lengkap → senarai amaran → Teruskan / Batal
- [ ] Watermark masih jelas dalam gambar laporan
- [ ] Semua item dalam senarai semak v1 (kamera, GPS, luar talian, peranan) masih berfungsi
