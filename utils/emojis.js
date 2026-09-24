/**
 * Static emoji pools used by reaction features.
 *
 * User preferences belong in SQLite; this deliberately keeps the available
 * random reaction choices in source code instead of storing a large array per
 * bot installation.
 */
module.exports = {
  reactions: [
    '😂', '❤️', '🔥', '😭', '😍', '🤣', '😮', '👏', '👍', '💀',
    '😁', '✨', '👌', '🤨', '😎', '🤝', '💫', '🌍'
  ]
};
