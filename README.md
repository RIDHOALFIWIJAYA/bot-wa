# cuyBOT WA

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D16.0.0-green.svg)](https://nodejs.org/)

**cuyBOT WA** adalah bot WhatsApp pintar yang mengintegrasikan AI canggih dari **Groq SDK** (Llama 3) dengan fitur utilitas harian. Bot ini dibangun menggunakan library `@whiskeysockets/baileys` yang efisien dan cepat.

---

## ✨ Fitur Utama

- **🧠 AI Chat (Llama 3)**: Ngobrol cerdas dengan memori konteks (ingat chat sebelumnya).
- **👁️ Vision AI**: Kirim gambar dengan caption, dan bot akan menganalisis isi gambar tersebut.
- **🔍 Web Search**: Mencari informasi terbaru secara otomatis saat mendeteksi kueri yang membutuhkan data real-time.
- **📥 Auto Downloader**: Cukup kirim link **TikTok** atau **Instagram**, bot akan otomatis mengunduh videonya untuk Anda.
- **⏰ Smart Reminders**: Pasang pengingat dengan perintah sederhana `.remind`.
- **📁 Multi-File Auth**: Login sekali, bot akan mengingat sesi Anda tanpa perlu scan ulang berkali-kali.

---

## 🚀 Cara Instalasi

### 1. Prasyarat
Pastikan Anda sudah menginstal:
- [Node.js](https://nodejs.org/) (Versi 16 atau lebih tinggi)
- NPM (Biasanya terinstal bersama Node.js)

### 2. Clone Repository
```bash
git clone https://github.com/RIDHOALFIWIJAYA/bot-wa.git
cd wa-groq-bot
```

### 3. Instal Dependensi
```bash
npm install
```

### 4. Konfigurasi Environment
Buat file `.env` di direktori utama dan tambahkan API Key Groq Anda:
```env
GROQ_API_KEY=gsk_your_api_key_here
MODEL_NAME=llama3-8b-8192
```
*Dapatkan API Key di [Groq Cloud Console](https://console.groq.com/).*

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
| `.remind [HH:mm] [pesan]` | Menyetel pengingat (Contoh: `.remind 07:00 Bangun!`). |
| `.search [kueri]` | Melakukan pencarian informasi di internet. |
| `.reset` | Menghapus memori percakapan AI. |
| `.ping` | Mengecek status koneksi bot. |

---

## 📦 Dependensi Utama

- `@whiskeysockets/baileys`: Library WhatsApp Web API.
- `groq-sdk`: Integrasi AI dari Groq.
- `node-cron`: Penjadwalan tugas (untuk pengingat).
- `axios`: HTTP client untuk downloader.
- `qrcode-terminal`: Menampilkan QR code di terminal.

---

## 🤝 Kontribusi

Kontribusi selalu terbuka! Silakan fork repository ini, lakukan perubahan, dan kirimkan Pull Request.

## 📄 Lisensi

Proyek ini dilisensikan di bawah **ISC License**.

---

*Dibuat dengan ❤️ oleh [RIDHO ALFI]*
