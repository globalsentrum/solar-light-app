# Panduan Setup — Aplikasi Lampu Solar Karak (Package 2A)

Panduan ini untuk admin, langkah demi langkah. Tiada pengaturcaraan diperlukan, hanya salin & tampal.
Semua perkhidmatan adalah **percuma** (Google Sheets, Drive, Apps Script, Google Cloud, GitHub Pages).

**Masa:** lebih kurang 45–60 minit.
**Gunakan komputer** (bukan telefon) untuk setup.
**Gunakan SATU akaun Gmail admin** untuk semua langkah Google. Gambar & laporan akan disimpan dalam Google Drive akaun ini.

Anda perlukan:
- Repo GitHub: `https://github.com/globalsentrum/solar-light-app`
- Fail peribadi **`SeedData.gs`** (diberi berasingan, BUKAN dalam GitHub, kerana mengandungi senarai 123 tiang)

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
5. Lihat **Execution log** di bawah. Mesti ada: `Setup selesai. 123 tiang diimport; 7 slot dicipta; Admin: emel-anda@gmail.com`.
6. Kembali ke Google Sheet. Semak:
   - Tab **Poles**: 123 baris (SL-001 … SL-123)
   - Tab **Slots**: 7 baris
   - Tab **Users**: emel anda sebagai **Admin**. Tukar lajur `Name` kepada nama anda.
   - Tab **Settings**: ada `PhotosFolderID`, `ReportsFolderID`, `TemplateDocID` (sudah terisi)
7. Dalam Google Drive anda kini ada folder **Solar Photos**, **Solar Reports** dan dokumen **Solar Report Template**.

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
| ReportMaxPoles | `10` (sudah ada; maksimum tiang bagi satu PDF) |
| SessionDays | `30` (sudah ada; tempoh log masuk kekal) |

Jangan ubah `PhotosFolderID`, `ReportsFolderID`, `TemplateDocID`.

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
3. Dashboard mesti menunjukkan: Kerja siap **33/123**, Perlu pasang **44**, Tunggu kelulusan **46**.

Jika ralat:
- *"Client ID tidak sepadan"* → ClientID dalam tab Settings tidak sama dengan config.js.
- *"redirect_uri_mismatch"* / *"origin not allowed"* → semak URI dalam Langkah 5 (mesti tepat sama).
- *"Emel … tiada dalam senarai pengguna"* → tambah emel dalam tab Users (Active = TRUE).
- Butang Google tidak muncul → semak CLIENT_ID dalam config.js.

## Langkah 9 — Tambah pengguna

Dalam aplikasi: tab **Admin → Pengguna → Tambah pengguna** (emel Gmail, nama, peranan).
Atau terus dalam tab **Users** dalam Sheet (Email, Name, Role = `Admin` / `Team` / `Boss`, Active = `TRUE`).

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

**Logo / format laporan PDF:** edit dokumen **Solar Report Template** dalam Drive. Kekalkan teks
`{{PROJECT}}`, `{{REPORTID}}`, `{{GENERATED}}`, `{{USER}}` dan `{{CONTENT}}` (bahagian tiang dimasukkan di tempat `{{CONTENT}}`).

**Log keluar semua orang serta-merta (kecemasan):** Apps Script → ⚙️ Project Settings → Script Properties →
padam `SESSION_SECRET` → jalankan `setup` sekali lagi. Semua orang perlu log masuk semula.

**Jangan:** padam tab, tukar nama lajur, atau padam baris dalam tab Photos (gunakan "Sembunyikan" dalam aplikasi).
Lajur status kerja/gambar tidak disimpan dalam Sheet; ia dikira automatik.

## Had percuma Google (cukup untuk < 10 pengguna)

- Apps Script: 6 minit setiap permintaan (sebab itulah PDF dihadkan 10 tiang), ~20,000 panggilan URL sehari.
- Google Drive: 15 GB percuma (≈ 30,000 gambar pada ~400 KB).
