const STORAGE_KEY = 'echo-chat-state-v1';

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
  const fallback = cloneDefault();
  if (!isObject(value)) return fallback;

  const state = {
    ...fallback,
    ...value,
    version: 1,
    conversations: Array.isArray(value.conversations) && value.conversations.length
      ? value.conversations.map((conversation) => ({
        ...fallback.conversations.find((item) => item.id === conversation.id),
        ...conversation,
      }))
      : fallback.conversations,
    messagesByConversation: isObject(value.messagesByConversation)
      ? value.messagesByConversation  // 完全信任存储数据，不与 fallback 合并（防止默认消息覆盖真实消息）
      : fallback.messagesByConversation,
    drafts: isObject(value.drafts) ? value.drafts : {},
  };

  const hasActive = state.conversations.some((item) => item.id === state.activeConversationId);
  if (!hasActive) state.activeConversationId = state.conversations[0].id;
  return state;
}

const AVATAR_KEY_PREFIX = 'echo-conv-avatar-v1.';

// 把 conversations 里的 avatarData 抽出存独立 key，主 JSON 里只留占位
function extractAvatars(state) {
  if (!Array.isArray(state.conversations)) return state;
  state.conversations.forEach((conv) => {
    if (conv.avatarData) {
      try {
        window.localStorage.setItem(AVATAR_KEY_PREFIX + conv.id, conv.avatarData);
      } catch { /* ignore */ }
      delete conv.avatarData;  // 从主 JSON 里去掉
    }
  });
  return state;
}

// 读取时把 avatarData 补回
function restoreAvatars(state) {
  if (!Array.isArray(state.conversations)) return state;
  state.conversations.forEach((conv) => {
    if (!conv.avatarData) {
      try {
        const data = window.localStorage.getItem(AVATAR_KEY_PREFIX + conv.id);
        if (data) conv.avatarData = data;
      } catch { /* ignore */ }
    }
  });
  return state;
}

export function saveChatState(nextState) {
  const state = normalizeState(nextState);
  state.updatedAt = Date.now();
  // 先尝试直接写入
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch { /* 空间不足，执行瘦身 */ }

  // 把 avatarData 迁出，再试一次
  extractAvatars(state);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return restoreAvatars(state);
  } catch { /* 仍然失败，截断旧消息 */ }

  // 每个对话只保留最近 50 条消息，再试
  if (state.messagesByConversation) {
    Object.keys(state.messagesByConversation).forEach((id) => {
      const msgs = state.messagesByConversation[id];
      if (Array.isArray(msgs) && msgs.length > 50) {
        state.messagesByConversation[id] = msgs.slice(-50);
      }
    });
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* 真的满了，放弃本次写入 */ }
  return restoreAvatars(state);
}

export function loadChatState() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const state = normalizeState(stored ? JSON.parse(stored) : null);
    return restoreAvatars(state);
  } catch {
    return cloneDefault();
  }
}

export function updateChatState(mutator) {
  const state = loadChatState();
  mutator(state);
  return saveChatState(state);
}

export function getConversation(id, state = loadChatState()) {
  return state.conversations.find((conversation) => conversation.id === id)
    || state.conversations[0];
}

export function getMessages(id, state = loadChatState()) {
  return Array.isArray(state.messagesByConversation[id])
    ? state.messagesByConversation[id]
    : [];
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
  return updateChatState((state) => {
    if (text) state.drafts[id] = text;
    else delete state.drafts[id];
  });
}

export function appendMessage(id, message) {
  return updateChatState((state) => {
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;

    const messages = state.messagesByConversation[id] || (state.messagesByConversation[id] = []);
    const entry = {
      id: message.id || `${id}-${Date.now()}`,
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
    messages.push(entry);

    conversation.preview = messages[messages.length - 1].text;
    conversation.time = messages[messages.length - 1].time;
    conversation.unread = false;
  });
}

export function subscribeToChatState(handler) {
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) handler(loadChatState());
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export { STORAGE_KEY };
