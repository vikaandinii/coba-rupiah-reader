# 🇮🇩 Rupiah Reader – AI Money Scanner for Visually Impaired

Aplikasi pemindai dan pembaca uang Rupiah (kertas & koin) bertenaga Deep Learning dengan panduan audio berbahasa Indonesia (TTS), antarmuka modern, dan akurasi tinggi.

---

## 🌟 Fitur Utama
1. **Deteksi Uang Kertas & Koin Real-time:**
   - Mendeteksi 7 pecahan nominal uang kertas Rupiah: Rp 1.000, Rp 2.000, Rp 5.000, Rp 10.000, Rp 20.000, Rp 50.000, dan Rp 100.000.
   - Sesi verifikasi koin 2 sisi (Angka vs Sisi Garuda/Pahlawan: Rp 100, Rp 200, Rp 500, Rp 1.000).
2. **Dual-Mode Inference:**
   - **Client-Side (GitHub Pages Standalone):** Berjalan langsung di browser menggunakan TensorFlow.js (WebGL GPU). Siapa saja bisa mencoba langsung lewat browser HP/laptop tanpa perlu backend!
   - **Server-Side (FastAPI REST API):** Terhubung ke backend FastAPI Python menggunakan model Custom CNN (`tuned_with_aug.keras`) dengan akurasi 99.4%.
3. **Aksesibilitas Tunanetra (Tap-to-Speak):**
   - Panduan suara Bahasa Indonesia murni.
   - Mode senyap saat pemindaian kontinu; suara hanya diucapkan ketika layar diketuk (Tap Screen).
   - Fitur akumulasi total belanja (ketuk dua kali).

---

## 🚀 Live Demo (GitHub Pages)
Aplikasi web ini dapat langsung dicoba oleh siapa saja di browser:
👉 **[https://vikaandinii.github.io/coba-rupiah-reader/](https://vikaandinii.github.io/coba-rupiah-reader/)**

---

## 💻 Menjalankan Backend API Lokal (FastAPI)

1. **Clone repositori:**
   ```bash
   git clone https://github.com/vikaandinii/coba-rupiah-reader.git
   cd coba-rupiah-reader
   ```

2. **Install dependensi:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Jalankan server FastAPI:**
   ```bash
   uvicorn api.main:app --reload
   ```

4. **Buka di browser:**
   - Frontend: `http://localhost:8000`
   - Dokumentasi Swagger API: `http://localhost:8000/docs`

<!-- vercel trigger build -->
