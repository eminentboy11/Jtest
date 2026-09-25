/**
 * Runtime ffmpeg provisioner.
 *
 * Some hosts (Heroku's Node image, minimal containers) ship no system ffmpeg
 * and the npm ffmpeg-static binary can be missing or broken (its binary is
 * fetched at install time; on NixOS-style hosts it does not run at all). This
 * module self-provisions a full static ffmpeg build at RUNTIME:
 *
 *   - Source: raw `ffmpeg-latest` release assets from iqbal-rashed/ytdlp-nodejs
 *     (https://github.com/iqbal-rashed/ytdlp-nodejs/releases/tag/ffmpeg-latest)
 *   - Cache:  data/ffmpeg/ffmpeg — inside data/ on purpose, because the
 *     loader's mirror-clean wipes the bot folder on every sync but never
 *     touches SKIP_DIRS (data/session/database). The binary therefore
 *     survives restarts AND re-syncs; on ephemeral hosts (Heroku) it is
 *     re-provisioned after each redeploy.
 *
 * Behavior:
 *   - System ffmpeg present (VPS, Koyeb) → nothing is downloaded, ever.
 *   - No system ffmpeg → the binary is downloaded in the BACKGROUND at boot
 *     (never blocking startup — Heroku kills processes that don't boot in
 *     ~60s). While the download runs, conversions fall back to ffmpeg-static
 *     if it is available; from the next boot on the resolver picks the cache.
 *   - Fail-open: any error logs a warning and leaves the resolver's other
 *     candidates in play. This module can never brick the bot.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const FFMPEG_RELEASE_BASE =
    'https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-latest';

/** Raw (uncompressed) ffmpeg asset per platform/arch. */
const ASSET_BY_PLATFORM = {
    'linux-x64': 'linux-x64-ffmpeg',
    'linux-arm64': 'linux-arm64-ffmpeg',
    'darwin-x64': 'macos-x64-ffmpeg',
    'darwin-arm64': 'macos-arm64-ffmpeg',
    'win32-x64': 'win-x64-ffmpeg.exe',
    'win32-ia32': 'win-ia32-ffmpeg.exe',
};

/** Cache location — data/ is a loader SKIP_DIR, so it survives re-syncs. */
const CACHE_DIR = path.join(__dirname, '..', 'data', 'ffmpeg');
const CACHE_BIN = path.join(CACHE_DIR, 'ffmpeg');
const LOCK_FILE = path.join(CACHE_DIR, '.downloading');

function platformAsset() {
    return ASSET_BY_PLATFORM[`${process.platform}-${process.arch}`] || null;
}

/** True when the cached binary exists, is executable, and actually runs. */
function cacheIsValid() {
    try {
        if (!fs.existsSync(CACHE_BIN)) return false;
        execFileSync(CACHE_BIN, ['-version'], { timeout: 10000, stdio: 'pipe' });
        return true;
    } catch (_) {
        return false;
    }
}

function isDownloadInFlight() {
    try {
        const raw = fs.readFileSync(LOCK_FILE, 'utf8');
        // A lock older than 30 minutes is a zombie (process died mid-download).
        const startedAt = Number(raw.trim());
        return Number.isFinite(startedAt) && Date.now() - startedAt < 30 * 60 * 1000;
    } catch (_) {
        return false;
    }
}

/**
 * Ensure the runtime ffmpeg cache exists. Fire-and-forget safe: never throws,
 * resolves true when a usable runtime binary is in place (pre-existing or
 * freshly downloaded), false otherwise (fall back to other candidates).
 */
async function ensureFfmpegRuntime({ log = console.log, warn = console.log } = {}) {
    try {
        if (cacheIsValid()) {
            log(`[ BOOT ] ffmpeg runtime cache ready: ${CACHE_BIN}`);
            return true;
        }

        const asset = platformAsset();
        if (!asset) {
            warn(`[ BOOT ] ffmpeg runtime: no static build for ${process.platform}-${process.arch}; skipping provision.`);
            return false;
        }
        if (isDownloadInFlight()) {
            log('[ BOOT ] ffmpeg runtime: download already in progress; skipping.');
            return false;
        }

        // Claim the lock (also signals concurrent boots this second).
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        try {
            fs.writeFileSync(LOCK_FILE, String(Date.now()), { flag: 'wx' });
        } catch (_) {
            // Someone else just claimed it between the check and the write.
            return false;
        }

        const url = `${FFMPEG_RELEASE_BASE}/${asset}`;
        log(`[ BOOT ] ffmpeg runtime: no system ffmpeg — downloading ${asset} (~190MB) in background…`);

        const tmpBin = path.join(CACHE_DIR, `ffmpeg.downloading`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
            if (!response.ok || !response.body) {
                throw new Error(`download failed: HTTP ${response.status}`);
            }

            const written = await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(tmpBin);
                const stream = Readable.fromWeb(response.body);
                let bytes = 0;
                const startedAt = Date.now();
                let lastLog = 0;
                stream.on('data', (chunk) => {
                    bytes += chunk.length;
                    const now = Date.now();
                    if (now - lastLog > 10000) {
                        lastLog = now;
                        log(`[ BOOT ] ffmpeg runtime: ${(bytes / 1048576).toFixed(0)}MB downloaded…`);
                    }
                });
                stream.pipe(file);
                file.on('finish', () => file.close(() => resolve(bytes)));
                file.on('error', reject);
                stream.on('error', reject);
            });

            fs.chmodSync(tmpBin, 0o755);
            execFileSync(tmpBin, ['-version'], { timeout: 10000, stdio: 'pipe' }); // verify before promoting
            fs.renameSync(tmpBin, CACHE_BIN);
            log(`[ BOOT ] ffmpeg runtime: ready at ${CACHE_BIN} (${(written / 1048576).toFixed(0)}MB) — used from the next boot; conversions meanwhile use the fallback binary.`);
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmpBin); } catch (_) {}
            warn(`[ BOOT ] ffmpeg runtime: provisioning failed (${e.message}) — falling back to ffmpeg-static/bare ffmpeg.`);
            return false;
        } finally {
            try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
        }
    } catch (e) {
        warn(`[ BOOT ] ffmpeg runtime: unexpected error (${e.message}) — continuing without it.`);
        return false;
    }
}

module.exports = { ensureFfmpegRuntime, cacheIsValid, CACHE_BIN };
