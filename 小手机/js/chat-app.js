import {
  appendMessage,
  getConversation,
  getMessages,
  loadChatState,
  markConversationRead,
  setActiveConversation,
  setDraft,
  subscribeToChatState,
} from './chat-state.js';
import {
  chatListHref,
  chatRoomHref,
  chatSettingsHref,
  parseChatRoute,
} from './chat-router.js';

const page = window.location.pathname.split('/').pop() || 'home.html';

function currentPageName() {
  if (page === 'chat-room.html' || page === 'chat.html') return 'chat';
  if (page === 'chat-list.html') return 'chat-list';
  return page.replace('.html', '');
}

function setText(selector, value, root = document) {
  const node = root.querySelector(selector);
  if (node) node.textContent = value;
}

function initMainNavigation() {
  const tabbar = document.querySelector('#tabbar, #room-tabbar');
  if (!tabbar) return;

  const state = loadChatState();
  const activeId = state.activeConversationId || state.conversations[0]?.id || 'nereus';
  const activePage = currentPageName();
  const links = {
    home: 'home.html',
    chat: chatRoomHref(activeId, 'tab'),
    settings: 'settings.html',
    other: 'other.html',
  };

  Object.entries(links).forEach(([name, href]) => {
    const link = tabbar.querySelector(`#tab-${name}`);
    if (!link) return;
    if (name === 'chat' || !link.getAttribute('href')) link.setAttribute('href', href);
    if (name === activePage || (activePage === 'chat-list' && name === 'chat')) {
      link.classList.add('tabbar__item--active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

function renderChatList() {
  const list = document.querySelector('#chat-items');
  if (!list) return;

  const state = loadChatState();
  const source = new URLSearchParams(window.location.search).get('from') || 'home';
  state.conversations.forEach((conversation) => {
    const link = list.querySelector(`#chat-${conversation.id}`);
    if (!link) return;
    link.setAttribute('href', chatRoomHref(conversation.id, 'list', source));
    link.dataset.conversationId = conversation.id;
    link.onclick = () => setActiveConversation(conversation.id);

    setText('.chat-item__name', conversation.name, link);
    setText('.chat-item__preview', conversation.preview, link);
    setText('.chat-item__time', conversation.time, link);
    const unread = link.querySelector('.chat-item__unread');
    if (unread) unread.hidden = !conversation.unread;
  });

  const back = document.querySelector('#btn-back');
  if (back) back.setAttribute('href', chatListReturnHref());
}

function chatListReturnHref() {
  const from = new URLSearchParams(window.location.search).get('from');
  if (from === 'other') return 'other.html';
  return 'home.html';
}

function renderMessages(conversation, messages) {
  const container = document.querySelector('#room-msgs');
  if (!container) return;
  const fragment = document.createDocumentFragment();
  let previousTime = '';

  messages.forEach((message) => {
    if (message.time !== previousTime) {
      const time = document.createElement('time');
      time.className = 'msg-time';
      time.textContent = message.time;
      fragment.append(time);
      previousTime = message.time;
    }

    const row = document.createElement('div');
    row.className = `msg msg--${message.author === 'mine' ? 'mine' : 'peer'}`;

    const avatar = document.createElement('div');
    avatar.className = `avatar avatar--${message.author === 'mine' ? 'mine' : conversation.avatar}`;
    const initial = document.createElement('span');
    initial.className = 'avatar__initial';
    initial.textContent = message.author === 'mine' ? '我' : conversation.initial;
    avatar.append(initial);

    const bubble = document.createElement('p');
    bubble.className = 'msg__bubble';
    bubble.textContent = message.text;
    row.append(avatar, bubble);
    fragment.append(row);
  });

  container.replaceChildren(fragment);
  container.scrollTop = container.scrollHeight;
}

function initChatRoom() {
  const root = document.querySelector('#screen-chatroom');
  if (!root) return;

  const route = parseChatRoute();
  root.dataset.navMode = route.mode;
  root.classList.toggle('is-tab-mode', route.mode === 'tab');
  setActiveConversation(route.conversationId);
  markConversationRead(route.conversationId);

  const back = document.querySelector('#btn-room-back');
  if (back) {
    back.setAttribute('href', chatListHref(route.source));
    back.classList.toggle('is-context-hidden', route.mode === 'tab');
    back.setAttribute('aria-hidden', route.mode === 'tab' ? 'true' : 'false');
  }

  const state = loadChatState();
  const conversation = getConversation(route.conversationId, state);
  setText('.room-nav__name', conversation.name);
  setText('.room-nav__status', conversation.status);

  const more = document.querySelector('#btn-room-more');
  if (more) more.setAttribute('href', chatSettingsHref(conversation.id, route.mode, route.source));

  const input = document.querySelector('#input-message');
  if (input) input.value = state.drafts[conversation.id] || '';

  const render = (nextState = loadChatState()) => {
    const current = getConversation(route.conversationId, nextState);
    renderMessages(current, getMessages(current.id, nextState));
  };
  render(state);

  if (input) {
    input.addEventListener('input', () => setDraft(conversation.id, input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      appendMessage(conversation.id, { author: 'mine', text });
      setDraft(conversation.id, '');
      input.value = '';
      render();
    });
  }

  subscribeToChatState(render);
}

function initChatSettings() {
  const back = document.querySelector('#btn-back');
  if (!back) return;
  const route = parseChatRoute();
  back.setAttribute('href', chatRoomHref(route.conversationId, route.mode, route.source));
}

function redirectLegacyChatPage() {
  if (page !== 'chat.html') return false;
  const state = loadChatState();
  const id = state.activeConversationId || state.conversations[0]?.id || 'nereus';
  window.location.replace(chatRoomHref(id, 'tab'));
  return true;
}

function init() {
  if (redirectLegacyChatPage()) return;
  initMainNavigation();
  if (page === 'chat-list.html') {
    renderChatList();
    subscribeToChatState(renderChatList);
  }
  if (page === 'chat-room.html') initChatRoom();
  if (page === 'chat-settings.html') initChatSettings();
}

init();
