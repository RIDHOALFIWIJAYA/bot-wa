const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

// Inisialisasi Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Database & Memory Files
const MEMORY_FILE = './memory.json';
const REMINDERS_FILE = './reminders.json';

function loadJSON(filePath, defaultValue) {
    if (!fs.existsSync(filePath)) return defaultValue;
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content ? JSON.parse(content) : defaultValue;
    } catch (e) {
        console.error(`Gagal memuat ${filePath}, menggunakan nilai default.`);
        return defaultValue;
    }
}

let chatMemory = loadJSON(MEMORY_FILE, {});
let reminders = loadJSON(REMINDERS_FILE, []);

const saveMemory = () => fs.writeFileSync(MEMORY_FILE, JSON.stringify(chatMemory, null, 2));
const saveReminders = () => fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));

function addMessageToHistory(userId, role, content) {
    if (!chatMemory[userId]) chatMemory[userId] = [];
    chatMemory[userId].push({ role, content });
    if (chatMemory[userId].length > 10) chatMemory[userId].shift();
    saveMemory();
}

// Bot Connection State
let isConnecting = false;

async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: require('pino')({ level: 'silent' }),
        browser: ['WA-Groq-Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        
        if (connection === 'close') {
            isConnecting = false;
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus. Mencoba hubungkan kembali:', shouldReconnect);
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(), 5000);
        } else if (connection === 'open') {
            isConnecting = false;
            console.log('Bot WhatsApp Berhasil Terhubung!');
            startReminderCron(sock);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const type = getContentType(msg.message);
        
        let body = '';
        let isImage = false;

        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage') { body = msg.message.imageMessage.caption || ''; isImage = true; }

        if (!body && !isImage) return;

        // Auto Downloader Detection
        if (body.match(/tiktok\.com|instagram\.com/i)) {
            return handleDownloader(sock, from, body, msg);
        }

        const prefix = '.';
        const isCommand = body.startsWith(prefix);
        const command = isCommand ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : null;
        const args = body.trim().split(/ +/).slice(1);

        if (isCommand) {
            switch (command) {
                case 'menu':
                    const menuText = `*🤖 WA-GROQ SUPER BOT*

*Tahap A (AI & Search):*
- *Kirim Foto + Caption* : Analisis Gambar.
- *Chat Biasa* : AI Llama 3 (Memory ON).
- *.search [kueri]* : Cari info terbaru.

*Tahap B (Utility):*
- *.remind [HH:mm] [pesan]* : Pengingat.
- *Kirim Link TikTok/IG* : Auto Download Video.

*Others:*
- *.reset* : Hapus memori chat.
- *.ping* : Cek status.`;
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                    break;

                case 'remind':
                    const time = args[0];
                    const text = args.slice(1).join(' ');
                    if (!time || !text) return sock.sendMessage(from, { text: 'Format: .remind HH:mm pesan\nContoh: .remind 07:00 Bangun tidur' });
                    reminders.push({ from, time, text, status: 'pending' });
                    saveReminders();
                    await sock.sendMessage(from, { text: `Siap! Pengingat disetel untuk jam ${time}.` }, { quoted: msg });
                    break;

                case 'search':
                    await sock.sendMessage(from, { text: '_Mencari..._' });
                    const sRes = await getWebSearchResponse(from, args.join(' '));
                    await sock.sendMessage(from, { text: sRes }, { quoted: msg });
                    break;
                
                case 'reset':
                    chatMemory[from] = []; saveMemory();
                    await sock.sendMessage(from, { text: 'Memori dibersihkan.' });
                    break;
            }
        } else {
            if (isImage) {
                await sock.sendMessage(from, { text: '_Menganalisis gambar..._' });
                const imageBuffer = await downloadMedia(msg.message.imageMessage, 'image');
                const visionRes = await getGroqVisionResponse(from, body || 'Apa ini?', imageBuffer.toString('base64'));
                await sock.sendMessage(from, { text: visionRes }, { quoted: msg });
            } else {
                const needsSearch = /kapan|berita|siapa|skor|harga|terbaru|hari ini/i.test(body);
                await sock.sendMessage(from, { text: needsSearch ? '_Searching..._' : '_Typing..._' });
                const res = needsSearch ? await getWebSearchResponse(from, body) : await getGroqResponse(from, body);
                await sock.sendMessage(from, { text: res }, { quoted: msg });
            }
        }
    });
}

// --- Reminders Logic ---
function startReminderCron(sock) {
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        const toRemind = reminders.filter(r => r.time === currentTime && r.status === 'pending');
        for (const r of toRemind) {
            await sock.sendMessage(r.from, { text: `⏰ *PENGINGAT:* ${r.text}` });
            r.status = 'sent';
        }
        if (toRemind.length > 0) saveReminders();
    });
}

// --- Downloader Logic ---
async function handleDownloader(sock, from, url, msg) {
    try {
        await sock.sendMessage(from, { text: '_Mendeteksi link, sedang mengunduh..._' });
        // Menggunakan API Tiklydown dengan penanganan error lebih baik
        const res = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`);
        
        // Coba ambil URL video dari berbagai kemungkinan struktur JSON
        const videoUrl = res.data.video?.noWatermark || res.data.data?.videoUrl || res.data.result?.video || res.data.url;
        
        if (videoUrl) {
            await sock.sendMessage(from, { 
                video: { url: videoUrl }, 
                caption: '✅ Berhasil diunduh!' 
            }, { quoted: msg });
        } else {
            console.log('API Response Downloader:', JSON.stringify(res.data));
            throw new Error('Video tidak ditemukan dalam respon API.');
        }
    } catch (e) {
        console.error('Downloader Error:', e.message);
        await sock.sendMessage(from, { text: `❌ Gagal download: ${e.message}` });
    }
}

// --- Core Helpers (Vision, Search, Chat) ---
async function downloadMedia(message, type) {
    try {
        const stream = await downloadContentFromMessage(message, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) {
        console.error('Download Media Error:', e.message);
        throw e;
    }
}

async function getGroqResponse(userId, text) {
    try {
        const messages = [{ role: 'system', content: 'Asisten pintar.' }, ...(chatMemory[userId] || []), { role: 'user', content: text }];
        const res = await groq.chat.completions.create({ 
            messages, 
            model: process.env.MODEL_NAME || 'llama3-8b-8192' 
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', text);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) { 
        console.error('Groq API Error:', e.message);
        return `Error AI: ${e.message}`; 
    }
}

async function getGroqVisionResponse(userId, text, base64Image) {
    try {
        const res = await groq.chat.completions.create({
            messages: [{ 
                role: 'user', 
                content: [
                    { type: 'text', text: text }, 
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                ] 
            }],
            model: 'llama-3.2-11b-vision-preview'
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', `[Gambar]: ${text}`);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) { 
        console.error('Vision API Error:', e.message);
        return `❌ Gagal analisis gambar: ${e.message}`; 
    }
}

async function getWebSearchResponse(userId, query) {
    try {
        const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
        const snippet = res.data.AbstractText || "Cari info terbaru...";
        const finalRes = await groq.chat.completions.create({
            messages: [{ role: 'user', content: `Data: ${snippet}\n\nJawab: ${query}` }],
            model: process.env.MODEL_NAME || 'llama3-8b-8192'
        });
        return finalRes.choices[0].message.content;
    } catch (e) { return 'Gagal search.'; }
}

connectToWhatsApp().catch(err => console.log(err));
