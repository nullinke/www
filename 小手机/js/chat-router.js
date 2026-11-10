import { loadChatState, getConversation } from './chat-state.js';

const VALID_MODES = new Set(['tab', 'list']);
const VALID_SOURCES = new Set(['home', 'other', 'chat-list']);

export function parseChatRoute(url = window.location.href) {
  const parsed = new URL(url, window.location.href);
  const params = parsed.searchParams;
  const state = loadChatState();
  const requestedId = params.get('conversationId');
  const fallbackId = state.activeConversationId || state.conversations[0]?.id || 'nereus';
  const conversation = getConversation(requestedId || fallbackId, state);

  return {
    mode: VALID_MODES.has(params.get('nav')) ? params.get('nav') : 'list',
    source: VALID_SOURCES.has(params.get('from')) ? params.get('from') : 'home',
    conversationId: conversation.id,
  };
}

function query(params) {
  return new URLSearchParams(params).toString();
}

export function chatRoomHref(conversationId, mode = 'list', source = '') {
  const params = { nav: mode, conversationId };
  if (mode === 'list' && VALID_SOURCES.has(source)) params.from = source;
  return `chat-room.html?${query(params)}`;
}

export function chatListHref(source = 'home') {
  return `chat-list.html?${query({ from: source })}`;
}

export function chatSettingsHref(conversationId, mode = 'list', source = '') {
  const params = { nav: mode, conversationId };
  if (VALID_SOURCES.has(source)) params.from = source;
  return `chat-settings.html?${query(params)}`;
}
