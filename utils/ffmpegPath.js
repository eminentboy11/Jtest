/**
 * Resolves the system ffmpeg binary.
 *
 * This edition deliberately does NOT ship ffmpeg-static: the prebuilt binary
 * is ~70 MB on disk and ~50 MB of RSS, which would roughly halve how many bots
 * fit in a 500 MB VPS. Sticker conversion therefore expects a system ffmpeg
 * (`apt install ffmpeg` on the VPS; see README).
 *
 * Exports a FUNCTION (call it: ffmpegPath()), cached once a real path is
 * found, plus hasFfmpeg() so commands can reply politely when it is missing
 * instead of spawning a doomed child process.
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');

const CANDIDATES = [
  // Whatever PATH offers (covers most Linux hosts and containers)
  (() => {
    try { return execSync('which ffmpeg', { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; }
  })(),
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/bin/ffmpeg',
];

let cached = null;

function resolveFfmpegPath() {
  if (cached && fs.existsSync(cached)) return cached;
  cached = CANDIDATES.find((p) => p && fs.existsSync(p)) || null;
  return cached;
}

/** True when a usable ffmpeg binary exists on this host. */
function hasFfmpeg() {
  return resolveFfmpegPath() !== null;
}

module.exports = resolveFfmpegPath;
module.exports.hasFfmpeg = hasFfmpeg;
