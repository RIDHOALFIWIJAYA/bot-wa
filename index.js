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
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
require('dotenv').config({ quiet: true });
const {
    normalizeReminderTime,
    sanitizeReminders,
    extractSupportedUrl,
    normalizeSearchResults,
    escapeDrawText
} = require('./lib/helpers');

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
let reminders = sanitizeReminders(loadJSON(REMINDERS_FILE, []));

// State menunggu teks untuk stiker (per pengirim)
const pendingSticker = new Map();

// Rate limit per pengirim
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateLimitMap = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const entry = rateLimitMap.get(userId) || { timestamps: [], notifiedAt: 0 };
    entry.timestamps = entry.timestamps.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (entry.timestamps.length >= RATE_LIMIT_MAX) {
        rateLimitMap.set(userId, entry);
        if (now - entry.notifiedAt > RATE_LIMIT_WINDOW_MS) {
            entry.notifiedAt = now;
            return 'limited';
        }
        return 'silent';
    }

    entry.timestamps.push(now);
    rateLimitMap.set(userId, entry);
    return 'ok';
}

setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of rateLimitMap) {
        if (!entry.timestamps.some((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS)) {
            rateLimitMap.delete(userId);
        }
    }
}, 10 * 60 * 1000).unref();

// Cache hasil pencarian
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map();

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
let reminderTask = null;

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
            if (reminderTask) {
                reminderTask.stop();
                reminderTask = null;
            }
            const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
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
        if (!msg?.message || msg.key?.fromMe) return;

        const from = msg.key?.remoteJid;
        if (!from) return;

        try {
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

        const prefix = '.';
        const isCommand = body.startsWith(prefix);
        const command = isCommand ? body.slice(prefix.length).trim().split(/ +/).shift().toLowerCase() : null;
        const args = body.trim().split(/ +/).slice(1);

        const senderKey = msg.key.participant || from;
        const isGroup = from.endsWith('@g.us');
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo
            || msg.message?.imageMessage?.contextInfo
            || msg.message?.videoMessage?.contextInfo
            || {};
        const botNumber = (sock.user?.id || '').split('@')[0].split(':')[0];
        const isMentioned = Boolean(botNumber) && (contextInfo.mentionedJid || []).some(
            (jid) => jid.split('@')[0].split(':')[0] === botNumber
        );

        if (isGroup && !isCommand && !isMentioned && !pendingSticker.has(senderKey)) return;

        const rate = checkRateLimit(senderKey);
        if (rate !== 'ok') {
            if (rate === 'limited') {
                await sock.sendMessage(from, { text: '⏳ Sabar ya, terlalu banyak pesan. Coba lagi sebentar.' });
            }
            return;
        }

        // Auto Downloader Detection
        const mediaUrl = extractSupportedUrl(body);
        if (mediaUrl) {
            return handleDownloader(sock, from, mediaUrl, msg);
        }

        const cleanBody = isGroup && isMentioned ? body.replace(/@\d+/g, '').trim() : body;

        // Jika sedang menunggu teks untuk stiker
        if (pendingSticker.has(senderKey)) {
            if (isCommand || isImage || isVideo) {
                clearTimeout(pendingSticker.get(senderKey).timer);
                pendingSticker.delete(senderKey);
            } else if (body) {
                const pending = pendingSticker.get(senderKey);
                clearTimeout(pending.timer);
                pendingSticker.delete(senderKey);
                if (pending.mode === 'choice') {
                    const choice = body.trim();
                    if (choice === '1') {
                        return createPlainSticker(sock, from, pending.mediaMsg, pending.msg);
                    } else if (choice === '2') {
                        await sock.sendMessage(from, { text: '_✍️ Ketik teks yang mau ditambahkan ke stiker (60 detik)._' });
                        if (pendingSticker.has(senderKey)) clearTimeout(pendingSticker.get(senderKey).timer);
                        const timer = setTimeout(() => {
                            if (pendingSticker.has(senderKey)) {
                                pendingSticker.delete(senderKey);
                                sock.sendMessage(from, { text: '⏰ Waktu habis. Stiker batal.' }).catch(() => {});
                            }
                        }, 60000);
                        pendingSticker.set(senderKey, { mediaMsg: pending.mediaMsg, msg: pending.msg, mode: 'text', timer });
                    } else {
                        await sock.sendMessage(from, { text: 'Pilihan tidak valid. Balas *1* untuk Stiker Polos atau *2* untuk Stiker dengan Teks.' });
                    }
                } else {
                    return createStickerWithText(sock, from, pending.mediaMsg, body, pending.msg);
                }
            }
        }

        if (isCommand) {
            switch (command) {
                case 'menu':
                    const menuText = `*WA cuyBOT*

*Tahap A (AI & Search):*
- *Kirim Foto + Caption* : Analisis Gambar.
- *Chat Biasa* : AI (Memory ON).
- *.search [kueri]* : Cari info terbaru + sumber.

*Tahap B (Utility):*
- *.s / .sticker* : Stiker dari foto (polos / +teks) / video.
- *.remind [HH:mm] [pesan]* : Pengingat.
- *.dl [url]* / *Kirim Link* : Download TikTok, Instagram, YouTube.

*Others:*
- *.reset* : Hapus memori chat.
- *.ping* : Cek status.`;
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                    break;

                case 's':
                case 'sticker':
                    const isQuotedImage = quoted?.imageMessage;
                    const isQuotedVideo = quoted?.videoMessage;

                    if (isImage || isQuotedImage) {
                        const mediaMsg = isQuotedImage ? quoted.imageMessage : msg.message.imageMessage;
                        await sock.sendMessage(from, { text: 'Pilih opsi stiker:\n1️⃣ *Stiker Polos* (tanpa teks)\n2️⃣ *Stiker dengan Teks*\n\nBalas *1* atau *2* (60 detik).' });
                        if (pendingSticker.has(senderKey)) clearTimeout(pendingSticker.get(senderKey).timer);
                        const timer = setTimeout(() => {
                            if (pendingSticker.has(senderKey)) {
                                pendingSticker.delete(senderKey);
                                sock.sendMessage(from, { text: '⏰ Waktu habis. Stiker batal.' }).catch(() => {});
                            }
                        }, 60000);
                        pendingSticker.set(senderKey, { mediaMsg, msg, mode: 'choice', timer });
                    } else if (isVideo || isQuotedVideo) {
                        await sock.sendMessage(from, { text: '_Sedang memproses stiker..._' });
                        try {
                            const mediaMsg = isQuotedVideo ? quoted.videoMessage : msg.message.videoMessage;
                            const buffer = await downloadMedia(mediaMsg, 'video');

                            const inputPath = path.join(__dirname, `tmp/input_${Date.now()}.mp4`);
                            const outputPath = path.join(__dirname, `tmp/output_${Date.now()}.webp`);

                            if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'));
                            fs.writeFileSync(inputPath, buffer);

                            const filter = "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0";

                            try {
                                await runFfmpeg(['-i', inputPath, '-vcodec', 'libwebp', '-filter:v', filter, '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-s', '512:512', '-t', '5', '-y', outputPath]);
                                await sock.sendMessage(from, { sticker: fs.readFileSync(outputPath) }, { quoted: msg });
                            } catch (err) {
                                console.error('FFmpeg Error:', err);
                                await sock.sendMessage(from, { text: '❌ Gagal mengonversi stiker.' });
                            } finally {
                                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            }
                        } catch (e) {
                            console.error('Sticker Error:', e);
                            await sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat membuat stiker.' });
                        }
                    } else {
                        await sock.sendMessage(from, { text: 'Silakan kirim foto dengan caption .s (bisa + teks) atau balas foto/video dengan .s' });
                    }
                    break;

                case 'remind': {
                    const normalizedTime = normalizeReminderTime(args[0]);
                    const reminderText = args.slice(1).join(' ').trim();
                    if (!normalizedTime || !reminderText) {
                        return sock.sendMessage(from, { text: 'Format: .remind HH:mm pesan\nContoh: .remind 07:00 Bangun tidur' }, { quoted: msg });
                    }
                    reminders.push({
                        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        from,
                        time: normalizedTime,
                        text: reminderText,
                        status: 'pending',
                        createdAt: Date.now()
                    });
                    saveReminders();
                    await sock.sendMessage(from, { text: `Siap! Pengingat disetel untuk jam ${normalizedTime}.` }, { quoted: msg });
                    break;
                }

                case 'search': {
                    const query = args.join(' ').trim();
                    if (!query) {
                        return sock.sendMessage(from, { text: 'Format: .search [kueri]' }, { quoted: msg });
                    }
                    await sock.sendMessage(from, { text: '_Mencari..._' });
                    const sRes = await getWebSearchResponse(from, query);
                    await sock.sendMessage(from, { text: sRes }, { quoted: msg });
                    break;
                }

                case 'dl': {
                    const urlArg = args.find((arg) => /https?:\/\//i.test(arg)) || args.join(' ').trim();
                    const downloadUrl = extractSupportedUrl(urlArg);
                    if (!downloadUrl) {
                        return sock.sendMessage(from, { text: 'Format: .dl [url]\nSupport: TikTok, Instagram, YouTube.' }, { quoted: msg });
                    }
                    await handleDownloader(sock, from, downloadUrl, msg);
                    break;
                }
                
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
                const image = await prepareVisionImage(imageBuffer, msg.message.imageMessage.mimetype);
                const visionRes = await getGroqVisionResponse(from, cleanBody || 'Apa ini?', image.base64, image.mime);
                await sock.sendMessage(from, { text: visionRes }, { quoted: msg });
            } else if (cleanBody) {
                const needsSearch = /kapan|berita|siapa|skor|harga|terbaru|hari ini/i.test(cleanBody);
                await sock.sendMessage(from, { text: needsSearch ? '_Searching..._' : '_Typing..._' });
                const res = needsSearch ? await getWebSearchResponse(from, cleanBody) : await getGroqResponse(from, cleanBody);
                await sock.sendMessage(from, { text: res }, { quoted: msg });
            }
        }
        } catch (err) {
            console.error('Message Handler Error:', err);
            sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat memproses pesan.' }).catch(() => {});
        }
    });
}

// --- Reminders Logic ---
function startReminderCron(sock) {
    if (reminderTask) reminderTask.stop();

    reminderTask = cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

            const toRemind = reminders.filter(r => r.time === currentTime && r.status === 'pending');
            if (toRemind.length === 0) return;

            const sentIds = new Set(toRemind.map(r => r.id));
            for (const r of toRemind) {
                try {
                    await sock.sendMessage(r.from, { text: `⏰ *PENGINGAT:* ${r.text}` });
                } catch (e) {
                    console.error('Gagal mengirim pengingat:', e.message);
                }
            }

            reminders = reminders.filter(r => !sentIds.has(r.id));
            saveReminders();
        } catch (e) {
            console.error('Reminder Cron Error:', e);
        }
    });
}

// --- Downloader Logic ---
function getYtDlpCommand() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    const localBin = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (fs.existsSync(localBin)) return localBin;
    return 'yt-dlp';
}

function execYtDlp(args) {
    return new Promise((resolve, reject) => {
        const options = { timeout: 120000, maxBuffer: 10 * 1024 * 1024 };
        execFile(getYtDlpCommand(), args, options, (err, stdout, stderr) => {
            if (!err) return resolve({ stdout, stderr });
            if (err.code === 'ENOENT') {
                execFile(
                    process.platform === 'win32' ? 'python' : 'python3',
                    ['-m', 'yt_dlp', ...args],
                    options,
                    (fallbackErr, fallbackStdout, fallbackStderr) => {
                        if (fallbackErr) return reject(new Error(fallbackStderr || fallbackErr.message));
                        resolve({ stdout: fallbackStdout, stderr: fallbackStderr });
                    }
                );
                return;
            }
            reject(new Error(stderr || err.message));
        });
    });
}

async function downloadWithYtDlp(url) {
    const tmpDir = ensureTmpDir();
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prefix = `dl_${stamp}`;
    const outputTemplate = path.join(tmpDir, `${prefix}.%(ext)s`);

    const args = [
        '--no-playlist',
        '--js-runtimes', 'node',
        '--max-filesize', '64M',
        '-f', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--print', 'after_move:filepath',
        '-o', outputTemplate
    ];

    const cookiesPath = process.env.YTDLP_COOKIES;
    if (cookiesPath && fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
    }
    args.push(url);

    try {
        const { stdout } = await execYtDlp(args);
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        const filePath = lines[lines.length - 1];
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error('File hasil unduhan tidak ditemukan.');
        }
        return filePath;
    } catch (e) {
        for (const file of fs.readdirSync(tmpDir)) {
            if (file.startsWith(prefix)) {
                try { fs.unlinkSync(path.join(tmpDir, file)); } catch (cleanupError) {}
            }
        }
        throw e;
    }
}

async function handleDownloader(sock, from, url, msg) {
    await sock.sendMessage(from, { text: '_Mendeteksi link, sedang mengunduh..._' });
    let filePath = null;

    try {
        filePath = await downloadWithYtDlp(url);
        const size = fs.statSync(filePath).size;
        if (size > 64 * 1024 * 1024) throw new Error('Ukuran file melebihi 64MB.');
        await sock.sendMessage(from, {
            video: fs.readFileSync(filePath),
            caption: '✅ Berhasil diunduh!'
        }, { quoted: msg });
    } catch (e) {
        const reason = /ENOENT/.test(e.message)
            ? 'yt-dlp belum terpasang. Jalankan: pip3 install --user yt-dlp'
            : e.message;
        console.error('Downloader Error:', reason);

        if (/tiktok\.com/i.test(url)) {
            try {
                const res = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 15000 });
                const videoUrl = res.data?.data?.play || res.data?.data?.wmplay;
                if (!videoUrl) throw new Error('Video tidak ditemukan.');
                await sock.sendMessage(from, { video: { url: videoUrl }, caption: '✅ Berhasil diunduh!' }, { quoted: msg });
                return;
            } catch (fallbackError) {
                console.error('TikWM fallback error:', fallbackError.message);
            }
        }

        await sock.sendMessage(from, { text: `❌ Gagal download: ${reason}` });
    } finally {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
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

function ensureTmpDir() {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    return tmpDir;
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-nostdin', ...args], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve();
        });
    });
}

async function prepareVisionImage(buffer, mimetype) {
    const tmpDir = ensureTmpDir();
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inputPath = path.join(tmpDir, `vision_input_${stamp}`);
    const outputPath = path.join(tmpDir, `vision_output_${stamp}.jpg`);

    fs.writeFileSync(inputPath, buffer);
    try {
        await runFfmpeg([
            '-i', inputPath,
            '-vf', "scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease",
            '-frames:v', '1',
            '-q:v', '3',
            '-y', outputPath
        ]);
        return {
            base64: fs.readFileSync(outputPath).toString('base64'),
            mime: 'image/jpeg'
        };
    } catch (e) {
        console.error('Vision convert error:', e.message);
        return {
            base64: buffer.toString('base64'),
            mime: mimetype || 'image/jpeg'
        };
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
}

function getFontFile() {
    if (process.platform === 'win32') return "'C\\:/Windows/Fonts/Arial.ttf'";
    if (process.platform === 'darwin') return "'/System/Library/Fonts/Supplemental/Arial.ttf'";
    return "'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'";
}

async function createStickerWithText(sock, from, mediaMsg, text, quotedMsg) {
    await sock.sendMessage(from, { text: '_Sedang membuat stiker..._' });
    try {
        const buffer = await downloadMedia(mediaMsg, 'image');

        const inputPath = path.join(__dirname, `tmp/input_${Date.now()}.jpg`);
        const outputPath = path.join(__dirname, `tmp/output_${Date.now()}.webp`);

        if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'));
        fs.writeFileSync(inputPath, buffer);

        const escapedText = escapeDrawText(text);
        const filter = `scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0,drawbox=x=0:y=ih-90:w=iw:h=90:color=black@0.65:t=fill,drawtext=fontfile=${getFontFile()}:text='${escapedText}':fontsize=30:fontcolor=white:line_spacing=4:x=(w-text_w)/2:y=h-63:expansion=none`;

        try {
            await runFfmpeg(['-i', inputPath, '-vcodec', 'libwebp', '-filter:v', filter, '-y', outputPath]);
            await sock.sendMessage(from, { sticker: fs.readFileSync(outputPath) }, { quoted: quotedMsg });
        } catch (err) {
            console.error('FFmpeg Error:', err);
            await sock.sendMessage(from, { text: '❌ Gagal membuat stiker.' });
        } finally {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    } catch (e) {
        console.error('Sticker Text Error:', e);
        await sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat membuat stiker.' });
    }
}

async function createPlainSticker(sock, from, mediaMsg, quotedMsg) {
    await sock.sendMessage(from, { text: '_Sedang membuat stiker..._' });
    try {
        const buffer = await downloadMedia(mediaMsg, 'image');

        const inputPath = path.join(__dirname, `tmp/input_${Date.now()}.jpg`);
        const outputPath = path.join(__dirname, `tmp/output_${Date.now()}.webp`);

        if (!fs.existsSync(path.join(__dirname, 'tmp'))) fs.mkdirSync(path.join(__dirname, 'tmp'));
        fs.writeFileSync(inputPath, buffer);

        const filter = "scale='if(gt(iw,ih),512,-1)':'if(gt(iw,ih),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0";

        try {
            await runFfmpeg(['-i', inputPath, '-vcodec', 'libwebp', '-filter:v', filter, '-y', outputPath]);
            await sock.sendMessage(from, { sticker: fs.readFileSync(outputPath) }, { quoted: quotedMsg });
        } catch (err) {
            console.error('FFmpeg Error:', err);
            await sock.sendMessage(from, { text: '❌ Gagal membuat stiker.' });
        } finally {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        }
    } catch (e) {
        console.error('Sticker Error:', e);
        await sock.sendMessage(from, { text: '❌ Terjadi kesalahan saat membuat stiker.' });
    }
}

async function getGroqResponse(userId, text) {
    try {
        const messages = [{ role: 'system', content: 'Asisten pintar.' }, ...(chatMemory[userId] || []), { role: 'user', content: text }];
        const res = await groq.chat.completions.create({ 
            messages, 
            model: process.env.MODEL_NAME || 'openai/gpt-oss-120b' 
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', text);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) { 
        return `Error AI: ${e.message}`; 
    }
}

async function getGroqVisionResponse(userId, text, base64Image, imageMime = 'image/jpeg') {
    try {
        const res = await groq.chat.completions.create({
            messages: [{ 
                role: 'user', 
                content: [
                    { type: 'text', text: text }, 
                    { type: 'image_url', image_url: { url: `data:${imageMime};base64,${base64Image}` } }
                ] 
            }],
            model: process.env.VISION_MODEL || 'qwen/qwen3.8-27b'
        });
        const reply = res.choices[0].message.content;
        addMessageToHistory(userId, 'user', `[Gambar]: ${text}`);
        addMessageToHistory(userId, 'assistant', reply);
        return reply;
    } catch (e) {
        const message = e?.message || 'unknown';
        if (/at least 32 pixels/i.test(message)) return '❌ Gambar terlalu kecil (minimal 32x32 piksel).';
        if (/invalid image data/i.test(message)) return '❌ Format gambar tidak didukung. Coba kirim ulang sebagai JPG/PNG.';
        return `❌ Gagal analisis gambar: ${message}`;
    }
}

function getCachedSearch(query) {
    const key = query.trim().toLowerCase();
    const cached = searchCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.createdAt > SEARCH_CACHE_TTL_MS) {
        searchCache.delete(key);
        return null;
    }
    return cached.results;
}

function cacheSearch(query, results) {
    const key = query.trim().toLowerCase();
    if (searchCache.size >= SEARCH_CACHE_MAX) {
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
    }
    searchCache.set(key, { results, createdAt: Date.now() });
}

async function searchTavily(query) {
    const apiKey = process.env.SEARCH_API_KEY;
    if (!apiKey) throw new Error('SEARCH_API_KEY belum diisi.');

    const res = await axios.post('https://api.tavily.com/search', {
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false
    }, { timeout: 10000 });

    return normalizeSearchResults(res.data?.results);
}

async function searchDuckDuckGo(query) {
    const res = await axios.get('https://api.duckduckgo.com/', {
        params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
        timeout: 10000
    });
    const data = res.data || {};
    const results = [];

    if (data.AbstractText) {
        results.push({
            title: data.Heading || query,
            url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
            snippet: data.AbstractText
        });
    }

    for (const topic of data.RelatedTopics || []) {
        const items = Array.isArray(topic.Topics) ? topic.Topics : [topic];
        for (const item of items) {
            if (item.FirstURL && item.Text) {
                results.push({
                    title: item.Text.split(' - ')[0],
                    url: item.FirstURL,
                    snippet: item.Text
                });
            }
        }
    }

    return normalizeSearchResults(results).slice(0, 5);
}

async function performSearch(query) {
    const cached = getCachedSearch(query);
    if (cached) return cached;

    const provider = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
    let results = [];
    let lastError = null;

    if (provider === 'tavily' && process.env.SEARCH_API_KEY) {
        try {
            results = await searchTavily(query);
        } catch (e) {
            lastError = e;
        }
    }

    if (results.length === 0) {
        try {
            results = await searchDuckDuckGo(query);
        } catch (e) {
            lastError = lastError || e;
        }
    }

    if (results.length === 0 && lastError) {
        console.error('Search Error:', lastError.message);
    }

    if (results.length > 0) cacheSearch(query, results);
    return results;
}

async function getWebSearchResponse(userId, query) {
    const results = await performSearch(query);

    if (results.length === 0) {
        const message = `Tidak ditemukan hasil untuk *${query}*. Coba kata kunci lain.`;
        addMessageToHistory(userId, 'user', query);
        addMessageToHistory(userId, 'assistant', message);
        return message;
    }

    const context = results
        .map((result, index) => `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}`)
        .join('\n\n');

    try {
        const res = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'Jawab dalam bahasa Indonesia. Gunakan data hasil pencarian berikut. Sertakan sitasi [1], [2] sesuai sumber. Jika data tidak cukup, katakan apa adanya.' },
                { role: 'user', content: `Pertanyaan: ${query}\n\nHasil pencarian:\n${context}` }
            ],
            model: process.env.MODEL_NAME || 'openai/gpt-oss-120b'
        });
        const reply = res.choices[0].message.content.trim();
        const sources = results.map((result, index) => `[${index + 1}] ${result.url}`).join('\n');
        const message = `${reply}\n\n*Sumber:*\n${sources}`;
        addMessageToHistory(userId, 'user', query);
        addMessageToHistory(userId, 'assistant', message);
        return message;
    } catch (e) {
        console.error('Search summarization error:', e.message);
        const fallback = results
            .map((result, index) => `[${index + 1}] ${result.title}\n${result.url}\n${result.snippet}`)
            .join('\n\n');
        return `Ringkasan AI gagal, ini hasil mentahnya:\n\n${fallback}`;
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

connectToWhatsApp().catch(err => console.log(err));
