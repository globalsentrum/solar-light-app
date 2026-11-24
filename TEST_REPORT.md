# Laporan Ujian — Aplikasi Lampu Solar Karak (versi 3)

Tarikh: 24/11/2026 · Keputusan: **85 / 85 lulus**: 25 logik + 16 backend v2 (regresi) + 21 backend v3 + 14 pelayar v2 (regresi) + 10 pelayar v3
Jalankan semula: `npm install` → `npm run test:all`. Ujian menggunakan **data tiang dummy** (123 tiang, jumlah sama, chainage rekaan).

| Bahagian | Cara ujian |
|---|---|
| Logik (status, laporan, label, tarikh, ID, import) | Ujian unit Node — `tests/logic.test.js` |
| Backend Apps Script | Kod **sebenar** `Code.gs` + `Logic.gs` atas tiruan Google Sheets/Drive/Docs yang ketat — `tests/backend.test.js` (v2), `tests/v3.backend.test.js` |
| Migrasi | Data v2 dicipta oleh **kod v2 sebenar** (`tests/fixtures/v2-code/`), kemudian kod v3 + `migrateV3` dijalankan pada data yang sama |
| Aplikasi telefon | Chromium (Playwright), 390 px dan 360 px — `tests/e2e.test.js` (v2), `tests/v3.e2e.test.js` |

⚠️ **Tidak dapat diuji di sini:** Google Sheets/Drive/Docs sebenar, log masuk Google sebenar, telefon sebenar.
Gunakan senarai semak telefon di bawah.

## Ujian v3 (baru)

**Peranan & kebenaran (backend)**
- Bagi **setiap** 23 kunci kebenaran: peranan yang hanya ada kunci itu → dibenarkan; peranan dengan semua kunci **lain** → FORBIDDEN.
- Peranan tanpa kebenaran: masih boleh log masuk & melihat; tiada senarai laporan / suapan.
- Team & Boss selepas migrasi: kuasa **sama tepat** dengan v2 (9 tindakan disemak).
- Peranan: cipta, nama berulang (huruf/ruang) ditolak, tukar nama (pengguna ikut), nyahaktif (pengguna dikunci keluar), kunci tidak dikenali ditolak.
- Admin terbina dalam: tidak boleh dicipta/ubah/tukar nama; edit tab Roles dengan tangan tidak mengurangkan kuasa Admin.
- **Admin aktif terakhir** dilindungi (nyahaktif, turun peranan, buang — oleh sesiapa pun).
- Ujian ulangan dengan PhotoID/NoteID sedia ada tetap perlukan kebenaran *(pepijat ditemui & dibaiki)*.

**Tiang**
- Tukar ID: berulang ditolak untuk `SSL035`, `ssl035`, ` SSL035 `, `Ssl035` dengan mesej menyebut tiang itu; ID sementara SSL999;
  Photos, Notes, WorkPlan, Reports, pilihan laporan, folder Drive & nama fail dikemas kini; log ID lama/baru; gambar dari telefon
  dengan **ID lama** masih sampai ke tiang yang betul; tukar balik dibenarkan.
- Tambah tiang (ID berulang ditolak, amaran CH+bound sebelum simpan, nota), nyahaktif (tiada dalam jumlah, tiada gambar baru),
  aktif semula, padam (disekat jika ada gambar, perlu taip ID, pelan dibuang, nota kekal, folder kosong ke Trash).
- Import: pratonton tidak menyimpan apa-apa; ID berulang dalam fail, ID kosong, bound/kategori salah → ralat; langkau / kemas kini.
- Eksport .xlsx: 123 baris; status kerja, Perlu gambar malam, tarikh pelan seterusnya, tarikh siap sebenar, kemajuan, RIN.
- Override status (hanya Perlu pasang), tarikh siap sebenar: diisi bila Siap, dikosongkan bila Batal siap; tindakan terkini menang.

**Gambar**
- Padam: baris dibuang; gambar + thumbnail ke **Trash** (fail masih wujud, bukan padam kekal); pilihan laporan dikosongkan; log ID Drive.
- Sorok mengosongkan pilihan; edit ukuran (kosong / huruf / 3 perpuluhan / 0 ditolak; `1,25` diterima; log lama/baru).
- Pindah: ditambah ke tiang tujuan (gambar sedia ada kekal), tukar jenis, ukuran ikut, fail Drive pindah folder & nama.
- **Gagal di tengah jalan** (Drive diganggu) → pindah & tukar: **tiada perubahan langsung** (rollback).
- Tukar 2 tiang: satu aktiviti / semua; pilihan laporan ikut gambar; tiang sama / tiada gambar ditolak.

**Status, dashboard, label, jadual**
- Perlu gambar malam: Siap tanpa C3 yang baik (ditanda / tersorok tidak dikira; gambar siang bukan malam; hanya Perlu pasang).
- **Dashboard sentiasa seimbang**: 200 set data rawak — Siap + Belum mula + Dalam proses + Tunggu = semua tiang aktif;
  Belum mula + Dalam proses = Baki; setiap kad membuka **tepat** bilangan tiang itu (juga diuji dalam pelayar).
- Label: lalai, disimpan ikut kunci, maks 20 aksara (backend + kiraan langsung); label 20 aksara pada **360 px**: tiada skrol mendatar,
  tiada teks terpotong pada dashboard, jadual (termasuk bar pilihan), skrin tiang, laporan, admin.
- Tarikh jadual = tarikh pelan seterusnya (hari ini atau selepas); hanya pelan lepas → "Belum dirancang"; PlannedDate Excel diabaikan.
- Jalur gambar: 10 gambar Progress pada **satu baris** yang boleh dileret; tinggi kotak tidak berubah; ukuran di bawah gambar.

**Laporan**
- Automatik hanya jika bilangan **tepat** (1, atau 4 untuk Progress); lebih → "Perlu pilih gambar"; kurang / tiada ukuran → "Kurang gambar".
- Pilihan admin v2 dikekalkan. Jana hanya untuk tiang Sedia (backend menolak yang lain). RIN disimpan bagi aktiviti itu sahaja;
  RIN kosong tidak menghalang; RIN perlukan kebenaran *Rekod No. RIN*. "Dah dilaporkan" disorok, togol menunjukkannya.
- Skrin laporan: hanya tiang dengan gambar aktiviti itu, ikut chainage; tiang tidak Sedia tidak boleh ditanda;
  "Pilih semua yang sedia"; ketik "Perlu pilih gambar" → pilih → menjadi Sedia; jalan pintas dari Jadual menanda yang Sedia sahaja.

**Migrasi v2 → v3** (data dibuat oleh kod v2 sebenar: 36 gambar, pilihan admin, nota, Siap, pelan, laporan, gambar tersorok)
- Bilangan baris semua tab dan bilangan fail Drive **sama sebelum dan selepas**; setiap nilai lama dalam Poles, Photos, Notes,
  WorkPlan, Reports tidak berubah; log lama tidak diubah + satu baris `MigrationV3`.
- Jalankan kali kedua → "tiada perubahan" dan Sheet sama tepat. Nama C2 yang ditukar admin dikekalkan.
- Item dalam barisan telefon dari aplikasi v2 (gambar dengan ukuran `1,2`, nota, Siap) — dan v1 — diterima selepas kemas kini.

## Pepijat ditemui & dibaiki semasa ujian v3
1. Muat naik/nota ulangan dengan ID sedia ada tidak menyemak kebenaran dahulu → dibaiki.
2. Bar pilihan di Jadual terlebih lebar (butang terkeluar skrin) → dibaiki, kini diuji pada 360 px.
3. Label panjang terpotong ("…") dalam lencana → kini dibalut ke baris kedua; ujian mengesan teks terpotong.
4. Kotak jenis gambar menjadi lebih tinggi bila ada banyak gambar (nota "perlu pilih") → kepala kotak tinggi tetap.
5. Ralat yang sudah dipaparkan kepada pengguna dilaporkan semula sebagai ralat pelayar → dibaiki.

## Senarai semak telefon sebenar (selepas kemas kini v3)
- [ ] `migrateV3` → "selesai"; kali kedua → "tiada perubahan"; bilangan baris Photos/Notes/WorkPlan/Reports sama dengan salinan
- [ ] Deploy → New version; URL sama; log masuk Admin, Team, Boss masih berfungsi
- [ ] Telefon: "Versi baru aplikasi dipasang" → buka semula
- [ ] Dashboard: kad Baki / Perlu gambar malam / … — ketik setiap kad, bilangan senarai sama dengan kad
- [ ] Admin → Peranan: cipta *Supervisor*; beri kepada satu Gmail ujian; log masuk di telefon lain — hanya butang yang dibenarkan
- [ ] Cuba nyahaktif Admin terakhir → ditolak
- [ ] Skrin tiang: ambil 6+ gambar Progress → satu baris, leret ke tepi, skrin tidak memanjang (Android & iPhone)
- [ ] Ketik gambar: Edit ukuran, Pindah ke tiang lain (tukar jenis), Padam → semak fail dalam **Trash** Drive
- [ ] Tukar gambar antara 2 tiang (satu aktiviti) → semak folder Drive kedua-dua tiang
- [ ] Edit tiang: tukar ID ke ID yang sudah wujud (huruf kecil) → mesej merah; tukar ke SSL999 → folder Drive bertukar nama
- [ ] Tambah tiang dengan CH sama → amaran; Nyahaktif → hilang dari senarai; Padam tiang bergambar → disekat
- [ ] Import fail Excel dengan satu baris salah → pratonton merah → import; Eksport → buka dalam Excel
- [ ] Laporan: Trial Pit — tiang dengan 2 gambar Korek menunjukkan "Perlu pilih gambar"; pilih → Sedia; jana dengan No. RIN →
      baris hilang (Dah dilaporkan); PDF + Word dibuka dengan betul
- [ ] Jadual → tanda tiang → **Jana laporan** → hanya yang Sedia ditanda
- [ ] Label: tukar satu label kepada 20 aksara → semak dashboard & jadual pada telefon kecil
- [ ] Pelan: tarikh pelan dipaparkan dalam jadual; pindah tarikh → jadual ikut; tiang tanpa pelan "Belum dirancang"
- [ ] Mod kapal terbang: ambil gambar & nota → sambung semula → ✅ Semua disimpan (seperti v2)
