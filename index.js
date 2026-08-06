const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType,
    downloadContentFromMessage,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
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

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
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
            console.log('Koneksi terputus. Mencoba hubungkan kembali:', shouldReconnect, lastDisconnect?.error?.toString());
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
        const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        let body = '';
        let isImage = false;
        let isVideo = false;

        if (type === 'conversation') body = msg.message.conversation;
        else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        else if (type === 'imageMessage') { body = msg.message.imageMessage.caption || ''; isImage = true; }
        else if (type === 'videoMessage') { body = msg.message.videoMessage.caption || ''; isVideo = true; }

        if (!body && !isImage && !isVideo && !quoted) return;

        // Auto Downloader Detection
        if (body.match(/tiktok\.com/i)) {
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
- *.s / .sticker* : Buat stiker dari foto/video.
- *.remind [HH:mm] [pesan]* : Pengingat.
- *Kirim Link TikTok* : Auto Download Video.

*Others:*
- *.reset* : Hapus memori chat.
- *.ping* : Cek status.`;
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                    break;

                case 's':
                case 'sticker':
                    const isQuotedImage = quoted?.imageMessage;
                    const isQuotedVideo = quoted?.videoMessage;
                    
                    if (isImage || isVideo || isQuotedImage || isQuotedVideo) {
                        await sock.sendMessage(from, { text: '_Sedang memproses stiker..._' });
                        try {
                            const mediaMsg = isQuotedImage ? quoted.imageMessage : (isQuotedVideo ? quoted.videoMessage : (isImage ? msg.message.imageMessage : msg.message.videoMessage));
                            const mediaType = (isImage || isQuotedImage) ? 'image' : 'video';
                            const buffer = await downloadMedia(mediaMsg, mediaType);
                            
                            const inputPath = path.join(__dirname, `tmp/input_${Date.now()}.${mediaType === 'image' ? 'jpg' : 'mp4'}`);
                            const outputPath = path.join(__dirname, `tmp/output_${Date.now()}.webp`);
                            
                            if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'));
                            fs.writeFileSync(inputPath, buffer);
                            
                            const ffmpegCmd = mediaType === 'image' 
                                ? `ffmpeg -i ${inputPath} -vcodec libwebp -filter:v "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0" -y ${outputPath}`
                                : `ffmpeg -i ${inputPath} -vcodec libwebp -filter:v "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0" -loop 0 -preset default -an -vsync 0 -s 512:512 -t 5 -y ${outputPath}`;

                            exec(ffmpegCmd, async (err) => {
                                if (err) {
                                    console.error('FFmpeg Error:', err);
                                    await sock.sendMessage(from, { text: '❌ Gagal mengonversi stiker.' });
                                } else {
                                    await sock.sendMessage(from, { sticker: fs.readFileSync(outputPath) }, { quoted: msg });
                                }
                                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            });
                        } catch (e) {
                            console.error('Sticker Error:', e);
                            await sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat membuat stiker.' });
                        }
                    } else {
                        await sock.sendMessage(from, { text: 'Silakan kirim gambar/video dengan caption .s atau balas gambar/video dengan .s' });
                    }
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
                
                case 'ping':
                    await sock.sendMessage(from, { text: 'Pong!' });
                    break;
            }
        } else {
            if (isImage) {
                await sock.sendMessage(from, { text: '_Menganalisis gambar..._' });
                const imageBuffer = await downloadMedia(msg.message.imageMessage, 'image');
                const visionRes = await getGroqVisionResponse(from, body || 'Apa ini?', imageBuffer.toString('base64'));
                await sock.sendMessage(from, { text: visionRes }, { quoted: msg });
            } else if (body) {
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
        const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
        const videoUrl = res.data.data?.play || res.data.data?.wmplay;
        
        if (videoUrl) {
            await sock.sendMessage(from, { 
                video: { url: videoUrl }, 
                caption: '✅ Berhasil diunduh!' 
            }, { quoted: msg });
        } else {
            throw new Error('Video tidak ditemukan.');
        }
    } catch (e) {
        await sock.sendMessage(from, { text: `❌ Gagal download: ${e.message}` });
    }
}

// --- Core Helpers ---
async function downloadMedia(message, type) {
    try {
        const stream = await downloadContentFromMessage(message, type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) {
        throw e;
    }
}

async function getGroqResponse(userId, text) {
    try {
        const messages = [{ role: 'system', content: 'Asisten pintar.' }, ...(chatMemory[userId] || []), { role: 'user', content: text }];
        const res = await groq.chat.completions.create({ 
            messages, 
            model: process.env.MODEL_NAME || 'llama-3.1-8b-instant' 
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', text);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) { 
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
            model: 'qwen/qwen3.6-27b'
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', `[Gambar]: ${text}`);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) { 
        return `❌ Gagal analisis gambar: ${e.message}`; 
    }
}

async function getWebSearchResponse(userId, query) {
    try {
        const res = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`);
        const snippet = res.data.AbstractText || "Cari info terbaru...";
        const finalRes = await groq.chat.completions.create({
            messages: [{ role: 'user', content: `Data: ${snippet}\n\nJawab: ${query}` }],
            model: process.env.MODEL_NAME || 'llama-3.1-8b-instant'
        });
        return finalRes.choices[0].message.content;
    } catch (e) { return 'Gagal search.'; }
}

connectToWhatsApp().catch(err => console.log(err));
