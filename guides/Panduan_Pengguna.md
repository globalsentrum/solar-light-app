# Panduan Pengguna — Lampu Solar Karak (versi 3)

Alamat aplikasi: **https://globalsentrum.github.io/solar-light-app/**
(Pasang ke skrin utama: Android → Chrome ⋮ → *Install app*. iPhone → Safari → Share → *Add to Home Screen*.)

**Peranan.** Apa yang anda nampak bergantung pada **peranan** yang admin berikan (cth. Team, Boss, Supervisor,
Pembuat claim). Butang yang anda tiada kebenaran tidak dipaparkan — dan pelayan juga menolaknya.
Label status (cth. "Siap") boleh ditukar oleh admin; maksudnya sama.

---

## A. PASUKAN (Team)

**Log masuk:** ikon *Lampu Solar* → **Sign in with Google** → **Teruskan ke aplikasi**. Kekal ~30 hari.

### 1. Kerja esok
**📋 Jadual** dibuka pada **Esok**: tiang yang dirancang, ikut chainage, dengan aktiviti (cth. *Trial Pit*, *Ujian lampu (malam)*).
**Hari ini** / **Semua** juga ada. Setiap tiang menunjukkan **📅 tarikh pelan seterusnya** atau **Belum dirancang**.
Pelan boleh dilihat tanpa line.

### 2. Ambil gambar
Ketik tiang. Gambar ikut 3 aktiviti:

| Aktiviti | Jenis gambar | Minimum |
|---|---|---|
| **Pegging** | Pegging | 1 |
| **Trial Pit** (📐 Dalam 1.5m, lebar 1m, panjang 1m) | Korek · Lebar* · Panjang* · Dalam* | 1 setiap satu |
| **Installation** | Progress pemasangan | **4** |
| | Siap pasang (siang) · Ujian lampu (malam) | 1 setiap satu |

\* masukkan **ukuran sebenar (meter)** selepas gambar, cth. `1.3` atau `1,3` (maks 2 titik perpuluhan).

- Setiap jenis gambar ialah **satu baris** gambar kecil — **leret ke kiri/kanan** untuk lihat semua. Kiraan ditunjuk, cth. **10 📷 (min 4)**.
- **📷 Ambil gambar** / **+ Tambah** → **Kamera** atau **Galeri**. Tunggu GPS (maks 15 saat). Gambar disimpan serta-merta.
- Kerja siap → **✔ Tanda kerja siap** (tarikh siap sebenar diisi automatik). Tersilap → **↩ Batal siap**.
- **Nota**: perkara penting di tapak. Jangan ubah chainage — admin sahaja.
- 🌙 **Perlu gambar malam**: tiang sudah Siap tetapi belum ada gambar *Ujian lampu (malam)* — ambil pada waktu malam.

**Simbol**: ✅ cukup · ◐ belum cukup · 📷 tiada · 🔁 Ambil semula (ambil gambar baru) · ⏳ belum dihantar.

**Tiada line?** Teruskan kerja. **⏳ N item menunggu line** → dihantar automatik → **✅ Semua disimpan**.
Jangan padam aplikasi / data pelayar semasa ada item menunggu. "Sesi log masuk tamat" → **Log masuk semula** (kerja selamat).

---

## B. BOS (Boss)

Lihat sahaja.
- **📊 Dashboard** — setiap kad boleh **diketik** untuk senarai tiang tersebut:
  - **Baki perlu pasang** (nombor besar) *daripada N* tiang Perlu pasang
  - **Perlu gambar malam** · **Dalam proses** · **Belum mula** · **Siap** · **Tunggu kelulusan**
  - Kemajuan EB / WB, aktiviti terkini
  - Siap + Belum mula + Dalam proses + Tunggu kelulusan = semua tiang aktif
- **📋 Jadual** (Esok / Hari ini / Semua) → ketik tiang → semua gambar (leret), ketik gambar → saiz penuh, tarikh/masa, GPS, ukuran.
- **📄 Laporan** → **⬇ PDF** / **⬇ Word**.

---

## C. ADMIN (dan peranan dengan kebenaran yang sama)

### Peranan & pengguna
- **⚙️ Admin → Peranan**: cipta peranan, tukar nama, tanda kebenaran, nyahaktif. Peranan **Admin** terbina dalam (semua
  kebenaran, tidak boleh diubah). Nyahaktif peranan = penggunanya tidak boleh log masuk.
- **⚙️ Admin → Pengguna**: tambah Gmail, pilih peranan, aktif/nyahaktif, buang. Mesti ada sekurang-kurangnya **seorang Admin aktif**.

| Kebenaran | Maksud |
|---|---|
| Lihat dashboard | Tab Dashboard |
| Ambil / muat naik gambar · Tambah nota · Tanda kerja siap | Kerja di tapak |
| Rancang kerja | Pelan kerja (tarikh + aktiviti) |
| Pilih gambar untuk laporan · Jana laporan · Rekod No. RIN · Muat turun laporan | Laporan tuntutan |
| Edit maklumat tiang · Tambah tiang · Padam / nyahaktif tiang · Import · Eksport | Senarai tiang |
| Edit ukuran · Sorok gambar / Ambil semula · Padam gambar · Pindah / tukar gambar | Urus gambar |
| Tukar status kerja (override) | Tetapkan status tanpa gambar |
| Urus pengguna · Urus peranan · Tetapan (label & nama) · Lihat log audit | Pentadbiran |

### Tiang
- **➕ Tambah tiang** (Admin → Tambah tiang): ID, CH, Bound, kategori, nota. ID sementara dibenarkan (cth. SSL999).
- **✏️ Edit tiang** (pada skrin tiang): ID, CH, Bound, kategori, tarikh siap sebenar, No. RIN.
  - **ID sama dengan tiang lain → ditolak** (mesej merah menyebut tiang itu; huruf besar/kecil & ruang diabaikan).
  - Tukar ID mengemas kini semua gambar, nota, pelan, laporan dan folder Drive. ID lama dipaparkan.
  - CH + bound sama dengan tiang lain → amaran, boleh simpan juga.
- **⏸ Nyahaktif** — tiang tidak dipaparkan dalam senarai dan jumlah (data disimpan). **Jadual → Semua → Tidak aktif** → **▶ Aktifkan semula**.
- **🗑 Padam tiang** — hanya jika tiang **tiada gambar** ("Pindah atau padam gambar dahulu"); taip ID untuk sahkan.
- **⚙️ Status** — tetapkan Belum mula / Dalam proses / Siap dan tarikh siap sebenar tanpa mengira gambar. *Ikut automatik* membuang tetapan.
  (Jika pasukan tekan Siap / Batal siap selepas itu, tindakan terkini yang dikira.)
- **📥 Import** (Excel/CSV: Pole ID, CH, Bound, Category) → **pratonton** (ralat ditanda merah, tidak disimpan) →
  pilih *langkau* atau *kemas kini* tiang sedia ada → **Import**. **📤 Eksport** → fail Excel semua tiang.

### Gambar (ketik gambar)
- **★ Pilih untuk laporan** · **🔁 Ambil semula** · **🚫 Sorok** / **👁 Tunjuk semula**
- **📏 Edit ukuran** (Lebar/Panjang/Dalam)
- **🔀 Pindah ke tiang…** — pilih tiang tujuan (boleh cari nombor) dan jenis gambar (boleh tukar). Pada skrin tiang,
  **🔀 Pindah gambar** untuk beberapa gambar sekali gus. Ukuran ikut sekali; gambar di tiang tujuan kekal.
- **⇄ Tukar dengan tiang lain** — semua gambar (atau satu aktiviti) A ↔ B dalam satu tindakan; jika gagal, tiada apa berubah.
- **🗑 Padam** — gambar ke **Trash Google Drive** (boleh dipulihkan dari Drive dalam 30 hari).
- Padam / sorok / pindah gambar yang dipilih untuk laporan → pilihan jenis itu dikosongkan (pilih semula).

### Pelan kerja
**Jadual** → tanda ☑ tiang → **📅 Rancang** → tarikh (lalai esok) + aktiviti (pilihan, termasuk *Ujian lampu (malam)*).
Ubah / buang pada skrin tiang → *Pelan kerja* → ✏️. Tarikh pelan ialah tarikh dalam jadual (tarikh dari fail Excel asal tidak digunakan).

### Laporan (halaman gambar sahaja — borang RIN digabung sendiri)
1. **📄 Laporan** → pilih aktiviti. Senarai = tiang yang ada gambar aktiviti itu, ikut chainage.
2. Status setiap tiang:
   - ✅ **Sedia** — semua jenis gambar ada bilangan tepat (dipilih automatik) atau sudah dipilih admin
   - ⚠️ **Perlu pilih gambar** — ada lebih gambar daripada diperlukan → ketik baris → pilih
   - ⚠️ **Kurang gambar** — gambar / ukuran tidak cukup
   - 📄 **Dah dilaporkan** — No. RIN sudah direkod (disorok; tanda *Tunjuk yang dah dilaporkan*)
3. Hanya **Sedia** boleh ditanda. Alat: cari ID, EB/WB, tarikh gambar, **Pilih semua yang sedia**.
4. **No. RIN** (pilihan) → **📄 Jana laporan** → PDF + Word dalam `Solar Reports/`. RIN disimpan pada tiang tersebut.
5. Jalan pintas: **Jadual** → tanda tiang → **📄 Jana laporan** (hanya yang Sedia ditanda).

Had satu laporan (Settings `ReportMaxPhotos` = 60): Pegging 60 tiang, Trial Pit 15, Installation 10.

### Tetapan & label
**⚙️ Admin → Tetapan & label**: label status / kad dashboard dan nama aktiviti / jenis gambar (maks **20 aksara**, ada kiraan).
Menukar label tidak mengubah data atau penapis.

### Kualiti gambar
**⚙️ Admin → Tetapan & label → Kualiti gambar baru**: saiz maksimum sisi panjang (**1280–3000 px**, asal **2048**) dan
kualiti JPEG (**0.6–0.95**, asal **0.88**). Hanya untuk gambar **baru** — gambar lama tidak berubah. Telefon menggunakan tetapan
terkini selepas ia mendapat line. Lebih tinggi = gambar lebih jelas tetapi fail lebih besar (anggaran untuk gambar tapak biasa:
1600/0.8 ≈ 0.3 MB, **2048/0.88 ≈ 0.75 MB**, 3000/0.95 ≈ 2.6 MB setiap gambar).

### Log audit
**⚙️ Admin → Log audit**: semua perubahan (gambar, pindah/tukar/padam, ukuran, status, ID tiang, peranan, pengguna, RIN, laporan).

---

## D. PERANAN LAIN (cth. Supervisor, Pembuat claim)

Anda melihat bahagian yang sama seperti di atas, **hanya** untuk kebenaran yang admin berikan. Contoh:
- *Supervisor* (Lihat dashboard, Rancang kerja, Tambah nota) → boleh tanda tiang di Jadual dan **📅 Rancang**, tulis nota; tiada kamera.
- *Pembuat claim* (Pilih gambar, Jana laporan, Rekod No. RIN, Muat turun) → skrin **📄 Laporan** penuh.
Jika butang yang anda perlukan tiada, minta admin menambah kebenaran pada peranan anda.
