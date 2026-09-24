/**
 * Phone-number → timezone auto-detection for June Ultra.
 *
 * Given a phone number, detect its country (awesome-phonenumber) and return
 * that country's primary IANA timezone (utils/tzCountryMap.json, generated
 * from the official tz database — 247 countries).
 *
 * resolveTimeZone() is PURE (all inputs passed in) so it is unit-testable:
 *   storedTz    — raw stored 'timezone' setting ('auto' = detection wanted)
 *   envTz       — process.env.TIMEZONE
 *   ownerNumber — bot owner number(s) (wins — spec tier 1)
 *   botNumber   — the paired number (spec tier 2; array of candidates ok)
 *   defaultTz   — shipped default from database.js defaults
 *
 * Tier order: stored (explicit) → env (explicit) → AUTO owner → AUTO paired
 * → default → UTC. Owner/paired detection re-runs on every call, so
 * .setownernumber to a new country re-detects instantly — no restart.
 */
'use strict';
const COUNTRY_ZONES = require('./tzCountryMap.json');

const _isTz = (v) => {
  if (!v || typeof v !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(new Date()); return true; }
  catch (_) { return false; }
};

let _parsePhoneNumber = null;
function numberToCountry(digits) {
  try {
    const cleaned = String(digits || '').replace(/\D/g, '');
    if (cleaned.length < 7) return null;
    if (!_parsePhoneNumber) {
      const apn = require('awesome-phonenumber');
      _parsePhoneNumber = apn.parsePhoneNumber || apn;
    }
    const parsed = _parsePhoneNumber('+' + cleaned);
    const cc = parsed && (parsed.regionCode || parsed.country);
    return cc && /^[A-Z]{2}$/.test(cc) ? cc : null;
  } catch (_) { return null; }
}

function countryToZone(cc) {
  if (!cc) return null;
  const zones = COUNTRY_ZONES[cc];
  return Array.isArray(zones) && zones.length ? zones[0] : null;
}

/** digits → { zone, country } | null */
function zoneForNumber(digits) {
  const cc = numberToCountry(digits);
  if (!cc) return null;
  const zone = countryToZone(cc);
  return zone ? { zone, country: cc } : null;
}

const asList = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);

/**
 * @returns {{ tz: string, source: string, country?: string }}
 * source: 'setting' | 'env' | 'auto:owner' | 'auto:paired' | 'default' | 'utc'
 */
function resolveTimeZone(opts = {}) {
  const { storedTz, envTz, ownerNumber, botNumber, defaultTz } = opts;

  if (_isTz(storedTz) && String(storedTz).toLowerCase() !== 'auto') {
    return { tz: storedTz, source: 'setting' };
  }
  if (_isTz(envTz)) return { tz: envTz, source: 'env' };

  for (const cand of asList(ownerNumber)) {
    const hit = zoneForNumber(cand);
    if (hit) return { tz: hit.zone, source: 'auto:owner', country: hit.country };
  }
  for (const cand of asList(botNumber)) {
    const hit = zoneForNumber(cand);
    if (hit) return { tz: hit.zone, source: 'auto:paired', country: hit.country };
  }

  if (_isTz(defaultTz)) return { tz: defaultTz, source: 'default' };
  return { tz: 'UTC', source: 'utc' };
}

module.exports = { resolveTimeZone, zoneForNumber, numberToCountry, countryToZone, _isTz };
