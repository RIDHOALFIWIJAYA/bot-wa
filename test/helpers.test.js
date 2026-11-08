const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeReminderTime,
    sanitizeReminders,
    extractSupportedUrl,
    normalizeSearchResults,
    escapeDrawText
} = require('../lib/helpers');

test('normalizeReminderTime menerima format valid dan menormalkannya', () => {
    assert.equal(normalizeReminderTime('07:00'), '07:00');
    assert.equal(normalizeReminderTime('7.05'), '07:05');
    assert.equal(normalizeReminderTime('22.06'), '22:06');
    assert.equal(normalizeReminderTime('00:00'), '00:00');
    assert.equal(normalizeReminderTime('23:59'), '23:59');
    assert.equal(normalizeReminderTime(' 09:05 '), '09:05');
});

test('normalizeReminderTime menolak input tidak valid', () => {
    assert.equal(normalizeReminderTime('24:00'), null);
    assert.equal(normalizeReminderTime('12:60'), null);
    assert.equal(normalizeReminderTime('9:5'), null);
    assert.equal(normalizeReminderTime('abc'), null);
    assert.equal(normalizeReminderTime(''), null);
    assert.equal(normalizeReminderTime(null), null);
});

test('sanitizeReminders mengembalikan array kosong untuk input bukan array', () => {
    assert.deepEqual(sanitizeReminders(null), []);
    assert.deepEqual(sanitizeReminders({}), []);
});

test('sanitizeReminders membuang entri tidak valid dan status sent', () => {
    const result = sanitizeReminders([
        { from: '123', time: '25:00', text: 'invalid time' },
        { from: '', time: '07:00', text: 'missing from' },
        { from: '123', time: '07:00', text: '' },
        { from: '123', time: '07:00', text: 'already sent', status: 'sent' }
    ]);

    assert.deepEqual(result, []);
});

test('sanitizeReminders menormalkan dan mempertahankan entri valid', () => {
    const result = sanitizeReminders([
        { id: 'abc', from: ' 123 ', time: '7.05', text: ' minum air ', createdAt: 42 },
        { from: '456', time: '06:40', text: 'sholat' }
    ]);

    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
        id: 'abc',
        from: '123',
        time: '07:05',
        text: 'minum air',
        status: 'pending',
        createdAt: 42
    });
    assert.equal(result[1].from, '456');
    assert.equal(result[1].time, '06:40');
    assert.equal(result[1].status, 'pending');
    assert.equal(typeof result[1].id, 'string');
    assert.ok(result[1].id.length > 0);
    assert.equal(typeof result[1].createdAt, 'number');
});

test('extractSupportedUrl mengenali host yang didukung', () => {
    assert.equal(
        extractSupportedUrl('cek https://youtu.be/abc123. nih'),
        'https://youtu.be/abc123'
    );
    assert.equal(
        extractSupportedUrl('https://www.tiktok.com/@a/video/123, makasih'),
        'https://www.tiktok.com/@a/video/123'
    );
    assert.equal(
        extractSupportedUrl('<https://instagram.com/reel/abc>'),
        'https://instagram.com/reel/abc'
    );
    assert.equal(
        extractSupportedUrl('https://m.youtube.com/watch?v=abc&t=10'),
        'https://m.youtube.com/watch?v=abc&t=10'
    );
    assert.equal(
        extractSupportedUrl('HTTPS://YOUTU.BE/abc'),
        'https://youtu.be/abc'
    );
});

test('extractSupportedUrl menolak URL asing dan input tanpa URL', () => {
    assert.equal(extractSupportedUrl('https://evil.com/youtube.com/fake'), null);
    assert.equal(extractSupportedUrl('bukan url'), null);
    assert.equal(extractSupportedUrl(''), null);
    assert.equal(extractSupportedUrl(null), null);
});

test('normalizeSearchResults memetakan bentuk Tavily dan DuckDuckGo', () => {
    const result = normalizeSearchResults([
        { title: ' A ', url: ' https://a.test ', content: ' isi a ' },
        { name: 'B', link: 'https://b.test', snippet: 'isi b' },
        { description: 'tanpa url' },
        null
    ]);

    assert.deepEqual(result, [
        { title: 'A', url: 'https://a.test', snippet: 'isi a' },
        { title: 'B', url: 'https://b.test', snippet: 'isi b' }
    ]);
});

test('normalizeSearchResults menangani input bukan array', () => {
    assert.deepEqual(normalizeSearchResults(null), []);
    assert.deepEqual(normalizeSearchResults('bukan array'), []);
});

test('escapeDrawText meng-escape karakter berbahaya untuk FFmpeg', () => {
    assert.equal(
        escapeDrawText('a:b,c;[d]'),
        'a\\:b\\,c\\;\\[d\\]'
    );
    assert.equal(escapeDrawText("it's"), 'it’s');
    assert.equal(escapeDrawText('say "hi"'), 'say hi');
    assert.equal(escapeDrawText('line1\nline2'), 'line1\\nline2');
    assert.equal(escapeDrawText('a\\b'), 'a\\\\b');
});

test('escapeDrawText membuang control char dan membatasi panjang', () => {
    assert.equal(escapeDrawText('a\x01b'), 'ab');
    assert.equal(escapeDrawText('x'.repeat(200)).length, 120);
});
