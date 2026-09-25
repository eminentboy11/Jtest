/**
 * Pinger Command — Owner only
 * Schedule keep-alive pings for a website. The bot pings every target on a
 * fixed interval (default: 4 minutes) and DMs the owner only when a site
 * goes down or recovers. Targets survive restarts.
 *
 *   .pinger <url>      → validate, ping once now, add to the schedule
 *   .pinger list       → show targets with live status
 *   .pinger stop <url> → remove one target
 *   .pinger stop all   → remove every target
 */

const pinger = require('../../utils/pinger');

const HELP =
    `📡 *Pinger — keep-alive & uptime watch*\n\n` +
    `• \`.pinger <url>\` — add a site (pinged immediately, then every ${Math.round(pinger.intervalMs() / 60000)} min)\n` +
    `• \`.pinger list\` — show scheduled sites and their status\n` +
    `• \`.pinger stop <url>\` — stop pinging a site\n` +
    `• \`.pinger stop all\` — stop all pinging\n\n` +
    `You get a DM when a site goes down 🔴 or recovers 🟢. Max ${pinger.MAX_TARGETS} sites.`;

function statusLine(url, s) {
    if (!s) return `⚪ ${url}\n   not checked yet`;
    const mark = s.status === 'up' ? '🟢' : '🔴';
    const detail = s.status === 'up'
        ? `HTTP ${s.httpStatus} · ${s.latencyMs} ms`
        : `${s.error || (s.httpStatus ? `HTTP ${s.httpStatus}` : 'no response')}`;
    return `${mark} ${url}\n   ${detail} · checked ${new Date(s.checkedAt).toLocaleTimeString()}`;
}

module.exports = {
    name: 'pinger',
    aliases: ['pingweb', 'pingsite'],
    category: 'owner',
    description: 'Schedule keep-alive pings for a website (owner only)',
    usage: '.pinger <url> | .pinger list | .pinger stop <url|all>',
    ownerOnly: true,
    adminOnly: false,
    groupOnly: false,
    botAdminOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const cmd = String(args[0] || '').toLowerCase();

            // ── List ────────────────────────────────────────────────────────
            if (!args.length || cmd === 'list') {
                const targets = pinger.listTargets();
                const statuses = pinger.getStatusMap();
                if (!targets.length) return extra.reply(HELP + `\n\n_No sites scheduled yet._`);
                const lines = targets
                    .map((t) => statusLine(t.url, statuses.get(t.url)))
                    .join('\n');
                return extra.reply(`📡 *Pinger — ${targets.length} site${targets.length === 1 ? '' : 's'} scheduled*\n\n${lines}`);
            }

            // ── Stop ────────────────────────────────────────────────────────
            if (cmd === 'stop') {
                const what = args.slice(1).join(' ').trim();
                if (!what) return extra.reply('Usage: `.pinger stop <url>` or `.pinger stop all`');
                if (extra.react) await extra.react('⏳').catch(() => {});
                if (what.toLowerCase() === 'all') {
                    const r = pinger.clearTargets();
                    if (extra.react) await extra.react(r.cleared ? '✅' : '❌').catch(() => {});
                    return extra.reply(r.cleared ? '✅ All pinger targets removed.' : 'ℹ️ Nothing was scheduled.');
                }
                const v = pinger.validateTargetUrl(what);
                if (!v.ok) return extra.reply(`❌ ${v.error}`);
                const r = pinger.removeTarget(v.url);
                if (extra.react) await extra.react(r.removed ? '✅' : '❌').catch(() => {});
                return extra.reply(r.removed ? `✅ Stopped pinging ${v.url}` : `ℹ️ ${v.url} was not scheduled.`);
            }

            // ── Add ─────────────────────────────────────────────────────────
            const v = pinger.validateTargetUrl(args.join(' '));
            if (!v.ok) {
                if (extra.react) await extra.react('❌').catch(() => {});
                return extra.reply(`❌ ${v.error}\n\n${HELP}`);
            }
            if (extra.react) await extra.react('⏳').catch(() => {});
            const existing = pinger.listTargets();
            if (existing.length >= pinger.MAX_TARGETS && !existing.some((t) => t.url === v.url)) {
                if (extra.react) await extra.react('❌').catch(() => {});
                return extra.reply(`❌ Limit reached (${pinger.MAX_TARGETS} sites). Remove one first: \`.pinger stop <url>\``);
            }

            const result = await pinger.pingOnce(v.url);
            const r = pinger.addTarget(v.url);

            if (!r.added && r.reason === 'already-listed') {
                if (extra.react) await extra.react('ℹ️').catch(() => {});
                return extra.reply(`ℹ️ ${v.url} is already scheduled.\n\n${statusLine(v.url, result)}`);
            }
            if (!r.added) {
                if (extra.react) await extra.react('❌').catch(() => {});
                return extra.reply(`❌ Could not add the site (${r.reason}).`);
            }

            if (extra.react) await extra.react('✅').catch(() => {});
            const now =
                result.status === 'up'
                    ? `🟢 Site is up — HTTP ${result.httpStatus} · ${result.latencyMs} ms`
                    : `🔴 Site is down right now — ${result.error || `HTTP ${result.httpStatus}`}`;
            return extra.reply(
                `✅ *Pinger scheduled*\n\n${v.url}\n\n${now}\n\n⏱️ Pinged every ${Math.round(pinger.intervalMs() / 60000)} minutes ` +
                `· I'll DM you when it goes down 🔴 or recovers 🟢\n🗑️ Remove: \`.pinger stop ${v.url}\``
            );
        } catch (error) {
            console.error('[pinger]', error.message);
            if (extra.react) await extra.react('❌').catch(() => {});
            return extra.reply(`❌ Pinger error: ${error.message}`);
        }
    },
};
