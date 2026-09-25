/**
 * Resolves the ffmpeg binary path.
 * Prefers explicit system paths over ffmpeg-static, whose pre-compiled
 * binary does not run on NixOS (Replit) or many container environments.
 *
 * Exports a FUNCTION (call it: ffmpegPath()), not a fixed string:
 *   • Once a real (existing) path is found it is cached for the process
 *     lifetime — zero cost per call afterwards.
 *   • While the best candidate is still the bare fallback name 'ffmpeg'
 *     (or a path that has since vanished), every call re-checks the
 *     candidates. That lets the runtime provisioner (utils/ffmpegRuntime.js)
 *     hand over the freshly downloaded data/ffmpeg/ffmpeg binary MID-PROCESS
 *     — the next conversion uses it, no restart needed.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Candidate binary locations, in priority order. The bare command name is
// the last resort (relies on PATH at spawn time) and is handled separately.
const CANDIDATES = [
    // 1. Whatever `which ffmpeg` finds in PATH (works on Replit, most Linux)
    (() => { try { return execSync('which ffmpeg', { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    // 2. Common system locations
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    // 3. Runtime-provisioned binary (utils/ffmpegRuntime.js downloads it from
    //    iqbal-rashed/ytdlp-nodejs on hosts without a system ffmpeg). Lives in
    //    data/ so the loader's mirror-clean never wipes it.
    path.join(__dirname, '..', 'data', 'ffmpeg', 'ffmpeg'),
    // 4. ffmpeg-static package path (only if the binary actually exists)
    (() => { try { const p = require('ffmpeg-static'); return (p && fs.existsSync(p)) ? p : null; } catch { return null; } })(),
];

let cached = null;

function resolveFfmpegPath() {
    if (cached) {
        if (cached === 'ffmpeg') {
            // Bare fallback was the best we had — the provisioner may have
            // finished since; re-check (cheap: a few existsSync + one `which`).
            cached = null;
        } else if (fs.existsSync(cached)) {
            return cached;                       // cached path still valid
        } else {
            cached = null;                        // vanished — re-resolve
        }
    }
    cached = CANDIDATES.find(p => p && p !== 'ffmpeg' && fs.existsSync(p)) || 'ffmpeg';
    return cached;
}

module.exports = resolveFfmpegPath;
module.exports.__resetCache = () => { cached = null; };
