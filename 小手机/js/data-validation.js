/** Validate imported data without coercing or silently dropping user content. */
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
export function assertPlainData(value) {
  const pending = [[value, 0]]; let visited = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++visited > 1000000 || depth > 40) throw new Error('数据嵌套或条目过多。');
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('数据必须为普通记录。');
    for (const [key, child] of Object.entries(item)) {
      if (unsafeKeys.has(key)) throw new Error('数据包含不安全的字段。');
      pending.push([child, depth + 1]);
    }
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const optional = (value, key, check) => value[key] === undefined || check(value[key]);
function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function validateBusinessRecord(key, value) {
  assertPlainData(value);
  const lists = ['echo-memory-v1', 'echo-moments-v1', 'echo-world-v1'];
  requireValue(lists.includes(key) ? Array.isArray(value) : record(value), '数据结构无效：' + key);
  requireValue(value.version === undefined || value.version === 1, '不支持的数据版本：' + key);
  if (key === 'echo-chat-state-v1') {
    requireValue(Array.isArray(value.conversations) && record(value.messagesByConversation), '聊天数据结构无效。');
    const ids = new Set();
    for (const conversation of value.conversations) {
      requireValue(record(conversation) && string(conversation.id) && conversation.id && !unsafeKeys.has(conversation.id) && string(conversation.name) && !ids.has(conversation.id), '角色 ID 或名称无效。');
      ids.add(conversation.id);
      for (const field of ['initial', 'alias', 'persona', 'preview', 'time', 'avatar']) requireValue(optional(conversation, field, string), '角色字段无效：' + field);
      requireValue(optional(conversation, 'archive', record) && optional(conversation, 'members', members => Array.isArray(members) && members.every(string) && new Set(members).size === members.length), '角色档案或群成员无效。');
    }
    for (const [id, rows] of Object.entries(value.messagesByConversation)) {
      requireValue(string(id) && Array.isArray(rows), '消息列表无效。');
      const messageIds = new Set();
      for (const row of rows) {
        requireValue(record(row) && string(row.id) && row.id && !messageIds.has(row.id) && string(row.text), '消息 ID、正文或唯一性无效。');
        messageIds.add(row.id);
        requireValue(optional(row, 'author', author => ['mine', 'peer'].includes(author)) && optional(row, 'status', status => ['pending', 'streaming', 'complete', 'failed', 'cancelled', 'interrupted'].includes(status)), '消息状态无效。');
        for (const field of ['time', 'think', 'turnId', 'replyCharId', 'replyCharName', 'replyCharInitial']) requireValue(optional(row, field, string), '消息字段无效：' + field);
      }
    }
    requireValue(optional(value, 'drafts', drafts => record(drafts) && Object.values(drafts).every(string)), '草稿数据无效。');
  } else if (key === 'echo-chat-drafts-v2') requireValue(Object.values(value).every(string), '草稿数据无效。');
  else if (key === 'echo-profile-v1') {
    for (const field of ['nickname', 'bio', 'coverTone']) requireValue(optional(value, field, string), '资料字段无效。');
    requireValue(optional(value, 'archive', record), '资料档案无效。');
  } else if (key === 'echo-memory-v1') {
    for (const item of value) requireValue(record(item) && string(item.content) && optional(item, 'tags', tags => Array.isArray(tags) && tags.every(string)), '记忆条目无效。');
  } else if (key === 'echo-moments-v1') {
    const ids = new Set();
    for (const item of value) {
      requireValue(record(item) && string(item.id) && item.id && !ids.has(item.id) && string(item.text), '动态条目无效。'); ids.add(item.id);
      requireValue(optional(item, 'images', images => Array.isArray(images) && images.every(string)) && optional(item, 'comments', Array.isArray), '动态图片或评论无效。');
    }
  } else if (key === 'echo-world-v1') requireValue(value.every(record), '世界书条目无效。');
  else if (key === 'echo-couple-v1') {
    requireValue(optional(value, 'charId', id => id === null || string(id)), '情侣关联无效。');
    for (const field of ['autoMessages', 'autoMoments', 'includeImages', 'showThoughts']) requireValue(optional(value, field, value => typeof value === 'boolean'), '自动化设置无效。');
    for (const field of ['intervalMinutes', 'summarizeRounds']) requireValue(optional(value, field, value => Number.isFinite(Number(value))), '自动化间隔无效。');
  }
}
