# NetraWare background/session patch 5.4.3

Perubahan utama:

1. Timer sesi tidak lagi bergantung pada `requestAnimationFrame` saja. Durasi dihitung dari clock sesi dan disinkronkan lewat snapshot akhir.
2. Saat pengguna pindah tab, membuka Microsoft Word, atau window browser kehilangan fokus, scheduler interval tetap mencoba membaca frame kamera setiap ±1 detik.
3. Jika browser tidak memberi frame kamera baru saat tab/window tidak aktif, aplikasi tidak membuat data EAR palsu. Dashboard mempertahankan nilai EAR terakhir dan hanya memajukan durasi sesi.
4. Sesi tidak dijeda hanya karena tab tidak aktif. Sesi hanya selesai lewat tombol `Akhiri sesi` atau saat tab dashboard ditutup.
5. Saat tab ditutup, frontend mengirim snapshot akhir memakai `navigator.sendBeacon` ke endpoint baru `/api/monitoring/session/close/{session_code}`.
6. Notifikasi desktop ditambahkan untuk peringatan istirahat ketika dashboard tidak sedang aktif, selama user mengizinkan permission notifikasi browser.
7. Cache busting dinaikkan ke versi `5.4.3`.

Batas teknis penting:

Browser dapat membatasi akses kamera dan eksekusi JavaScript pada tab yang benar-benar masuk background. Patch ini menjaga timer dan sesi tetap berjalan serta mencoba tetap membaca EAR saat tab/window kehilangan fokus. Namun deteksi mata tertutup saat tab benar-benar dibekukan oleh browser/OS tidak dapat dijamin oleh aplikasi web murni. Untuk deteksi mata real-time yang wajib tetap aktif meskipun pengguna membuka aplikasi lain, jalur paling kuat adalah membungkus NetraWare sebagai desktop app, misalnya Electron atau Tauri.
