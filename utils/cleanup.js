/**
 * June X — Global Cleanup Hub ("the janitor")
 *
 * Owns every FILE-system cleanup in the bot:
 *   1. Root junk sweep   — leaked media files in the bot root (names starting
 *                          tmp, temp, download, converted, upload, media, sticker; >1h old)
 *   2. Temp-dir sweep    — files in the centralized temp dir (tempManager, >30min old)
 *
 * Exposed as:
 *   - runFileSweep(sock)          one full pass (root + temp/), used by the 10-min
 *                                 schedule, the low-disk emergency path and the ENOSPC
 *                                 handler. Returns counts; DMs the owner once with the
 *                                 total when something was removed.
 *   - startScheduledCleanups(sock) 10-minute interval (registered in
 *                                 global._activeIntervals so shutdown clears it)
 *   - stopScheduledCleanups()     idempotent stop
 *
 * Deliberately OUT of scope (kept in their own modules):
 *   - DB maintenance & backup        → database.js  (private handles, owns its tables)
 *   - session/quarantine lifecycle   → index.js     (auth-coupled; never swept by age)
 *   - RAM TTL caches                 → handler.js   (self-expiring; not on disk)
 *
 * This module never registers process-level exit handlers — index.js owns lifecycle.
 */

const fs = require('fs')
const path = require('path')
const { getTempDir } = require('./tempManager')

// Scheduled sweep cadence: every 10 minutes.
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
// temp/ files are stale after 30 minutes — commands delete their own files on the
// success path, so anything older is a crash leak.
const TEMP_FILE_AGE_MS = 30 * 60 * 1000
// Root-level junk is only touched after 1 hour (an in-flight media send may still
// reference it).
const ROOT_JUNK_AGE_MS = 60 * 60 * 1000

// The auth session directory must never be swept, wherever it appears.
const SESSION_DIR_NAME = 'session'

const ROOT_JUNK_NAME_PATTERN = /^(?:tmp|temp|download|converted|upload|media|sticker)[._-]/i
const ROOT_JUNK_EXTENSIONS = new Set(['.gif', '.png', '.mp3', '.mp4', '.opus', '.jpg', '.jpeg', '.webp', '.webm', '.zip'])

const BOT_ROOT = path.join(__dirname, '..')

let scheduledInterval = null
let sweepRunning = false

/**
 * Sweep one directory for stale FILES (directories are never touched).
 * @returns {{deleted: number, bytesFreed: number}}
 */
function sweepDir({ dir, ageMs, namePattern = null, extensions = null, now = Date.now() }) {
    if (!dir || !fs.existsSync(dir)) return { deleted: 0, bytesFreed: 0 }
    const cutoff = now - ageMs
    let deleted = 0
    let bytesFreed = 0

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (!entry.isFile()) continue
        if (entry.name === SESSION_DIR_NAME) continue // belt & braces — never the session dir
        if (namePattern && !namePattern.test(entry.name)) continue
        if (extensions && !extensions.has(path.extname(entry.name).toLowerCase())) continue

        const filePath = path.join(dir, entry.name)
        try {
            const stats = fs.statSync(filePath)
            if (stats.mtimeMs >= cutoff) continue
            fs.unlinkSync(filePath)
            deleted += 1
            bytesFreed += stats.size
        } catch (error) {
            // Skip files that can't be accessed (may be in use by ffmpeg/Baileys).
            if (!/ENOENT|EBUSY|EPERM/.test(error.code || error.message)) {
                console.warn(`[Cleanup] could not process ${filePath}: ${error.message}`)
            }
        }
    }
    return { deleted, bytesFreed }
}

/**
 * Root junk sweep — leaked media files sitting in the bot root.
 */
function sweepRootJunk({ rootDir = BOT_ROOT, now = Date.now() } = {}) {
    return sweepDir({
        dir: rootDir,
        ageMs: ROOT_JUNK_AGE_MS,
        namePattern: ROOT_JUNK_NAME_PATTERN,
        extensions: ROOT_JUNK_EXTENSIONS,
        now,
    })
}

/**
 * temp/ sweep — stale files in the centralized temp directory.
 */
function sweepTempDir({ tempDir = getTempDir(), now = Date.now() } = {}) {
    return sweepDir({
        dir: tempDir,
        ageMs: TEMP_FILE_AGE_MS,
        now,
    })
}

/**
 * One full cleanup pass: root junk + temp/.
 * @param {object|null} sock  live socket for the owner DM (null = silent, e.g. ENOSPC)
 * @returns {Promise<{rootDeleted: number, tempDeleted: number, bytesFreed: number}>}
 */
async function runFileSweep(sock, { rootDir, tempDir } = {}) {
    if (sweepRunning) {
        return { rootDeleted: 0, tempDeleted: 0, bytesFreed: 0, skipped: true }
    }
    sweepRunning = true
    try {
        const root = sweepRootJunk({ rootDir })
        const temp = sweepTempDir({ tempDir })
        const deleted = root.deleted + temp.deleted
        const bytesFreed = root.bytesFreed + temp.bytesFreed

        if (deleted > 0) {
            const sizeMB = (bytesFreed / (1024 * 1024)).toFixed(2)
            console.log(`🧹 Cleanup: removed ${deleted} expired temporary file(s), freed ${sizeMB} MB (root: ${root.deleted}, temp/: ${temp.deleted})`)
            if (sock && sock.user && sock.user.id) {
                sock.sendMessage(sock.user.id.split(':')[0] + '@s.whatsapp.net', {
                    text: `🧹 Removed ${deleted} expired temporary file(s).`
                }).catch(() => {})
            }
        }
        return { rootDeleted: root.deleted, tempDeleted: temp.deleted, bytesFreed }
    } finally {
        sweepRunning = false
    }
}

/**
 * Start the scheduled 10-minute sweep (plus one immediate pass to clear
 * leftovers from the previous run). Safe to call more than once.
 * @param {object} [options]
 * @param {boolean} [options.initialSweep=true] run one sweep immediately on start
 */
function startScheduledCleanups(sock, { initialSweep = true } = {}) {
    if (scheduledInterval) return scheduledInterval

    if (initialSweep) {
        Promise.resolve(runFileSweep(sock)).catch((error) => {
            console.error('[Cleanup] startup sweep failed:', error.message)
        })
    }

    scheduledInterval = setInterval(() => {
        Promise.resolve(runFileSweep(sock)).catch(() => {})
    }, CLEANUP_INTERVAL_MS)

    if (Array.isArray(global._activeIntervals)) global._activeIntervals.push(scheduledInterval)
    return scheduledInterval
}

/**
 * Stop the scheduled sweep. Idempotent.
 */
function stopScheduledCleanups() {
    if (!scheduledInterval) return
    clearInterval(scheduledInterval)
    if (Array.isArray(global._activeIntervals)) {
        const idx = global._activeIntervals.indexOf(scheduledInterval)
        if (idx !== -1) global._activeIntervals.splice(idx, 1)
    }
    scheduledInterval = null
}

module.exports = {
    runFileSweep,
    startScheduledCleanups,
    stopScheduledCleanups,
    sweepRootJunk,
    sweepTempDir,
    CLEANUP_INTERVAL_MS,
    TEMP_FILE_AGE_MS,
    ROOT_JUNK_AGE_MS
}
