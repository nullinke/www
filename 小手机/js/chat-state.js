import { readJson, writeJson, subscribe, uniqueId, writeImageRecord, hydrateImages } from './storage-state.js';

const STORAGE_KEY = 'echo-chat-state-v1';
const DRAFTS_KEY = 'echo-chat-drafts-v2';

const DEFAULT_STATE = {
  version: 1,
  activeConversationId: 'nereus',
  conversations: [
    {
      id: 'nereus',
      name: 'Nereus',
      initial: 'N',
      avatar: 'peer',
      status: '在线',
      preview: '今天海边的风很轻，想到你了',
      time: '21:47',
      unread: true,
    },
    {
      id: 'momo',
      name: 'Momo',
      initial: 'M',
      avatar: 'mine',
      status: '在线',
      preview: '新买的唱片到了，周末来听',
      time: '19:02',
      unread: false,
    },
    {
      id: 'group',
      name: '潮汐小屋',
      initial: '群',
      avatar: 'group',
      status: '3 人在线',
      preview: 'Momo：今晚一起听歌吗',
      time: '昨天',
      unread: false,
    },
  ],
  messagesByConversation: {
    nereus: [
      { id: 'nereus-1', author: 'peer', text: '今天海边的风很轻，想到你了', time: '21:32' },
      { id: 'nereus-2', author: 'peer', text: '就把今天的晚霞装进瓶子里，放在窗台上了', time: '21:32' },
      { id: 'nereus-3', author: 'mine', text: '那我明天来取，顺便带刚烤好的饼干', time: '21:47' },
      { id: 'nereus-4', author: 'peer', text: '好，我等你 (≧▽≦)', time: '21:47' },
    ],
    momo: [
      { id: 'momo-1', author: 'peer', text: '新买的唱片到了，周末来听', time: '19:02' },
    ],
    group: [
      { id: 'group-1', author: 'peer', text: '今晚一起听歌吗', time: '昨天' },
    ],
  },
  drafts: {},
  updatedAt: 0,
};

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeState(value) {
  if (!isObject(value) || (value.version !== undefined && value.version !== 1) || !Array.isArray(value.conversations) || !isObject(value.messagesByConversation)) {
    throw new Error('聊天数据结构无效，已保留原数据，请先备份。');
  }
  const conversations = value.conversations.map((item) => {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') throw new Error('角色数据无效，请先备份。');
    return { ...item, initial: item.initial || item.name.charAt(0), avatar: item.avatar || 'peer' };
  });
  if (new Set(conversations.map(c => c.id)).size !== conversations.length) throw new Error('存在重复角色 ID，请先备份。');
  const messagesByConversation = Object.create(null);
  for (const [id, messages] of Object.entries(value.messagesByConversation)) {
    if (!Array.isArray(messages) || messages.some(m => !isObject(m) || typeof m.text !== 'string')) throw new Error('消息数据无效，请先备份。');
    messagesByConversation[id] = messages.map(m => ({ ...m }));
  }
  return {
    ...value, version: 1, conversations, messagesByConversation,
    drafts: isObject(value.drafts) ? { ...value.drafts } : {},
    activeConversationId: conversations.some(c => c.id === value.activeConversationId) ? value.activeConversationId : (conversations[0]?.id || null),
  };
}

export function saveChatState(nextState) {
  const state = normalizeState(nextState);
  state.updatedAt = Date.now();
  // One atomic setItem. Never migrate/delete avatars or truncate history as a fallback.
  return writeImageRecord(STORAGE_KEY, state, 'echo-chat-change');
}

export function loadChatState() {
  const state = normalizeState(hydrateImages(readJson(STORAGE_KEY, cloneDefault)));
  for (const conv of state.conversations) {
    if (!conv.avatarData) conv.avatarData = window.localStorage.getItem('echo-conv-avatar-v1.' + conv.id) || '';
  }
  state.drafts = readJson(DRAFTS_KEY, state.drafts);
  return state;
}

export function updateChatState(mutator) {
  const state = loadChatState();
  mutator(state);
  return saveChatState(state);
}

export function getConversation(id, state = loadChatState()) {
  return state.conversations.find(conversation => conversation.id === id) || null;
}

export function getMessages(id, state = loadChatState()) {
  return state.messagesByConversation[id] || [];
}

export function createConversation(input) {
  const entry = { status: '在线', preview: '', time: '', unread: false, ...input, id: uniqueId(input.avatar === 'group' ? 'group-' : 'char-') };
  if (!entry.name?.trim()) throw new Error('请填写角色或群聊名称。');
  entry.name = entry.name.trim();
  entry.initial = entry.name.charAt(0).toUpperCase();
  updateChatState(state => {
    state.conversations.push(entry);
    state.messagesByConversation[entry.id] = [];
    state.activeConversationId = entry.id;
  });
  return entry;
}

export function updateConversation(id, patch) {
  return updateChatState(state => {
    const conv = getConversation(id, state);
    if (!conv) throw new Error('角色已不存在。');
    Object.assign(conv, patch, { id });
    if (patch.name !== undefined) conv.initial = String(patch.name).charAt(0).toUpperCase();
  });
}

export function deleteConversation(id) {
  const state = updateChatState(state => {
    state.conversations = state.conversations.filter(c => c.id !== id);
    for (const conv of state.conversations) if (Array.isArray(conv.members)) conv.members = conv.members.filter(mid => mid !== id);
    delete state.messagesByConversation[id];
    delete state.drafts[id];
  });
  try { setDraft(id, ''); } catch { /* stale draft has no visible conversation */ }
  // Best-effort cleanup only after the canonical conversation deletion commits.
  try { localStorage.removeItem('echo-conv-avatar-v1.' + id); } catch { /* harmless orphan */ }
  try {
    const couple = readJson('echo-couple-v1', {});
    if (couple.charId === id) writeJson('echo-couple-v1', { ...couple, charId: null });
  } catch { /* a stale association is also ignored by the reader */ }
  return state;
}

export function updateMessage(conversationId, messageId, patch) {
  return updateChatState(state => {
    const messages = getMessages(conversationId, state);
    const message = messages.find(m => m.id === messageId);
    if (!message) throw new Error('消息已不存在。');
    Object.assign(message, patch, { id: messageId });
    updatePreview(state, conversationId);
  });
}

export function removeMessages(conversationId, predicate) {
  return updateChatState(state => {
    state.messagesByConversation[conversationId] = getMessages(conversationId, state).filter(m => !predicate(m));
    updatePreview(state, conversationId);
  });
}

function updatePreview(state, id) {
  const conv = getConversation(id, state);
  const last = getMessages(id, state).filter(m => m.status !== 'pending' && m.status !== 'failed' && m.status !== 'cancelled').at(-1);
  if (conv) { conv.preview = last?.text || ''; conv.time = last?.time || ''; }
}

export function replaceReplyTurn(conversationId, turnId, entries, legacyMessageId = null) {
  return updateChatState(state => {
    if (!getConversation(conversationId, state)) throw new Error('会话已被删除。');
    const current = getMessages(conversationId, state);
    const matches = message => message.author !== 'mine' && (message.turnId === turnId || message.id === legacyMessageId);
    const first = current.findIndex(matches);
    const next = current.filter(message => !matches(message));
    next.splice(first < 0 ? next.length : first, 0, ...entries);
    state.messagesByConversation[conversationId] = next;
    updatePreview(state, conversationId);
  });
}

export function setActiveConversation(id) {
  return updateChatState((state) => {
    if (state.conversations.some((conversation) => conversation.id === id)) {
      state.activeConversationId = id;
    }
  });
}

export function markConversationRead(id) {
  return updateChatState((state) => {
    const conversation = state.conversations.find((item) => item.id === id);
    if (conversation) conversation.unread = false;
  });
}

export function setDraft(id, text) {
  const drafts = { ...readJson(DRAFTS_KEY, () => loadChatState().drafts) };
  if (text) drafts[id] = text;
  else delete drafts[id];
  writeJson(DRAFTS_KEY, drafts);
  return drafts;
}

export function appendMessage(id, message) {
  return updateChatState((state) => {
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;

    const messages = state.messagesByConversation[id] || (state.messagesByConversation[id] = []);
    const entry = {
      id: message.id || uniqueId(id + '-'),
      author: message.author === 'mine' ? 'mine' : 'peer',
      text: String(message.text || '').trim(),
      time: message.time || new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date()),
    };
    // 群聊回复角色信息：保留以便渲染时显示正确头像
    if (message.replyCharId)      entry.replyCharId      = String(message.replyCharId);
    if (message.replyCharName)    entry.replyCharName    = String(message.replyCharName);
    if (message.replyCharInitial) entry.replyCharInitial = String(message.replyCharInitial);
    if (message.replyCharAvatar !== undefined) entry.replyCharAvatar = String(message.replyCharAvatar);
    if (message.think)            entry.think            = String(message.think);
    for (const key of ['turnId', 'status']) if (message[key]) entry[key] = String(message[key]);
    messages.push(entry);

    updatePreview(state, id);
    conversation.unread = false;
  });
}

export function subscribeToChatState(handler) {
  return subscribe(STORAGE_KEY, 'echo-chat-change', handler, loadChatState);
}

export { STORAGE_KEY };
