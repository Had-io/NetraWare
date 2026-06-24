# NetraWare 

Aplikasi penelitian untuk memantau indikasi kelelahan mata menggunakan EAR, blink rate, PERCLOS, durasi penggunaan layar, dan skor kelelahan. MediaPipe Face Landmarker serta deteksi kedip berjalan langsung di browser. Railway hanya menerima snapshot metrik numerik untuk PostgreSQL dan laporan, sehingga video kamera tidak dikirim ke server pada setiap frame. FastAPI tetap melayani backend dan frontend dari satu service.

## Struktur ringkas

```text
netraware/
├── app/
│   ├── api/          # endpoint monitoring dan laporan
│   ├── core/         # algoritma deteksi, kalibrasi, dan perhitungan
│   ├── database/     # koneksi dan model PostgreSQL
│   ├── models/       # model MediaPipe yang diunduh otomatis
│   ├── utils/
│   └── main.py       # FastAPI + frontend statis
├── frontend/
│   ├── assets/
│   ├── index.html
│   └── dashboard.html
├── data/             # log dan laporan runtime
├── tests/
├── app.py            # satu-satunya launcher lokal/deployment
├── requirements.txt
└── .env.example
```

Halaman dan endpoint daftar riwayat publik telah dihapus. Data penelitian tetap tersimpan di PostgreSQL untuk kebutuhan analisis oleh peneliti, tetapi pengunjung web tidak memperoleh menu atau API untuk melihat seluruh sesi pengguna lain.

## Instalasi

Direkomendasikan Python 3.11. Python 3.12 bersifat opsional jika target deployment memakai Python 3.12.

```powershell
cd C:\direktori NetraWare
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Buat database PostgreSQL, misalnya `eye_fatigue`, lalu salin konfigurasi:

```powershell
Copy-Item .env.example .env
```

Sesuaikan `DATABASE_URL` pada `.env`:

```env
DATABASE_URL=postgresql+psycopg2://postgres:PASSWORD_ANDA@localhost:5432/eye_fatigue
APP_HOST=127.0.0.1
APP_PORT=8000
OPEN_BROWSER=1
```


## Menjalankan aplikasi

Setelah virtual environment aktif, jalankan:

```powershell
python app.py
```

Browser akan membuka:

```text
http://127.0.0.1:8000
```

Untuk menonaktifkan pembukaan browser otomatis, ubah `OPEN_BROWSER=0`.

## Deployment ke Railway tanpa GitHub

Perubahan production tetap harus dideploy, tetapi tidak perlu dipush ke GitHub. Railway CLI dapat mengunggah folder lokal langsung ke service Railway yang sudah ada.

```powershell
npm install -g @railway/cli
railway login
cd C:\lokasi\NetraWare_Browser_MediaPipe
railway link
railway status
railway up
```

Saat `railway link`, pilih project, environment, dan service aplikasi FastAPI yang benar—bukan service PostgreSQL. Variabel Railway serta koneksi database yang sudah ada tetap digunakan. Setelah deployment, lakukan hard refresh `Ctrl + Shift + R` pada browser.

Panduan pemeriksaan lokal, arsitektur, dan deployment terperinci tersedia pada `PANDUAN_BROWSER_MEDIAPIPE.md`.


## Endpoint penting

- Aplikasi: `http://127.0.0.1:8000`
- Status sistem: `http://127.0.0.1:8000/api/health`
- Dokumentasi API: `http://127.0.0.1:8000/docs`

API publik hanya menyediakan proses monitoring dan unduhan laporan berdasarkan kode sesi yang sedang digunakan. Endpoint daftar pengguna, daftar sesi, detail riwayat, dan penghapusan riwayat tidak disertakan.

## Notifikasi audio

Notifikasi menggunakan Web Audio API, sehingga tidak memerlukan file MP3 tambahan. Nada diputar ketika mesin analisis lokal menghasilkan `should_alert=true`, yaitu saat status mencapai `PERLU_ISTIRAHAT`, dan tetap mengikuti cooldown peringatan agar tidak berbunyi pada setiap frame. Pengguna dapat menonaktifkan suara, mengatur volume 0–100, dan menguji suara dari dashboard. Pilihan disimpan melalui `localStorage` pada browser yang digunakan.

Browser umumnya hanya mengizinkan audio setelah interaksi pengguna. Tombol **Mulai kamera**, sakelar audio, dan tombol **Uji suara** digunakan untuk mengaktifkan konteks audio secara sah.

## Batas penggunaan

Hasil sistem merupakan indikator penelitian, bukan diagnosis medis. Threshold, durasi warm-up, pencahayaan, posisi kamera, penggunaan kacamata, frame rate, dan karakteristik responden tetap perlu divalidasi dalam protokol penelitian.


## Proteksi endpoint laporan

Endpoint laporan PDF dan CSV mendukung proteksi token. Isi variabel berikut pada environment deployment:

```env
REPORT_ACCESS_TOKEN=ISI_TOKEN_KUAT
```

Jika token diisi, laporan hanya dapat diunduh dengan salah satu cara berikut:

```text
/api/report/{session_code}/pdf?access_key=ISI_TOKEN_KUAT
/api/report/{session_code}/csv?access_key=ISI_TOKEN_KUAT
Header: X-Report-Token: ISI_TOKEN_KUAT
```
DEV disarankan memakai `REPORT_ACCESS_TOKEN`.


## Interpretasi Skor pada Laporan PDF

Laporan PDF menampilkan tabel interpretasi skor indikasi kelelahan mata agar pengguna memahami hasil grafik dan ringkasan monitoring:

| Rentang Skor | Status | Makna Umum |
|---|---|---|
| 0-39,99 | NORMAL | Indikasi kelelahan rendah. |
| 40-69,99 | WASPADA | Terdapat tanda awal kelelahan mata. |
| 70-100 | PERLU_ISTIRAHAT | Indikasi kelelahan tinggi dan pengguna disarankan beristirahat. |

Status `PERLU_ISTIRAHAT` juga dapat muncul sebelum skor mencapai 70 jika mata terdeteksi tertutup cukup lama atau durasi penggunaan layar sudah mencapai batas pengingat istirahat.
