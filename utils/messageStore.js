/**
 * June X — In-Memory Message Store (LRU-bounded)
 *
 * Holds the recent messages per chat for:
 *   - Baileys getMessage (quoted-message resolution)
 *   - .clean / .delete / .reshare (which read store.messages)
 *
 * Bounded on BOTH axes so a long-running process can't grow into an R14:
 *   - per chat:  most recent `maxPerChat` messages (default 20)
 *   - total:     most recently used `maxChats` chats   (default 300)
 *
 * Insertion order in the outer Map IS the LRU order: every write re-inserts
 * the chat key, so eviction always drops the least-recently-seen chat first.
 */

function createMessageStore({ maxPerChat = 20, maxChats = 300 } = {}) {
    const messages = new Map() // jid -> Map<msgId, msg>

    /**
     * Store one message, keeping both caps. Safe to call with bad input (no-op).
     */
    function storeMessage(jid, msg) {
        if (!jid || !msg || !msg.key || !msg.key.id) return

        let chat = messages.get(jid)
        if (!chat) {
            chat = new Map()
            messages.set(jid, chat) // new chat → most recently used
        } else {
            messages.delete(jid) // LRU touch: re-insert as most recently used
            messages.set(jid, chat)
        }

        chat.set(msg.key.id, msg)
        while (chat.size > maxPerChat) chat.delete(chat.keys().next().value)
        while (messages.size > maxChats) messages.delete(messages.keys().next().value)
    }

    /**
     * Drop the oldest chats until `target` remain (memory-watchdog escape hatch).
     * @returns {number} remaining chat count
     */
    function evictOldestChats(target) {
        const limit = Math.max(0, Math.floor(target))
        while (messages.size > limit) messages.delete(messages.keys().next().value)
        return messages.size
    }

    return {
        messages,
        maxPerChat,
        maxChats,
        storeMessage,
        evictOldestChats,

        // Baileys-style binding: feeds the store from messages.upsert
        bind(ev) {
            ev.on('messages.upsert', ({ messages: upserted }) => {
                for (const m of upserted || []) {
                    storeMessage(m.key?.remoteJid, m)
                }
            })
        },

        async loadMessage(jid, id) {
            return messages.get(jid)?.get(id) || null
        }
    }
}

module.exports = { createMessageStore }
