# cuyBOT WA

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-green.svg)](https://nodejs.org/)

**cuyBOT WA** adalah bot WhatsApp pintar yang mengintegrasikan AI canggih dari **Groq SDK** dengan fitur utilitas harian. Bot ini dibangun menggunakan library `@whiskeysockets/baileys` yang efisien dan cepat.

---

## ✨ Fitur Utama

- **🧠 AI Chat**: Ngobrol cerdas dengan memori konteks (ingat chat sebelumnya).
- **👁️ Vision AI**: Kirim gambar dengan caption, dan bot akan menganalisis isi gambar tersebut.
- **🔍 Web Search**: Mencari informasi terbaru lewat Tavily (fallback DuckDuckGo) dan menyertakan sumber.
- **📥 Auto Downloader**: Kirim link **TikTok**, **Instagram**, atau **YouTube**, bot mengunduh videonya lewat `yt-dlp`.
- **⏰ Smart Reminders**: Pasang pengingat dengan perintah sederhana `.remind`.
- **📁 Multi-File Auth**: Login sekali, bot akan mengingat sesi Anda tanpa perlu scan ulang berkali-kali.

---

## 🚀 Cara Instalasi

### 1. Prasyarat
Pastikan Anda sudah menginstal:
- [Node.js](https://nodejs.org/) (Versi 20 atau lebih tinggi)
- NPM (Biasanya terinstal bersama Node.js)
- [FFmpeg](https://ffmpeg.org/) (dibutuhkan untuk stiker dan konversi gambar). Cek dengan `ffmpeg -version`.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (dibutuhkan untuk downloader). Install dengan `pipx install yt-dlp` atau `pip3 install --user yt-dlp`. Jika pip menolak karena `externally-managed-environment`, tambahkan `--break-system-packages`.

### 2. Clone Repository
```bash
git clone https://github.com/RIDHOALFIWIJAYA/bot-wa.git
cd bot-wa
```

### 3. Instal Dependensi
```bash
npm install
```

### 4. Konfigurasi Environment
Buat file `.env` di direktori utama dan isi konfigurasinya:
```env
GROQ_API_KEY=gsk_your_api_key_here
MODEL_NAME=openai/gpt-oss-120b
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=
VISION_MODEL=qwen/qwen3.8-27b
# Opsional: path file cookies yt-dlp untuk konten IG yang butuh login
YTDLP_COOKIES=
```
- API Key Groq: [Groq Cloud Console](https://console.groq.com/).
- API Key search: [Tavily](https://tavily.com/). Kalau kosong, bot otomatis pakai DuckDuckGo.
- `YTDLP_COOKIES` hanya perlu diisi kalau ingin mengunduh konten Instagram yang mengharuskan login.

> `memory.json`, `reminders.json`, dan folder `auth_info_baileys/` dibuat otomatis saat bot berjalan. Jangan commit file tersebut karena berisi data chat, pengingat, dan sesi login.

### 5. Jalankan Bot
```bash
npm start
```
Scan kode QR yang muncul di terminal menggunakan WhatsApp di ponsel Anda (**Linked Devices**).

---

## 🛠️ Perintah (Commands)

| Perintah | Deskripsi |
| :--- | :--- |
| `.menu` | Menampilkan daftar fitur lengkap. |
| `.s` / `.sticker` | Membuat stiker dari foto (polos / +teks) atau video. |
| `.remind [HH:mm] [pesan]` | Menyetel pengingat (Contoh: `.remind 07:00 Bangun!`). |
| `.search [kueri]` | Mencari informasi di internet + sumber. |
| `.dl [url]` | Mengunduh video TikTok, Instagram, atau YouTube. |
| `.reset` | Menghapus memori percakapan AI. |
| `.ping` | Mengecek status koneksi bot. |

Di grup, bot hanya merespons saat di-mention atau saat memakai prefix `.`.

---

## 📦 Dependensi Utama

- `@whiskeysockets/baileys`: Library WhatsApp Web API.
- `groq-sdk`: Integrasi AI dari Groq.
- `node-cron`: Penjadwalan tugas (untuk pengingat).
- `axios`: HTTP client untuk downloader.
- `qrcode-terminal`: Menampilkan QR code di terminal.
- `@hapi/boom`: Penanganan error koneksi Baileys.
- `pino`: Logger untuk Baileys.
- `yt-dlp`: Downloader video (dependency eksternal, bukan npm).
- Tavily API: Provider pencarian web (opsional, fallback DuckDuckGo).

---

## 🤝 Kontribusi

Kontribusi selalu terbuka! Silakan fork repository ini, lakukan perubahan, dan kirimkan Pull Request.

## 📄 Lisensi

Proyek ini dilisensikan di bawah **ISC License**.

---

*Dibuat dengan ❤️ oleh [RIDHO ALFI]*
