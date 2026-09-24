// SANITIZER TEST — deployment paths must never reach user-facing text:
//   1. the exact production leak (full loader extraction tree + temp names)
//   2. URLs are preserved (https://host/path stays intact)
//   3. Windows drive paths scrubbed
//   4. normal text / single segments / relative paths untouched
//   5. wrapSockSanitized: every outgoing text+caption scrubbed, URLs kept,
//      non-string content untouched, idempotent double-wrap
//   6. never throws on weird input

const assert = require('assert');
const { sanitizeUserText, wrapSockSanitized } = require('../utils/sanitizeUserText');

// 1. The EXACT leak from production — every path piece must be gone.
const LEAK = 'Command failed: "ffmpeg" -y -i "/app/node_modules/ytdl-:-core3/core0/core1/core2/core3/core4/core5/core6/core7/core8/core9/core10/core11/core12/core13/core14/core15/core16/core17/core18/core19/core20/core21/core22/core23/core24/core25/core26/core27/core28/core29/core30/core31/core32/core33/core34/core35/core36/core37/core38/core39/core40/core41/core42/core43/core44/core45/core46/core47/core48/core49/lib_signals/xjx-main/temp/webp_1790235064193_cyct8q63xnc_in.webp" -frames:v 1 "/app/node_modules/ytdl-:-core3/core49/lib_signals/xjx-main/temp/webp_1790235064193_cyct8q63xnc_out.png"';
const cleaned = sanitizeUserText(LEAK);
for (const needle of ['/app', 'node_modules', 'ytdl-:-core3', 'core0', 'core49', 'lib_signals', 'xjx-main', 'temp/', 'webp_1790', 'in.webp', 'out.png']) {
    assert(!cleaned.includes(needle), `leak survives: ${needle} → ${cleaned}`);
}
assert(cleaned.includes('[path]'), 'replacement token expected');
assert(cleaned.includes('Command failed'), 'non-path context must survive');
assert(cleaned.includes('-frames:v 1'), 'command flags may remain (not sensitive)');

// 2. URLs preserved
assert.strictEqual(
    sanitizeUserText('Download from https://youtube.com/watch?v=dQw4w9WgXcQ or http://a.io/x/y now'),
    'Download from https://youtube.com/watch?v=dQw4w9WgXcQ or http://a.io/x/y now'
);

// 3. Windows paths
const win = sanitizeUserText('found at C:\\Users\\bob\\videos\\clip.mp4 ok');
assert(!win.includes('C:\\') && !win.includes('bob'), win);
assert(win.includes('[path]'), win);

// 4. normal text untouched
assert.strictEqual(sanitizeUserText('❌ Failed to convert sticker. Please try again.'), '❌ Failed to convert sticker. Please try again.');
assert.strictEqual(sanitizeUserText('usage: .sticker (reply to an image)'), 'usage: .sticker (reply to an image)');
assert.strictEqual(sanitizeUserText('in /tmp dir'), 'in /tmp dir');                 // single segment
assert.strictEqual(sanitizeUserText('temp/webp_x.webp is relative'), 'temp/webp_x.webp is relative'); // no leading /
assert.strictEqual(sanitizeUserText(42), 42);                                     // non-string passthrough
assert.strictEqual(sanitizeUserText(null), null);

// 6. never throws
assert.strictEqual(sanitizeUserText(undefined), undefined);

// 5. socket wrapper
(async () => {
    const sent = [];
    const fakeSock = {
        sendMessage: (jid, content, opts) => { sent.push({ jid, content, opts }); return Promise.resolve({ key: {} }); },
    };
    wrapSockSanitized(fakeSock);

    await fakeSock.sendMessage('u@s.whatsapp.net', { text: 'Error: /app/deep/nested/path/x failed' });
    assert.strictEqual(sent.at(-1).content.text, 'Error: [path] failed');

    await fakeSock.sendMessage('u@s.whatsapp.net', { image: {}, caption: 'see /usr/local/bin/ffmpeg here' });
    assert.strictEqual(sent.at(-1).content.caption, 'see [path] here');
    assert.deepStrictEqual(sent.at(-1).content.image, {}, 'non-text content untouched');

    await fakeSock.sendMessage('u@s.whatsapp.net', { text: 'link: https://a.io/x/y is fine' });
    assert.strictEqual(sent.at(-1).content.text, 'link: https://a.io/x/y is fine');

    // idempotent — wrapping again must not double-wrap or break
    wrapSockSanitized(fakeSock);
    await fakeSock.sendMessage('u@s.whatsapp.net', { text: 'double /a/b wrap' });
    assert.strictEqual(sent.at(-1).content.text, 'double [path] wrap');

    // null content safety
    await assert.doesNotReject(() => fakeSock.sendMessage('u@s.whatsapp.net', null, {}));

    console.log('SANITIZE TEST: all assertions passed');
})().catch((e) => {
    console.error('SANITIZE TEST FAILED:', e);
    process.exit(1);
});
