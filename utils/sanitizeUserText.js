/**
 * User-facing text sanitizer — deployment paths must never reach WhatsApp.
 *
 * Error messages from child processes (ffmpeg, exec, …) embed the FULL
 * command line, which means the entire deployment path (the loader's
 * nested extraction tree, temp file names, /app roots, …) lands in user
 * replies. Example of what this stops:
 *
 *   Error: Command failed: "ffmpeg" -y -i "/app/node_modules/ytdl-:-core3/
 *   core0/…/core49/lib_signals/xjx-main/temp/webp_x_in.webp" …
 *
 * becomes:
 *
 *   Error: Command failed: "ffmpeg" -y -i "[path]" -frames:v 1 "[path]"
 *
 * Full details (paths included) still go to the server console for debugging —
 * the loader masks private roots there anyway. This module only protects what
 * the USER sees.
 *
 * Coverage:
 *   - absolute POSIX paths (2+ segments; segment chars may include ':' so the
 *     loader's ytdl-:-core3 tree matches in one go; a lookbehind keeps URLs
 *     like https://host/path intact)
 *   - Windows drive paths (C:\…)
 */

'use strict';

// An absolute POSIX path: '/' + at least two non-space, non-quote segments.
// The first '/' must sit at a real path boundary — preceded by start,
// whitespace, a quote or a symbol — never by a word char/dot (which would
// be a URL host like https://a.io/x/y), ':', '/' or '%' (URL schemes).
const POSIX_PATH_RE = /(?<![\w./:%-])(?:\/[^\s"'`,;)\]}>]+){2,}/g;
// A Windows drive path: a single drive letter at a word boundary, so the
// 's://' tail of 'https://' can never match.
const WIN_PATH_RE = /(?<![\w.])(?:[A-Za-z]:[\\/][^\s"'`,;)\]}>]+)/g;
const REPLACEMENT = '[path]';

/**
 * Replace any filesystem path in `text` with [path]. Non-strings pass
 * through untouched. Never throws.
 */
function sanitizeUserText(text) {
  if (typeof text !== 'string') return text;
  try {
    return text.replace(WIN_PATH_RE, REPLACEMENT).replace(POSIX_PATH_RE, REPLACEMENT);
  } catch (_) {
    // Sanitizing must never break a send.
    return text;
  }
}

/**
 * Wrap a Baileys socket so every outgoing message's text/caption is
 * sanitized. Applied once at socket creation (index.js) — every command,
 * helper and reply helper funnels through sock.sendMessage, so one wrapper
 * covers the whole bot. Idempotent: wrapping twice is a no-op.
 */
function wrapSockSanitized(sock) {
  if (!sock || typeof sock.sendMessage !== 'function' || sock.__juneTextSanitized) return sock;
  const orig = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, opts) => {
    if (content && typeof content === 'object') {
      for (const field of ['text', 'caption']) {
        if (typeof content[field] === 'string') content[field] = sanitizeUserText(content[field]);
      }
    }
    return orig(jid, content, opts);
  };
  sock.__juneTextSanitized = true;
  return sock;
}

module.exports = { sanitizeUserText, wrapSockSanitized };
