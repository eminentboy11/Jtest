'use strict';

let trustedHops = 0;

function parseTrustedHops() {
    const explicit = process.env.PLATFORM_TRUST_PROXY_HOPS;
    if (explicit !== undefined && explicit !== '') {
        const parsed = Math.floor(Number(explicit));
        return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 5) : 0;
    }
    // These providers put the app behind one controlled edge proxy. Outside
    // known hosts, ignore X-Forwarded-For unless explicitly configured.
    if (process.env.RENDER || process.env.DYNO || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return 1;
    return 0;
}

function configureTrustProxy(app) {
    trustedHops = parseTrustedHops();
    app.set('trust proxy', trustedHops > 0 ? trustedHops : false);
    return trustedHops;
}

function rawRemote(req) {
    return String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown');
}

function resolveUpgradeIp(req) {
    const remote = rawRemote(req);
    if (trustedHops <= 0) return remote;
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    if (!forwarded.length) return remote;

    // Build nearest -> furthest. Trust only the configured number of nearest
    // hops; attacker-supplied extra leftmost values cannot move that boundary.
    const chain = [remote, ...forwarded.reverse()];
    return chain[Math.min(trustedHops, chain.length - 1)] || remote;
}

function clientIp(req) {
    // Express computes req.ip using the configured trust-proxy policy.
    return String(req?.ip || resolveUpgradeIp(req) || 'unknown');
}

module.exports = { configureTrustProxy, clientIp, resolveUpgradeIp, parseTrustedHops };
