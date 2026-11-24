# Panduan Setup — Aplikasi Lampu Solar Karak (Package 2A)

Panduan ini untuk admin, langkah demi langkah. Tiada pengaturcaraan diperlukan, hanya salin & tampal.
Semua perkhidmatan adalah **percuma** (Google Sheets, Drive, Apps Script, Google Cloud, GitHub Pages).

**Masa:** lebih kurang 45–60 minit.
**Gunakan komputer** (bukan telefon) untuk setup.
**Gunakan SATU akaun Gmail admin** untuk semua langkah Google. Gambar & laporan akan disimpan dalam Google Drive akaun ini.

Anda perlukan:
- Repo GitHub: `https://github.com/globalsentrum/solar-light-app`
- Fail peribadi **`SeedData.gs`** (diberi berasingan, BUKAN dalam GitHub, kerana mengandungi senarai 123 tiang).
  Hanya diperlukan untuk **Google Sheet baru**.

> **Sudah guna aplikasi?** Jangan buat Langkah 1–10 semula.
> Versi 2 → ikut **"Kemas kini ke versi 3"** (di bawah sekali). Versi 1 → "Kemas kini ke versi 2" dahulu, kemudian versi 3.

---

## Langkah 1 — Buat Google Sheet

1. Buka <https://sheets.google.com> → **Blank spreadsheet** (Kosong).
2. Namakan fail: `Solar Karak Data` (klik "Untitled spreadsheet" di atas kiri).

> Tab-tab (Poles, Photos, Slots, …) akan dicipta automatik dalam Langkah 3. Jangan cipta sendiri.

## Langkah 2 — Tampal kod Apps Script

1. Dalam Sheet tadi: menu **Extensions → Apps Script** (Sambungan → Apps Script). Tab baru terbuka.
2. Namakan projek (atas kiri, "Untitled project"): `Solar Karak API`.
3. Anda akan nampak fail **Code.gs**. Padam semua isinya, kemudian tampal **seluruh** isi fail `apps-script/Code.gs` dari GitHub.
   - Di GitHub: buka fail → butang **Copy raw file** (ikon dua kotak di kanan atas kod).
4. Tambah fail kedua: klik **+** (sebelah "Files") → **Script** → namakan `Logic` (jadi `Logic.gs`). Tampal isi `apps-script/Logic.gs`.
5. Tambah fail ketiga: **+ → Script** → namakan `SeedData`. Tampal isi fail peribadi **`SeedData.gs`**.
6. Tekan ikon **💾 Save** (atau Ctrl+S).

## Langkah 3 — Jalankan `setup` (sekali sahaja)

1. Di bar atas editor, pilih fungsi **`setup`** dalam senarai menurun (sebelah butang Debug).
2. Klik **▶ Run**.
3. Tetingkap "Authorization required" → **Review permissions** → pilih akaun admin.
4. Skrin "Google hasn't verified this app" → klik **Advanced** → **Go to Solar Karak API (unsafe)** → **Allow**.
   (Ini normal: aplikasi ini milik anda sendiri.)
5. Lihat **Execution log** di bawah. Mesti ada: `Setup selesai. 123 tiang diimport; Admin: emel-anda@gmail.com`.
6. Kembali ke Google Sheet. Semak:
   - Tab **Poles**: 123 baris (SSL001 … SSL123)
   - Tab **Activities**: 3 baris (Pegging, Trial Pit, Installation)
   - Tab **PhotoTypes**: 8 baris (A1, B1–B4, C1–C3)
   - Tab **WorkPlan**: kosong (pelan kerja)
   - Tab **Roles**: Admin, Team, Boss
   - Tab **Users**: emel anda sebagai **Admin**. Tukar lajur `Name` kepada nama anda.
   - Tab **Settings**: ada `PhotosFolderID` dan `ReportsFolderID` (sudah terisi)
7. Dalam Google Drive anda kini ada folder **Solar Photos** dan **Solar Reports**.

> Jika `setup` dijalankan sekali lagi, ia **tidak** menggandakan data (selamat).

## Langkah 4 — Deploy sebagai Web App

1. Di editor Apps Script: butang biru **Deploy → New deployment**.
2. Klik ikon ⚙️ (sebelah "Select type") → **Web app**.
3. Isi:
   - Description: `v1`
   - **Execute as: Me** (emel admin)
   - **Who has access: Anyone**
4. **Deploy** → (jika diminta, Authorize sekali lagi seperti Langkah 3).
5. Salin **Web app URL**, berakhir dengan `/exec`. Contoh:
   `https://script.google.com/macros/s/AKfycb...xyz/exec`
   👉 Simpan URL ini. Ini **API_URL**.

> "Anyone" diperlukan supaya telefon boleh menghubungi API. Keselamatan dijaga oleh log masuk Google +
> senarai emel dalam tab Users. Emel yang tiada dalam senarai tidak dapat melihat apa-apa.

## Langkah 5 — Google Cloud: buat OAuth Client ID (percuma)

1. Buka <https://console.cloud.google.com> (log masuk akaun admin). Terima terma jika diminta.
2. Atas kiri: **Select a project → NEW PROJECT** → nama `Solar Karak` → **Create**. Pastikan projek ini dipilih.
3. Menu ☰ → **APIs & Services → OAuth consent screen** (mungkin dipaparkan sebagai **Google Auth Platform**) → **Get started**:
   - App name: `Lampu Solar Karak`
   - User support email: emel admin → **Next**
   - Audience: **External** → **Next**
   - Contact information: emel admin → **Next** → tanda setuju → **Create**
4. Menu kiri **Audience** → bahagian *Publishing status* → **Publish app** → **Confirm**.
   (Aplikasi hanya meminta nama & emel, jadi tiada semakan Google diperlukan. Jika tidak diterbitkan, hanya
   "Test users" yang anda tambah boleh log masuk.)
5. Menu kiri **Clients** → **+ Create client**:
   - Application type: **Web application**
   - Name: `Solar Karak Web`
   - **Authorized JavaScript origins** → **+ Add URI**: `https://globalsentrum.github.io`
   - **Authorized redirect URIs** → **+ Add URI**: tampal **API_URL** dari Langkah 4 (yang berakhir `/exec`)
   - **Create**
6. Salin **Client ID** (berakhir `.apps.googleusercontent.com`).
   👉 Ini **CLIENT_ID**. (Client secret TIDAK diperlukan. Jangan kongsi.)

## Langkah 6 — Isi tab Settings dalam Google Sheet

Dalam tab **Settings**, isi lajur `Value`:

| Key | Value |
|---|---|
| ClientID | CLIENT_ID dari Langkah 5 |
| AppURL | `https://globalsentrum.github.io/solar-light-app/` (mesti ada `/` di hujung) |
| ReportMaxPhotos | `60` (sudah ada; maksimum gambar bagi satu laporan → Pegging 60 tiang, Trial Pit 15, Installation 10) |
| SessionDays | `30` (sudah ada; tempoh log masuk kekal) |

Jangan ubah `PhotosFolderID` dan `ReportsFolderID`.

## Langkah 7 — GitHub: isi config & hidupkan GitHub Pages

1. Buka repo di GitHub → folder `docs/js/` → fail **`config.js`** → ikon ✏️ (Edit).
2. Ganti teks dalam **tanda petikan** pada dua baris di bahagian BAWAH fail (bukan dalam komen `/* … */` di atas):
   - `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE` → **API_URL**
   - `PASTE_GOOGLE_OAUTH_CLIENT_ID_HERE` → **CLIENT_ID**

   Hasilnya mesti kelihatan begini (tanda petikan `'` dan koma dikekalkan):
   ```js
   window.SOLAR_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/AKfy...../exec',
     CLIENT_ID: '1234567890-abc....apps.googleusercontent.com'
   };
   ```
3. **Commit changes…** → **Commit changes**.
4. Repo mesti **Public**: **Settings → General** → bawah sekali "Danger Zone" → *Change visibility* → Public.
   (GitHub Pages percuma memerlukan repo awam. Data tiang & gambar TIDAK berada dalam repo.)
5. **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/docs** → **Save**
6. Tunggu 1–3 minit. Alamat aplikasi: **<https://globalsentrum.github.io/solar-light-app/>**

## Langkah 8 — Uji log masuk

1. Buka alamat aplikasi di komputer (Chrome).
2. Klik **Sign in with Google** → pilih akaun admin → skrin "Log masuk berjaya" → klik **Teruskan ke aplikasi**.
3. Dashboard mesti menunjukkan: Kerja siap **33/123**, Perlu pasang **44**, Tunggu kelulusan **46**, Gambar lengkap **0/44**.

Jika ralat:
- *"Client ID tidak sepadan"* → ClientID dalam tab Settings tidak sama dengan config.js.
- *"redirect_uri_mismatch"* / *"origin not allowed"* → semak URI dalam Langkah 5 (mesti tepat sama).
- *"Emel … tiada dalam senarai pengguna"* → tambah emel dalam tab Users (Active = TRUE).
- Butang Google tidak muncul → semak CLIENT_ID dalam config.js.

## Langkah 9 — Tambah pengguna

Dalam aplikasi: tab **Admin → Pengguna → Tambah pengguna** (emel Gmail, nama, peranan).
Atau terus dalam tab **Users** dalam Sheet (Email, Name, Role = nama peranan dalam tab **Roles**, Active = `TRUE`).
Peranan baru dicipta dalam aplikasi: **⚙️ Admin → Peranan**.

- Menyahaktif (Active = FALSE) atau membuang pengguna **berkuat kuasa serta-merta**, pada permintaan seterusnya dari telefon mereka.
- Anda tidak boleh membuang/menyahaktif akaun anda sendiri (supaya tidak terkunci).

## Langkah 10 — Pasang aplikasi di telefon (Home Screen)

**Android (Chrome):**
1. Buka alamat aplikasi dalam **Chrome**.
2. Log masuk.
3. Menu **⋮** (atas kanan) → **Install app** / **Add to Home screen** → **Install**.
4. Buka dari ikon "Lampu Solar" di skrin utama. Benarkan **Lokasi** dan **Kamera** apabila ditanya.

**iPhone (Safari sahaja — bukan Chrome):**
1. Buka alamat aplikasi dalam **Safari**.
2. Butang **Share** (kotak dengan anak panah ke atas) → **Add to Home Screen** → **Add**.
3. Buka dari ikon "Lampu Solar", kemudian log masuk **dari ikon itu** (log masuk dalam Safari tidak dikongsi dengan ikon).
4. Benarkan **Location** dan **Camera** apabila ditanya.
   Jika tertolak: **Settings → Privacy & Security → Location Services → Safari Websites → While Using**.

---

## Penyelenggaraan

**Kemas kini kod Apps Script (Code.gs/Logic.gs):** tampal kod baru → Save → **Deploy → Manage deployments** →
✏️ (Edit) → Version: **New version** → **Deploy**. URL `/exec` **kekal sama** (tidak perlu ubah config.js).
⚠️ Jangan guna "New deployment" untuk kemas kini, kerana itu menghasilkan URL baru.

**Kemas kini aplikasi telefon (docs/):** selepas commit di GitHub, telefon akan dapat versi baru secara automatik
(mesej "Versi baru aplikasi dipasang" → tutup & buka semula aplikasi).

**Laporan:** dibina terus oleh aplikasi (tiada templat). Hanya halaman gambar; borang RIN (OP 11, tandatangan)
digabungkan sendiri. Setiap laporan disimpan dalam `Solar Reports/` sebagai **PDF dan Word (.docx)**.

**Log keluar semua orang serta-merta (kecemasan):** Apps Script → ⚙️ Project Settings → Script Properties →
padam `SESSION_SECRET` → jalankan `setup` sekali lagi. Semua orang perlu log masuk semula.

**Jangan:** padam tab, tukar nama lajur, atau padam baris dalam tab Photos (gunakan "Sembunyikan" dalam aplikasi).
Lajur status kerja/gambar tidak disimpan dalam Sheet; ia dikira automatik.

## Had percuma Google (cukup untuk < 10 pengguna)

- Apps Script: 6 minit setiap permintaan (sebab itulah PDF dihadkan 10 tiang), ~20,000 panggilan URL sehari.
- Google Drive: 15 GB percuma (≈ 30,000 gambar pada ~400 KB).

---

# Kemas kini ke versi 2 (Sheet sedia ada)

Versi 2: 3 aktiviti (Pegging / Trial Pit / Installation) dengan 8 jenis gambar, ukuran (meter), pilihan gambar
laporan, laporan ikut aktiviti (PDF + Word), Pelan kerja (Hari ini / Esok) dan ID tiang baru **SSL001**.

Buat semua langkah dalam **satu sesi**, apabila tiada orang menggunakan aplikasi (cth. waktu malam).

### V1. Sebelum mula
1. Minta semua pasukan buka aplikasi dengan line internet dan pastikan bar atas menunjukkan **✅ Semua disimpan**.
   (Jika ada telefon yang masih ada item menunggu, ia akan tetap dihantar selepas kemas kini — ID lama
   ditukar automatik — tetapi lebih selamat jika semua sudah dihantar.)
2. Buat salinan sandaran Sheet: **File → Make a copy** (Fail → Buat salinan).

### V2. Tampal kod baru dalam Apps Script
Buka Sheet → **Extensions → Apps Script**. Ganti **seluruh** isi dua fail ini dengan versi baru dari GitHub:

| Fail dalam Apps Script | Salin dari GitHub |
|---|---|
| `Code.gs` | `apps-script/Code.gs` |
| `Logic.gs` | `apps-script/Logic.gs` |

`SeedData.gs` **tidak perlu** ditukar untuk Sheet sedia ada (fail baru hanya untuk Sheet baru).
Tekan **💾 Save**.

### V3. Jalankan `migrateV2` (sekali)
1. Pilih fungsi **`migrateV2`** → **▶ Run**. Jika diminta kebenaran, ikut seperti Langkah 3 (Advanced → Allow).
2. Execution log mesti berakhir dengan `migrateV2 selesai: … perubahan.` dan senarai perubahan.
3. Semak dalam Sheet:
   - Tab **Poles**: ID kini `SSL001 … SSL123`
   - Tab **Photos**: lajur `PhotoTypeID`, `ReportOrder`, `MeasurementM`
   - Tab baru **Activities**, **PhotoTypes**, **WorkPlan**; tab lama **Slots** kini bernama **Slots_old** (simpanan sahaja)
   - Tab **AuditLog**: satu baris baru `MigrationV2` (sejarah lama tidak diubah)
4. Dalam Drive `Solar Photos/`: folder kini `SSL034` dsb.

Apa yang berlaku kepada gambar ujian lama: slot 1 → Pegging, 2 → Korek, 3 "Ukuran" → Lebar (**tanpa ukuran**, jadi
tidak dikira lengkap), 4 & 5 → Progress pemasangan, 6 → Siap dipasang (siang), 7 → Ujian lampu (malam).
Pilihan laporan lama dikosongkan. Gambar ujian boleh disembunyikan oleh admin.

Selamat dijalankan dua kali: kali kedua log menunjukkan `tiada perubahan (sudah dimigrasi)`.
Jika log menunjukkan `ID tiang tidak dikenali`, **tiada apa-apa ditukar** — betulkan ID itu dalam tab Poles dan jalankan semula.

### V4. Terbitkan versi baru Web App (URL kekal sama)
1. **Deploy → Manage deployments**.
2. Pilih deployment sedia ada → ikon ✏️ **Edit**.
3. **Version: New version** → Description `v2` → **Deploy**.
4. URL `/exec` **tidak berubah** — tidak perlu ubah `config.js` atau Google Cloud.
⚠️ Jangan guna "New deployment" (itu menghasilkan URL baru).

### V5. Aplikasi telefon
Aplikasi telefon (GitHub Pages) dikemas kini apabila kod v2 digabungkan ke cabang `main` di GitHub.
Selepas itu, setiap telefon: buka aplikasi dengan line → mesej "Versi baru aplikasi dipasang" → tutup & buka semula.

### V6. Semak
- Jadual kerja (admin) dibuka pada tab **Semua**; ID tiang `SSL…`
- Buka satu tiang → 3 kumpulan: Pegging / Trial Pit / Installation
- Admin → **Aktiviti & jenis gambar** → semak nama dan spesifikasi Trial Pit
- Cuba **Rancang kerja** untuk esok, kemudian log masuk sebagai pasukan → tab **Esok**
- Jana satu laporan bagi setiap aktiviti dan semak PDF + Word dalam `Solar Reports/`

---

# Kemas kini ke versi 3 (Sheet versi 2 sedia ada)

Versi 3: peranan yang ditetapkan admin, kawalan penuh tiang (tambah / edit ID / nyahaktif / padam / import / eksport),
urus gambar (padam ke Trash, edit ukuran, pindah, tukar antara 2 tiang), status "Perlu gambar malam", label boleh ubah,
dashboard baru, tarikh pelan kerja sebagai tarikh jadual, No. RIN, dan skrin laporan baru.

**Keselamatan data:** `migrateV3` hanya **menambah** (lajur, tab, baris tetapan). Tiada gambar, nota, pelan, laporan,
ukuran, pilihan laporan atau log dipadam atau diubah. Fail Drive tidak pernah dipadam kekal oleh aplikasi — "padam" = Trash.

### W1. Sebelum mula (wajib)
1. Minta **semua** pasukan buka aplikasi dengan line dan pastikan bar atas **✅ Semua disimpan**.
   (Item yang masih menunggu dari aplikasi v2 tetap diterima selepas kemas kini, tetapi lebih selamat jika kosong.)
2. Buat salinan Sheet: **File → Make a copy** (Fail → Buat salinan). Simpan salinan ini.
3. Buat semua langkah di bawah dalam satu sesi, apabila tiada orang menggunakan aplikasi.

### W2. Tampal kod baru dalam Apps Script
Sheet → **Extensions → Apps Script**. Ganti **seluruh** isi dua fail ini dengan versi dari GitHub (cabang `v3`, atau `main`
selepas digabungkan):

| Fail dalam Apps Script | Salin dari GitHub |
|---|---|
| `Code.gs` | `apps-script/Code.gs` |
| `Logic.gs` | `apps-script/Logic.gs` |

`SeedData.gs` **tidak** perlu ditukar. Tekan **💾 Save**.

### W3. Jalankan `migrateV3` (sekali)
1. Pilih fungsi **`migrateV3`** → **▶ Run**. Jika diminta kebenaran: Review permissions → akaun admin → Advanced → Allow.
2. Execution log mesti berakhir dengan `migrateV3 selesai: … perubahan.` dan senarai, cth.:
   `Poles.ActualDate ditambah`, `Tab Roles dicipta`, `Peranan Admin / Team / Boss`, `PhotoTypes C2: "Siap dipasang (siang)" → "Siap pasang (siang)"`.
3. Semak dalam Sheet:
   - Tab **Poles**: lajur baru di hujung — `ActualDate`, `Active` (semua TRUE), `PreviousIDs`, `StatusOverride`, `RINPegging`, `RINTrialPit`, `RINInstallation`
   - Tab baru **Roles**: Admin (ALL), Team, Boss — kuasa sama seperti sebelum ini
   - Tab **Settings**: baris `Label.…` (label status & kad)
   - Tab **AuditLog**: satu baris baru `MigrationV3`
   - Bilangan baris Photos, Notes, WorkPlan, Reports **sama** seperti dalam salinan anda
4. Jalankan `migrateV3` sekali lagi → log mesti `tiada perubahan (sudah dimigrasi)`.

### W4. Terbitkan versi baru (URL /exec kekal sama)
1. **Deploy → Manage deployments** → pilih deployment sedia ada → ✏️ **Edit**.
2. **Version: New version** → Description `v3` → **Deploy**.
3. URL `/exec` tidak berubah — tidak perlu ubah `config.js` atau Google Cloud.
⚠️ Jangan guna "New deployment".

### W5. Aplikasi telefon
Beritahu Claude/pembangun untuk menggabungkan cabang `v3` ke `main`. GitHub Pages dikemas kini dalam 1–3 minit.
Setiap telefon: buka aplikasi dengan line → "Versi baru aplikasi dipasang" → tutup & buka semula.

### W6. Selepas kemas kini (admin)
- **⚙️ Admin → Peranan**: cipta peranan anda (cth. Supervisor, Pembuat claim) dan tanda kebenaran.
- **⚙️ Admin → Pengguna**: tetapkan peranan setiap pengguna.
- **⚙️ Admin → Tetapan & label**: ubah label jika perlu (maks 20 aksara).
- Semak satu laporan setiap aktiviti (PDF + Word).

### Jika ada masalah
- Log `Sheet ini masih format v1` → jalankan `migrateV2` dahulu, kemudian `migrateV3`.
- Aplikasi menunjukkan ralat selepas W4 tetapi sebelum W5: normal untuk beberapa minit; selesaikan W5.
- Untuk kembali ke v2: tampal semula `Code.gs`/`Logic.gs` v2, Deploy → New version. Lajur baru boleh dibiarkan (v2 tidak membacanya).
