function normalizeReminderTime(value) {
    const match = String(value ?? '').trim().match(/^(\d{1,2})[.:](\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function sanitizeReminders(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item) => {
            const time = normalizeReminderTime(item?.time);
            const from = typeof item?.from === 'string' ? item.from.trim() : '';
            const text = typeof item?.text === 'string' ? item.text.trim() : '';
            if (!time || !from || !text || item.status === 'sent') return null;
            return {
                id: item.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                from,
                time,
                text,
                status: 'pending',
                createdAt: item.createdAt || Date.now()
            };
        })
        .filter(Boolean);
}

const SUPPORTED_HOSTS = [
    'tiktok.com',
    'instagram.com',
    'instagr.am',
    'youtube.com',
    'youtu.be'
];

function extractSupportedUrl(text) {
    const match = String(text || '').match(/https?:\/\/[^\s<>]+/i);
    if (!match) return null;
    try {
        const url = new URL(match[0].replace(/[)\].,!?;:'"]+$/, ''));
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const supported = SUPPORTED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
        return supported ? url.toString() : null;
    } catch (e) {
        return null;
    }
}

function normalizeSearchResults(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => ({
            title: String(item?.title || item?.name || '').trim(),
            url: String(item?.url || item?.link || '').trim(),
            snippet: String(item?.content || item?.snippet || item?.description || '').trim()
        }))
        .filter((item) => item.url);
}

function escapeDrawText(text) {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '’')
        .replace(/"/g, '')
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/;/g, '\\;')
        .replace(/\r/g, '')
        .replace(/\n/g, '\\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .slice(0, 120);
}

module.exports = {
    normalizeReminderTime,
    sanitizeReminders,
    SUPPORTED_HOSTS,
    extractSupportedUrl,
    normalizeSearchResults,
    escapeDrawText
};
