/**
 * .ttt2 — Tic-Tac-Toe 2 (TEST VERSION — candidate to replace fun/tictactoe.js)
 * FULLY CARD-BASED: every message (menu, waiting room, board, turns, results,
 * notices) is a rich canvas card. The text-based game is the original .ttt.
 *
 *  .ttt2              → rich INFO CARD menu
 *  .ttt2 bot          → canvas mini-app game vs unbeatable minimax bot
 *  .ttt2 start        → open a PvP room (another player runs the same to join)
 *  .ttt2 <room name>  → open/join a named room
 *  .ttt2 cancel       → cancel your waiting/active game
 *  during a room game: type 1-9 to move, or surrender to give up
 *  → every board update arrives as a fresh card (cards are one-way renders)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const TicTacToe = require('../../utils/tictactoe');
const { sendRichApp, RICH_FALLBACK } = require('../../utils/richApp');

const GAME_HTML = fs.readFileSync(path.join(__dirname, 'ttt2-app.html'), 'utf8');

// Store room games globally (handler reads this too)
const games = {};

// ───────────────────────── card helpers ─────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// pushName when we have it, else the tail of the phone number
const displayName = (jid, pname) =>
    pname || (jid ? '••' + String(jid.split('@')[0]).slice(-4) : 'Player');

function winLine(b) {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const l of L) if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]]) return l;
    return null;
}

const CARD_CSS = `*{box-sizing:border-box}html,body{margin:0;width:100%;background:transparent;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow-x:hidden}
body{padding:4px}.card{width:268px;margin:0;padding:12px;border-radius:18px;background:linear-gradient(160deg,#041f22 0%,#062e33 55%,#021417 100%);color:#d7fbf6;box-shadow:0 8px 24px #0009;border:1px solid #0e6e63;text-align:center}
h1{margin:0;font-size:15px;letter-spacing:.5px;background:linear-gradient(90deg,#2dd4bf,#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent}
.mode{margin:2px 0 10px;font-size:10px;color:#fbbf24;font-weight:700;letter-spacing:2px}
.big{font-size:38px;margin:4px 0 2px}
.wt{font-size:13.5px;font-weight:800;color:#fbbf24;letter-spacing:1px;margin:0 0 8px}
.dur{font-size:12px;color:#a7e8de;line-height:1.55;margin:0}
.dur b{color:#2dd4bf}
.div{height:1px;margin:10px 6px;background:linear-gradient(90deg,transparent,#0e6e63,transparent)}
.vs{display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin:0 2px 8px}
.vs span{max-width:108px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs .px{color:#2dd4bf}.vs .po{color:#fbbf24}
#bd{width:216px;height:216px;margin:0 auto;display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.cell{cursor:pointer;border-radius:14px;background:#06272b;border:1px solid #0e5f57;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;color:#2a5f57}
.cell.x{color:#2dd4bf}.cell.o{color:#fbbf24}
.cell.win{background:#0e5f57;box-shadow:0 0 16px #2dd4b788}
.cell:active{transform:scale(.95);background:#0a3d38}
@keyframes ttpulse{0%,100%{box-shadow:0 0 0 0 #2dd4b755}50%{box-shadow:0 0 0 6px #2dd4b71f}}
.turn{animation:ttpulse 1.8s infinite}
.turn{margin:10px 0 2px;font-size:13px;font-weight:700;color:#a7e8de;background:#06272b;border:1px solid #0e5f57;border-radius:10px;padding:8px}
.fin{margin:10px 0 2px;font-size:14px;font-weight:800;border-radius:10px;padding:9px}
.fin.win{color:#04262b;background:linear-gradient(135deg,#2dd4bf,#0d9488)}
.fin.draw{color:#2b1a02;background:linear-gradient(135deg,#fbbf24,#d97706)}
.fin.lose{color:#2b1a02;background:linear-gradient(135deg,#f87171,#b91c1c);color:#2b0505}
.hint{margin:8px 0 0;font-size:10px;color:#5da99d}
.hint b{color:#a7e8de}`;

function shell(badge, inner, extra) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CARD_CSS}</style></head><body><div class="card">
<h1>🎮 TIC-TAC-TOE 2</h1>
<p class="mode">${badge}</p>
${inner}
${extra || ''}
</div></body></html>`;
}

// PvP cards can't send taps back to the bot — so every tap answers with a
// coach bubble telling the player exactly what to type instead.
const COACH_JS = `<script>
(function(){
var tip=document.createElement('div');
tip.style.cssText='position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);background:#0e5f57;color:#d7fbf6;font-size:12px;font-weight:700;padding:9px 14px;border-radius:999px;border:1px solid #2dd4bf;opacity:0;transition:all .25s;white-space:nowrap;z-index:9;box-shadow:0 4px 14px #000a;pointer-events:none';
document.body.appendChild(tip);
var tm=null;
function show(m){tip.textContent=m;tip.style.opacity='1';tip.style.transform='translateX(-50%) translateY(0)';if(tm)clearTimeout(tm);tm=setTimeout(function(){tip.style.opacity='0';tip.style.transform='translateX(-50%) translateY(20px)';},2200);}
var cells=document.querySelectorAll('.cell');
for(var i=0;i<cells.length;i++){(function(el){
 el.addEventListener('click',function(){
  if(el.className.indexOf('win')>=0){show('🎉 game over — .ttt2 start for a rematch');return;}
  var t=el.textContent;
  if(t==='\u2716'||t==='\u25C9'){show('taken — pick an empty number');return;}
  show('\u270D type '+t+' in the chat to play it');
  el.style.transform='scale(.94)';setTimeout(function(){el.style.transform='';},160);
 });
})(cells[i]);}
})();
</script>`;

function boardHtml(game) {
    const line = winLine(game.board);
    let cells = '';
    for (let i = 0; i < 9; i++) {
        const v = game.board[i];
        const cls = 'cell' + (v === 'X' ? ' x' : v === 'O' ? ' o' : '') + (line && line.includes(i) ? ' win' : '');
        cells += `<div class="${cls}">${v === 'X' ? '✖' : v === 'O' ? '◉' : (i + 1)}</div>`;
    }
    return `<div id="bd">${cells}</div>`;
}

/** Live / finished room board card */
function stateCard(room, bannerOverride) {
    const g = room.game;
    const nameX = esc(displayName(g.playerX, room.pnameX));
    const nameO = esc(displayName(g.playerO, room.pnameO));
    const players = `<div class="vs"><span class="px">✖ ${nameX}</span><span class="po">◉ ${nameO}</span></div>`;

    let banner;
    if (bannerOverride) banner = `<div class="fin lose">${bannerOverride}</div>`;
    else if (g.winner) banner = `<div class="fin win">🎉 ${esc(g.winner === g.playerX ? nameX : nameO)} wins!</div>`;
    else if (g.turns >= 9) banner = `<div class="fin draw">🤝 It's a draw!</div>`;
    else {
        const isX = g.currentTurn === g.playerX;
        banner = `<div class="turn">🎲 ${esc(displayName(g.currentTurn, isX ? room.pnameX : room.pnameO))}'s turn (${isX ? '✖' : '◉'})</div>`;
    }

    const over = g.winner || g.turns >= 9;
    const hint = over
        ? `<p class="hint">run <b>.ttt2 start</b> for a rematch</p>`
        : `<p class="hint">⌨️ cards can't tap in PvP — <b>type</b> <b>1-9</b> in chat · <b>surrender</b> to give up</p>`;

    return shell(over ? 'GAME OVER' : (room.name ? 'ROOM · ' + esc(room.name) : 'PvP ROOM'),
        players + boardHtml(g) + banner + hint, COACH_JS);
}

function waitingCard() {
    return shell('PvP ROOM', `<div class="big">⏳</div>
<div class="wt">WAITING FOR AN OPPONENT</div>
<p class="dur">someone should type<br><b>.ttt2 start</b> to join you</p>
<div class="div"></div>
<p class="dur">or <b>.ttt2 cancel</b> to drop the room</p>`);
}

function noticeCard(emoji, title, sub) {
    return shell('CARD MODE', `<div class="big">${emoji}</div>
<div class="wt">${title}</div>
<p class="dur">${sub}</p>`);
}

/** Send a card, fall back to plain text only if the canvas channel fails. */
async function sendCard(sock, msg, chatId, html, fallbackText) {
    try {
        await sendRichApp(sock, msg, html, chatId);
    } catch (error) {
        console.error('[ttt2] card unavailable:', error.message);
        await sock.sendMessage(chatId, { text: fallbackText }, { quoted: msg }).catch(() => {});
    }
}

// ───────────────────── rich info card menu ─────────────────────
const INFO_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;background:transparent;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;overflow-x:hidden}
body{padding:4px}.card{width:268px;margin:0;padding:14px 12px;border-radius:18px;background:linear-gradient(160deg,#041f22 0%,#062e33 55%,#021417 100%);color:#d7fbf6;box-shadow:0 8px 24px #0009;border:1px solid #0e6e63;text-align:center}
h1{margin:0;font-size:16px;letter-spacing:.5px;background:linear-gradient(90deg,#2dd4bf,#fbbf24);-webkit-background-clip:text;background-clip:text;color:transparent}
.mode{margin:3px 0 12px;font-size:10px;color:#fbbf24;font-weight:700;letter-spacing:2px}
.row{display:flex;align-items:flex-start;text-align:left;background:#06272b;border:1px solid #0e5f57;border-radius:12px;padding:9px 10px;margin-bottom:8px}
.cmd{flex:0 0 auto;font-family:monospace;font-size:12px;font-weight:700;color:#2dd4bf;background:#04262b;border:1px solid #0e5f57;border-radius:8px;padding:3px 7px;margin-right:8px}
.what{font-size:11.5px;color:#a7e8de;line-height:1.45;padding-top:2px}
.div{height:1px;margin:12px 6px;background:linear-gradient(90deg,transparent,#0e6e63,transparent)}
.dur{font-size:11.5px;color:#a7e8de;line-height:1.5;text-align:center;margin:0}
.dur b{color:#fbbf24}
</style></head><body><div class="card">
<h1>🎮 TIC-TAC-TOE 2</h1>
<p class="mode">CARD MODE</p>
<div class="row"><span class="cmd">.ttt2 start</span><span class="what">open a room (another player runs the same to join)</span></div>
<div class="row"><span class="cmd">.ttt2 bot</span><span class="what">play against the bot</span></div>
<div class="row"><span class="cmd">.ttt2 cancel</span><span class="what">cancel your waiting/active game</span></div>
<div class="div"></div>
<p class="dur">During a game: type <b>1-9</b> to move, or <b>surrender</b> to give up.</p>
</div></body></html>`;

// ───────────────────────── command ─────────────────────────
module.exports = {
    games, // exported for handler access
    name:        'ttt2',
    aliases:     ['xo2', 'tictactoebot'],
    category:    'games',
    description: 'TEST: Tic-Tac-Toe 2 — fully card based (menu, rooms, board)',
    usage:       '.ttt2',

    async execute(sock, msg, args, extra) {
        try {
            const { sender, from, reply } = extra;
            const chatId = from || msg.key.remoteJid;
            const pname = msg.pushName || null;
            const sub = (args[0] || '').toLowerCase();

            // No args → rich info card menu
            if (!sub || ['help', 'menu', 'info', '?'].includes(sub)) {
                await sendCard(sock, msg, chatId, INFO_HTML,
                    '🎮 *Tic-Tac-Toe2 card mode*\n▢ `.ttt2 start` – open a room\n▢ `.ttt2 bot` – play vs bot\n▢ `.ttt2 cancel` – cancel\nDuring a game: type *1-9* or *surrender*.');
                return;
            }

            // Find any existing room this sender is in
            const existingRoom = Object.values(games).find(r =>
                r.id.startsWith('ttt2') &&
                [r.game.playerX, r.game.playerO].includes(sender)
            );

            // ── cancel ────────────────────────────────────────────────
            if (sub === 'cancel') {
                if (!existingRoom) {
                    await sendCard(sock, msg, chatId,
                        noticeCard('🤷', 'NOT IN ANY GAME', 'run <b>.ttt2 start</b> to open a room'),
                        '❌ You are not in any game.');
                    return;
                }
                delete games[existingRoom.id];
                await sendCard(sock, msg, chatId,
                    noticeCard('🛑', 'ROOM CLOSED', 'your tic-tac-toe game was cancelled'),
                    '🛑 Your tic-tac-toe game has been cancelled.');
                return;
            }

            if (existingRoom && existingRoom.state === 'PLAYING') {
                await sendCard(sock, msg, chatId,
                    noticeCard('🎮', 'ALREADY IN A GAME', 'type <b>surrender</b> to quit, or <b>.ttt2 cancel</b>'),
                    '❌ You are still in a game. Type *surrender* to quit, or *.ttt2 cancel*.');
                return;
            }
            if (existingRoom && existingRoom.state === 'WAITING') {
                await sendCard(sock, msg, chatId,
                    noticeCard('⏳', 'ROOM ALREADY WAITING', 'type <b>.ttt2 cancel</b> to drop it'),
                    '⏳ You already have a room waiting. Type *.ttt2 cancel* to drop it.');
                return;
            }

            // ── play vs bot (canvas mini-app) ─────────────────────────
            if (sub === 'bot' || sub === 'cpu' || sub === 'ai') {
                try {
                    await sendRichApp(sock, msg, GAME_HTML, chatId);
                } catch (error) {
                    console.error('[ttt2] mini-app unavailable:', error.message);
                    await sock.sendMessage(chatId, { text: RICH_FALLBACK('TIC-TAC-TOE 2') }, { quoted: msg }).catch(() => {});
                }
                return;
            }

            // ── start / named room (multiplayer, card based) ──────────
            const roomName = sub === 'start' ? (args.slice(1).join(' ').trim() || '') : args.join(' ').trim();

            // Look for existing waiting room
            const waiting = Object.values(games).find(r =>
                r.state === 'WAITING' &&
                r.id.startsWith('ttt2') &&
                (roomName ? r.name === roomName : !r.name)
            );

            if (waiting) {
                // Join existing room
                waiting.o = from;
                waiting.game.playerO = sender;
                waiting.pnameO = pname;
                waiting.state = 'PLAYING';

                await sendCard(sock, msg, chatId, stateCard(waiting),
                    '🎮 Tic-Tac-Toe 2 Started!');
                return;
            }

            // Create new waiting room
            const room = {
                id:    'ttt2-' + Date.now(),
                x:     from,
                o:     '',
                game:  new TicTacToe(sender, 'o'), // playerO will be set on join
                pnameX: pname,
                state: 'WAITING',
            };
            if (roomName) room.name = roomName;
            games[room.id] = room;

            await sendCard(sock, msg, chatId, waitingCard(),
                '⏳ Waiting for an opponent… have someone type .ttt2 start to join.');
        } catch (error) {
            console.error('Error in ttt2 command:', error);
            await extra.reply('❌ Error starting game. Please try again.');
        }
    },
};

// ───────────────────────── move handler ─────────────────────────
async function handleTtt2Move(sock, msg, extra) {
    try {
        const { sender, from } = extra;
        const text = (msg.message?.conversation ||
                      msg.message?.extendedTextMessage?.text || '').trim();

        const room = Object.values(games).find(r =>
            r.id.startsWith('ttt2') &&
            [r.game.playerX, r.game.playerO].includes(sender) &&
            r.state === 'PLAYING'
        );
        if (!room) return false;

        const isSurrender = /^(surrender|give up)$/i.test(text);
        if (!isSurrender && !/^[1-9]$/.test(text)) return false;

        // Surrender bypasses turn check
        if (sender !== room.game.currentTurn && !isSurrender) {
            await sendCard(sock, msg, from,
                noticeCard('✋', 'NOT YOUR TURN', 'wait for your turn — check the 🎲 banner'),
                '❌ Not your turn!');
            return true;
        }

        if (isSurrender) {
            const loserIsX = sender === room.game.playerX;
            const loser = loserIsX ? room.pnameX : room.pnameO;
            const winner = loserIsX ? room.pnameO : room.pnameX;
            await sendCard(sock, msg, room.x,
                stateCard(room, `🏳️ ${esc(displayName(sender, loser))} surrendered — ${esc(displayName(loserIsX ? room.game.playerO : room.game.playerX, winner))} wins!`),
                '🏳️ Surrender — game over.');
            if (!room.botMode && room.x !== room.o) {
                await sendCard(sock, msg, room.o, stateCard(room, `🏳️ ${esc(displayName(sender, loser))} surrendered!`), '🏳️ Surrender — game over.');
            }
            delete games[room.id];
            return true;
        }

        // Apply the move
        const ok = room.game.turn(sender === room.game.playerO, parseInt(text) - 1);
        if (!ok) {
            await sendCard(sock, msg, from,
                noticeCard('✖', 'CELL ALREADY TAKEN', 'pick an empty number (1-9)'),
                '❌ Invalid move! That position is already taken.');
            return true;
        }

        await sendCard(sock, msg, room.x, stateCard(room), '🎮 Tic-Tac-Toe 2');
        if (room.x !== room.o) {
            await sendCard(sock, msg, room.o, stateCard(room), '🎮 Tic-Tac-Toe 2');
        }

        if (room.game.winner || (room.game.turns === 9 && !room.game.winner)) {
            delete games[room.id];
        }
        return true;
    } catch (error) {
        console.error('Error in ttt2 move:', error);
        return false;
    }
}

module.exports.handleTtt2Move = handleTtt2Move;
