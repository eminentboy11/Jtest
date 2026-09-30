'use strict';

/**
 * Content gates — link classification for the `nsfw` and `detect` group
 * settings, plus the commands that toggle them.
 *
 * Both gates are enforced in handler.js's content-protection chain next to
 * antilink. The lists live here rather than inline in handler.js so the
 * commands can describe exactly what they block without restating the rules,
 * and so the matching logic is unit-testable on its own.
 *
 * Neither gate ever throws on odd input — an unparseable link simply does not
 * match, which fails open the same way antilink does.
 */

// Adult-content domains. Matched on the registrable host, so `www.`/`m.`/`amp.`
// subdomains still trip the gate.
const NSFW_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
  'youporn.com', 'spankbang.com', 'beeg.com', 'brazzers.com', 'onlyfans.com',
  'chaturbate.com', 'stripchat.com', 'cam4.com', 'livejasmin.com', 'bongacams.com',
  'rule34.xxx', 'e-hentai.org', 'nhentai.net', 'hanime.tv', 'hentaihaven.xxx',
  'motherless.com', 'efukt.com', 'txxx.com', 'hqporner.com', 'porntrex.com',
  'sex.com', 'fapello.com', 'erome.com', 'thothub.tv', 'theporndude.com',
];

// Hosts that hide the real destination — a link through one of these says
// nothing about where it actually lands.
const SHORTENER_DOMAINS = [
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'buff.ly', 'ow.ly',
  'cutt.ly', 'rb.gy', 'shorturl.at', 'rebrand.ly', 'adf.ly', 'bc.vc',
  'shorte.st', 'ouo.io', 'soo.gd', 'clck.ru', 'vk.cc', 't.ly', 's.id',
];

// TLDs with a very high scam/phishing ratio relative to legitimate use.
const RISKY_TLDS = ['zip', 'mov', 'top', 'xin', 'cc', 'tk', 'ml', 'ga', 'cf', 'gq', 'work', 'click'];

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Every http(s)/www link in a blob of text. */
function extractLinks(text) {
  if (!text) return [];
  return String(text).match(URL_RE) || [];
}

/** Lowercased hostname, or null when the link cannot be parsed. */
function hostOf(link) {
  try {
    const withProto = /^https?:\/\//i.test(link) ? link : `http://${link}`;
    return new URL(withProto).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch (_) {
    return null;
  }
}

/** True when `host` is `domain` itself or any subdomain of it. */
function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True for a dotted-quad IPv4 literal (no DNS name at all). */
function isIpv4Literal(host) {
  const m = IPV4_RE.exec(host || '');
  if (!m) return false;
  return m.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Classify one link. Returns a reason string, or null if it looks harmless.
 * Exported so a command can explain *why* something was flagged.
 */
function classifyLink(link) {
  const host = hostOf(link);
  if (!host) return null;

  // Adult content.
  if (NSFW_DOMAINS.some((d) => hostMatches(host, d))) return 'nsfw';

  // A bare IP address is never a normal thing to send in a group.
  if (isIpv4Literal(host)) return 'ip-literal';

  // punycode/IDN — the classic homograph trick (e.g. xn--80ak6aa92e.com).
  if (host.split('.').some((label) => label.startsWith('xn--'))) return 'punycode';

  // Destination hidden behind a redirector.
  if (SHORTENER_DOMAINS.some((d) => hostMatches(host, d))) return 'shortener';

  // High-risk TLD.
  const tld = host.split('.').pop();
  if (RISKY_TLDS.includes(tld)) return `tld:${tld}`;

  return null;
}

/** First adult-content link in `text`, or null. */
function findNsfwLink(text) {
  for (const link of extractLinks(text)) {
    const reason = classifyLink(link);
    if (reason === 'nsfw') return { link, host: hostOf(link), reason };
  }
  return null;
}

/** First deceptive/scam-looking link in `text`, or null. */
function findSuspiciousLink(text) {
  for (const link of extractLinks(text)) {
    const reason = classifyLink(link);
    // `nsfw` is the other gate's business — this one only reports deception.
    if (reason && reason !== 'nsfw') return { link, host: hostOf(link), reason };
  }
  return null;
}

/** Short human explanation for a reason code, for command output. */
function describeReason(reason) {
  if (!reason) return 'suspicious';
  if (reason === 'nsfw') return 'adult content';
  if (reason === 'ip-literal') return 'raw IP address instead of a domain';
  if (reason === 'punycode') return 'look-alike (punycode) domain';
  if (reason === 'shortener') return 'link shortener hiding the destination';
  if (reason.startsWith('tld:')) return `high-risk ".${reason.slice(4)}" domain`;
  return 'suspicious';
}

module.exports = {
  NSFW_DOMAINS,
  SHORTENER_DOMAINS,
  RISKY_TLDS,
  extractLinks,
  hostOf,
  classifyLink,
  findNsfwLink,
  findSuspiciousLink,
  describeReason,
};
