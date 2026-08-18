'use strict';

function positiveInt(value, fallback) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

// Dashboard Edition has one fleet capacity. PLATFORM_MAX_BOTS is canonical;
// JUNE_MAX_SESSIONS remains a backward-compatible fallback when it alone is set.
const MAX_BOTS = positiveInt(
    process.env.PLATFORM_MAX_BOTS,
    positiveInt(process.env.JUNE_MAX_SESSIONS, 30)
);

module.exports = { MAX_BOTS, positiveInt };
