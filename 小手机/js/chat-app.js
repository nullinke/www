import { streamChat, parseReply, requestCompletion, apiEndpoint } from './api.js';
import { StorageError, readJson, writeJson, uniqueId, safeImage, createBackup, restoreBackup, initializeStorage } from './storage-state.js';
import {
  defaultChatState, loadMessagePage, messageWindow, withReplyTask, currentReplyTask, loadReplyHistory, recoverReplyTask,
  appendMessage,
  updateConversation, createConversation, deleteConversation, updateMessage, deleteMessage, replaceReplyTurn,
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
import {
  loadSettings,
  updateSettings,
  subscribeToSettings,
  saveThemeAsset,
  loadThemeAsset,
} from './settings-state.js';
import {
  filterMemories,
  subscribeToMemories,
  formatMemoryDate,
  deleteMemory,
  saveMemory,
} from './memory-state.js';
import {
  loadProfile,
    updateProfile,
  subscribeToProfile,
} from './profile-state.js';
import {
  loadPosts,
  toggleLike,
  addPost,
  subscribeToPosts,
} from './moments-state.js';

function reportError(error) {
  console.error('[Echo]', error);
  alert(error?.message || '操作未完成，请重试。');
}
window.addEventListener('error', event => {
  if (event.error instanceof StorageError) { event.preventDefault(); reportError(event.error); }
});
window.addEventListener('unhandledrejection', event => {
  event.preventDefault(); reportError(event.reason);
});

const page = window.location.pathname.split('/').pop() || 'home.html';

function currentPageName() {
  if (page === 'chat-room.html') return 'chat';
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
  const activeId = state.activeConversationId || state.conversations[0]?.id || null;
  const activePage = currentPageName();
  const links = {
    home: 'home.html',
    chat: activeId ? chatRoomHref(activeId, 'tab') : chatListHref('home'),
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
      link.classList.remove('tabbar__item--active');
      link.removeAttribute('aria-current');
    }
  });
}

function renderChatList() {
  const list = document.querySelector('#chat-items');
  if (!list) return;

  const state  = loadChatState();
  const source = new URLSearchParams(window.location.search).get('from') || 'home';

  // 全量重建列表
  list.innerHTML = '';
  const fragment = document.createDocumentFragment();

  state.conversations.forEach((conversation) => {
    const li = document.createElement('li');

    // 头像
    let avatarInner = '';
    if (conversation.avatarData) {
      avatarInner = `<img src="${safeImage(conversation.avatarData)}" alt="${escapeHtml(conversation.name)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else if (conversation.avatar === 'group') {
      avatarInner = `<i class="fa-solid fa-user-group" aria-hidden="true"></i>`;
    } else {
      const initial = conversation.initial || conversation.name.charAt(0).toUpperCase();
      avatarInner = `<span class="avatar__initial">${escapeHtml(initial)}</span>`;
    }
    const avatarClass = conversation.avatar === 'group'
      ? 'avatar avatar--group'
      : conversation.avatar === 'mine'
        ? 'avatar avatar--mine'
        : 'avatar avatar--peer';

    // 未读点
    const unreadHtml = conversation.unread
      ? `<span class="chat-item__unread" aria-label="未读"></span>`
      : '';

    li.innerHTML = `
      <a class="chat-item glass" href="${chatRoomHref(conversation.id, 'list', source)}">
        <div class="${avatarClass}">${avatarInner}</div>
        <div class="chat-item__body">
          <span class="chat-item__name">${escapeHtml(conversation.name)}</span>
          <span class="chat-item__preview">${escapeHtml(conversation.preview || '')}</span>
        </div>
        <div class="chat-item__meta">
          <span class="chat-item__time">${escapeHtml(conversation.time || '')}</span>
          ${unreadHtml}
        </div>
      </a>`;

    fragment.appendChild(li);
  });

  list.appendChild(fragment);

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

  // 读取「我」的 profile，用于头像和昵称首字
  const myProfile = loadProfile();
  // 一次性读取最新 state，供头像查找使用（避免每条消息都读 localStorage）
  let freshState = null;
  function getFreshState() {
    if (!freshState) freshState = loadChatState();
    return freshState;
  }

  const legacyPeerIndices = conversation.avatar === 'group'
    ? new Map(getMessages(conversation.id, getFreshState()).filter(m => m.author !== 'mine').map((m, index) => [m.id, index]))
    : new Map();

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
    row.dataset.msgId = message.id;

    const avatar = document.createElement('div');
    avatar.className = `avatar avatar--${message.author === 'mine' ? 'mine' : conversation.avatar}`;

    if (message.author === 'mine' && myProfile.avatarData) {
      avatar.innerHTML = `<img src="${safeImage(myProfile.avatarData)}" alt="我"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else if (message.author !== 'mine') {
      // 始终从最新 state 实时查头像，确保角色修改头像后聊天页面同步
      let peerAvatar  = '';
      let peerInitial = message.replyCharInitial || '';

      // 优先：有 replyCharId 就直接按 id 查对应角色（单人/群聊通用）
      const lookupId = message.replyCharId || (conversation.avatar !== 'group' ? conversation.id : null);
      if (lookupId) {
        try {
          const charConv = getFreshState().conversations.find((c) => c.id === lookupId);
          if (charConv) {
            peerAvatar  = charConv.avatarData || '';
            peerInitial = charConv.initial || charConv.name.charAt(0).toUpperCase();
          }
        } catch { /* ignore */ }
      }

      // 群聊旧消息（无 replyCharId）：从成员里按消息索引轮流取，保证每条消息对应固定角色
      if (!message.replyCharId && !peerAvatar && conversation.avatar === 'group' && Array.isArray(conversation.members) && conversation.members.length) {
        try {
          const fs = getFreshState();
          // 找当前消息在 peer 消息列表里的顺序，按轮序分配成员
          const msgPeerIdx = message.peerOrdinal ?? legacyPeerIndices.get(message.id) ?? -1;
          const memberIdx  = msgPeerIdx >= 0 ? msgPeerIdx % conversation.members.length : 0;
          const mid        = conversation.members[memberIdx];
          const mc         = fs.conversations.find((c) => c.id === mid);
          if (mc) {
            peerAvatar  = mc.avatarData || '';
            peerInitial = peerInitial || mc.initial || mc.name.charAt(0).toUpperCase();
          }
        } catch { /* ignore */ }
      }

      // 最终 fallback
      if (!peerInitial) peerInitial = conversation.initial;

      if (peerAvatar) {
        avatar.innerHTML = `<img src="${safeImage(peerAvatar)}" alt="${escapeHtml(peerInitial)}"
          style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      } else {
        const initial = document.createElement('span');
        initial.className = 'avatar__initial';
        initial.textContent = peerInitial;
        avatar.append(initial);
      }
    } else {
      const initial = document.createElement('span');
      initial.className = 'avatar__initial';
      initial.textContent = (myProfile.nickname || '我').charAt(0);
      avatar.append(initial);
    }

    const bubble = document.createElement('p');
    bubble.className = 'msg__bubble';
    bubble.textContent = message.text;
    row.append(avatar, bubble);

    // 心声折叠组件（仅 peer 消息且有 think 内容时渲染）
    if (message.author !== 'mine' && message.think) {
      const thinkWrap   = document.createElement('div');
      thinkWrap.className = 'msg-think';

      const toggle = document.createElement('button');
      toggle.className = 'msg-think__toggle';
      toggle.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>心声';

      const body = document.createElement('div');
      body.className = 'msg-think__body';
      body.textContent = message.think;

      toggle.addEventListener('click', () => {
        const open = body.classList.toggle('is-open');
        toggle.classList.toggle('is-open', open);
      });

      thinkWrap.append(toggle, body);
      row.append(thinkWrap);
    }

    fragment.append(row);
  });

  container.replaceChildren(fragment);

}

async function initChatRoom() {
  const root = document.querySelector('#screen-chatroom');
  if (!root) return;
  const route = parseChatRoute();
  const conversation = getConversation(route.conversationId);
  if (!conversation) { window.location.replace(chatListHref(route.source)); return; }
  root.dataset.navMode = route.mode;
  root.classList.toggle('is-tab-mode', route.mode === 'tab');
  await setActiveConversation(conversation.id);
  await markConversationRead(conversation.id);
  await recoverReplyTask(conversation.id);
  await loadMessagePage(conversation.id);
  const back = document.querySelector('#btn-room-back');
  if (back) {
    back.href = chatListHref(route.source); back.classList.toggle('is-context-hidden', route.mode === 'tab');
    back.setAttribute('aria-hidden', String(route.mode === 'tab'));
  }
  setText('.room-nav__name', conversation.name);
  setText('.room-nav__status', conversation.alias || conversation.status || '在线');
  const navAvatar = document.getElementById('room-nav-avatar');
  if (navAvatar && safeImage(conversation.avatarData)) {
    const image = document.createElement('img'); image.src = safeImage(conversation.avatarData); image.alt = conversation.name; navAvatar.replaceChildren(image);
  } else setText('#room-nav-initial', conversation.initial || conversation.name.charAt(0));
  if (conversation.bubbleColor) document.documentElement.style.setProperty('--bubble-mine-bg', conversation.bubbleColor);
  if (conversation.peerBubbleColor) document.documentElement.style.setProperty('--bubble-peer-bg', conversation.peerBubbleColor);
  const more = document.querySelector('#btn-room-more');
  if (more) more.href = chatSettingsHref(conversation.id, route.mode, route.source);
  const input = document.querySelector('#input-message');
  const msgContainer = document.querySelector('#room-msgs');
  if (!input) return;
  input.value = loadChatState().drafts[conversation.id] || '';
  let activeTask = null, isGenerating = false, draftTimer = null, loadingOlder = false, disposed = false, taskOwner = null;
  const hidden = new Set();
  const scrollingElement = () => msgContainer.scrollHeight > msgContainer.clientHeight + 2 ? msgContainer : document.scrollingElement;
  const nearBottom = () => { const node = scrollingElement(); return node.scrollHeight - node.clientHeight - node.scrollTop < 120; };
  const render = ({ follow = false } = {}) => {
    if (disposed) return;
    const current = getConversation(conversation.id);
    if (!current) { activeTask?.abort(); window.location.replace(chatListHref(route.source)); return; }
    if (taskOwner && currentReplyTask(conversation.id)?.owner !== taskOwner) activeTask?.abort();
    const anchor = [...msgContainer.querySelectorAll('.msg')].find(row => row.getBoundingClientRect().bottom >= 0);
    const anchorId = anchor?.dataset.msgId, anchorTop = anchor?.getBoundingClientRect().top;
    const stick = follow || nearBottom();
    renderMessages(current, getMessages(current.id).filter(m => !hidden.has(m.id)));
    if (stick) requestAnimationFrame(() => msgContainer.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'instant' }));
    else if (anchorId) {
      const replacement = msgContainer.querySelector(`[data-msg-id="${CSS.escape(anchorId)}"]`);
      if (replacement) scrollingElement().scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    }
    const busyElsewhere = Boolean(currentReplyTask(current.id)) && !activeTask;
    input.disabled = isGenerating || busyElsewhere;
    input.placeholder = busyElsewhere ? '另一个标签页正在回复…' : (isGenerating ? '正在回复…' : '说点什么…');
  };
  render({ follow: true });
  const unsubscribe = subscribeToChatState(() => render());
  const recoveryTimer = setInterval(() => {
    if (!activeTask && !disposed && currentReplyTask(conversation.id)) void recoverReplyTask(conversation.id).then(() => render()).catch(reportError);
  }, 2500);
  async function loadOlder() {
    if (disposed || loadingOlder || scrollingElement().scrollTop > 160 || !messageWindow(conversation.id)?.hasMore) return;
    loadingOlder = true;
    try {
      await loadMessagePage(conversation.id, { before: messageWindow(conversation.id).before, limit: 100, append: true });
      render();
    } catch (error) { reportError(error); }
    finally { loadingOlder = false; }
  }
  window.addEventListener('scroll', loadOlder, { passive: true });
  msgContainer.addEventListener('scroll', loadOlder, { passive: true });
  async function flushDraft() {
    clearTimeout(draftTimer); draftTimer = null;
    if (!isGenerating && !disposed) await setDraft(conversation.id, input.value);
  }
  input.addEventListener('input', () => { clearTimeout(draftTimer); draftTimer = setTimeout(() => { void flushDraft().catch(reportError); }, 350); });
  input.addEventListener('blur', () => { void flushDraft().catch(reportError); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushDraft().catch(reportError); });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
    event.preventDefault(); void sendMessage();
  });
  document.querySelector('#btn-input-voice')?.addEventListener('click', sendMessage);
  window.addEventListener('pagehide', () => {
    activeTask?.abort(); clearTimeout(draftTimer); clearInterval(recoveryTimer); disposed = true; unsubscribe();
    window.removeEventListener('scroll', loadOlder); msgContainer.removeEventListener('scroll', loadOlder);
  }, { once: true });
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
  async function runGeneration({ regenerateMessage = null, userText = '' } = {}) {
    if (activeTask) return;
    const controller = new AbortController(); activeTask = controller; isGenerating = true; render();
    try {
      await withReplyTask(conversation.id, { signal: controller.signal }, async session => {
        taskOwner = session.owner;
        try {
          if (userText) {
            await appendMessage(conversation.id, { author: 'mine', text: userText }, { owner: session.owner });
            input.value = ''; await setDraft(conversation.id, ''); render({ follow: true });
          }
          const current = getConversation(conversation.id);
          let speakers;
          if (regenerateMessage) {
            const speaker = getConversation(regenerateMessage.replyCharId || (current.avatar !== 'group' ? current.id : ''));
            if (!speaker) throw new StorageError('无法确定原回复角色，请发送新消息。');
            speakers = [speaker];
          } else speakers = current.avatar === 'group' ? (current.members || []).map(id => getConversation(id)).filter(Boolean) : [current];
          if (!speakers.length) throw new StorageError('群聊已没有可回复的成员。');
          for (const speaker of speakers) {
            if (current.avatar === 'group' && !regenerateMessage) await wait(600 + Math.floor(Math.random() * 800), session.signal);
            session.signal.throwIfAborted();
            const context = await loadReplyHistory(current.id, { message: regenerateMessage, maxChars: (loadSettings().parameters.context.value + 2) * 1000 });
            const turnId = regenerateMessage?.turnId || uniqueId('turn-'), pendingId = uniqueId('message-');
            const identity = { author: 'peer', replyCharId: speaker.id, replyCharName: speaker.name, replyCharInitial: speaker.initial, turnId };
            await appendMessage(current.id, { ...identity, id: pendingId, text: '…', status: 'pending' }, { owner: session.owner });
            try {
              const raw = await streamChat({
                conversation: speaker, historyMessages: context, signal: session.signal,
                onChunk: (_, fullText) => {
                  const bubble = msgContainer?.querySelector(`[data-msg-id="${CSS.escape(pendingId)}"] .msg__bubble`);
                  if (bubble) {
                    const follow = nearBottom();
                    bubble.textContent = parseReply(fullText, true).text || '…';
                    if (follow) requestAnimationFrame(() => msgContainer.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'instant' }));
                  }
                },
              });
              session.signal.throwIfAborted();
              const reply = parseReply(raw); if (!reply.text) throw new Error('回复没有正文，请重新生成。');
              const parts = reply.text.split('\n').map(text => text.trim()).filter(Boolean);
              const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
              const entries = parts.map((text, index) => ({ ...identity, id: uniqueId('message-'), text, time, status: 'complete', ...(index === 0 && reply.think ? { think: reply.think } : {}) }));
              entries.slice(1).forEach(entry => hidden.add(entry.id));
              await replaceReplyTurn(current.id, turnId, entries, regenerateMessage && !regenerateMessage.turnId ? regenerateMessage.id : null, { owner: session.owner });
              for (const entry of entries.slice(1)) { await wait(420, session.signal); hidden.delete(entry.id); render(); }
              void extractMemories(speaker, context.filter(m => m.author === 'mine').at(-1)?.text || '', reply.text, current.id, turnId, session.signal);
            } catch (error) {
              if (error instanceof StorageError) throw error;
              if (getMessages(current.id).some(m => m.id === pendingId)) await updateMessage(current.id, pendingId, {
                text: error.name === 'AbortError' ? '⚠ 回复已取消，可重新生成' : `⚠ ${error.message}`,
                status: error.name === 'AbortError' ? 'cancelled' : 'failed',
              }, { owner: session.owner });
              if (error.name === 'AbortError') throw error;
            }
          }
        } finally { taskOwner = null; }
      });
    } catch (error) { if (error.name !== 'AbortError' && !disposed) reportError(error); }
    finally { hidden.clear(); activeTask = null; isGenerating = false; render(); }
  }
  async function sendMessage() {
    if (isGenerating) return;
    const text = input.value.trim(); if (!text) return;
    try {
      clearTimeout(draftTimer); draftTimer = null;
      const remember = text.match(/^记住[：:]\s*(.+)$/i);
      if (remember) {
        await saveMemory({ id: Date.now() + Math.random(), content: remember[1].trim(), source: 'user', conversationId: conversation.id, charId: conversation.avatar === 'group' ? '' : conversation.id });
        await appendMessage(conversation.id, { author: 'mine', text });
        await appendMessage(conversation.id, { author: 'peer', text: `✓ 已记住：${remember[1].trim()}` });
        input.value = ''; await setDraft(conversation.id, ''); return;
      }
      await runGeneration({ userText: text });
    } catch (error) { reportError(error); }
  }

  // ── 长按消息上下文菜单 ────────────────────────────────────────────────────
  const ctxMask   = document.getElementById('msg-ctx-mask');
  const ctxMenu   = document.getElementById('msg-ctx-menu');
  const ctxEdit   = document.getElementById('ctx-edit');
  const ctxDelete = document.getElementById('ctx-delete');
  const ctxRegen  = document.getElementById('ctx-regen');

  // 当前选中的消息元数据
  let ctxMsgId   = null;   // message id in storage
  let ctxBubbleEl = null;  // DOM bubble element

  function openCtxMenu(msgId, author, bubbleEl, clientX, clientY) {
    ctxMsgId    = msgId;
    ctxBubbleEl = bubbleEl;

    // 「编辑」只对自己消息开放；「重新生成」只对 peer 最后一条
    if (ctxEdit)  ctxEdit.style.display  = author === 'mine' ? '' : 'none';
    if (ctxRegen) {
      // 判断是否是 peer 的最后一条消息
      const st = loadChatState();
      const msgs = getMessages(conversation.id, st).filter(m => m.author === 'peer');
      const isLastPeer = msgs.length > 0 && msgs[msgs.length - 1].id === msgId;
      ctxRegen.style.display = (author === 'peer' && isLastPeer) ? '' : 'none';
    }

    // 定位菜单：防止超出视口
    if (!ctxMenu) return;
    ctxMenu.style.display = 'block';
    // 先渲染出宽高再定位
    requestAnimationFrame(() => {
      const mw = ctxMenu.offsetWidth  || 180;
      const mh = ctxMenu.offsetHeight || 140;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let x = clientX;
      let y = clientY + 8;
      if (x + mw > vw - 8) x = vw - mw - 8;
      if (y + mh > vh - 8) y = clientY - mh - 8;
      if (x < 8) x = 8;
      if (y < 8) y = 8;
      ctxMenu.style.left = `${x}px`;
      ctxMenu.style.top  = `${y}px`;
    });

    if (ctxMask) ctxMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeCtxMenu() {
    if (ctxMenu)  ctxMenu.style.display = 'none';
    if (ctxMask)  ctxMask.classList.remove('is-open');
    document.body.style.overflow = '';
    ctxMsgId = null; ctxBubbleEl = null;
  }

  ctxMask?.addEventListener('click', closeCtxMenu);

  // 编辑：将气泡变为 contenteditable
  ctxEdit?.addEventListener('click', () => {
    if (!ctxBubbleEl || !ctxMsgId) { closeCtxMenu(); return; }
    const bubble = ctxBubbleEl;
    const msgId = ctxMsgId;
    closeCtxMenu();
    bubble.contentEditable = 'true';
    bubble.classList.add('msg__bubble--editing');
    bubble.focus();
    // 光标移到末尾
    const range = document.createRange();
    range.selectNodeContents(bubble);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    async function commitEdit(e) {
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      if (e.type === 'keydown' && e.shiftKey) return;
      if (e.type === 'keydown') e.preventDefault();
      const newText = bubble.textContent.trim();
      bubble.contentEditable = 'false';
      bubble.classList.remove('msg__bubble--editing');
      bubble.removeEventListener('blur', commitEdit);
      bubble.removeEventListener('keydown', commitEdit);
      if (!newText) return;
      try { await updateMessage(conversation.id, msgId, { text: newText }); }
      catch (error) { reportError(error); }
      render();
    }
    bubble.addEventListener('blur', commitEdit);
    bubble.addEventListener('keydown', commitEdit);
  });

  // 删除
  ctxDelete?.addEventListener('click', async () => {
    const msgId = ctxMsgId;
    closeCtxMenu();
    if (!msgId) return;
    try { await deleteMessage(conversation.id, msgId); }
    catch (error) { reportError(error); }
    render();
  });

  ctxRegen?.addEventListener('click', () => {
    const id = ctxMsgId;
    closeCtxMenu();
    if (isGenerating || !id) return;
    const message = getMessages(conversation.id).find(m => m.id === id);
    if (message) void runGeneration({ regenerateMessage: message });
  });

  // 给消息气泡绑定长按/右键事件（使用事件委托，render 后自动生效）
  // msgContainer 已在上方声明，直接复用
  if (msgContainer) {
    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;

    function startPress(e) {
      // 找到最近的 .msg 行
      const row = e.target.closest('.msg');
      if (!row) return;
      const bubble = row.querySelector('.msg__bubble');
      if (!bubble || bubble.contentEditable === 'true') return;
      pressStartX = e.touches ? e.touches[0].clientX : e.clientX;
      pressStartY = e.touches ? e.touches[0].clientY : e.clientY;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        const author  = row.classList.contains('msg--mine') ? 'mine' : 'peer';
        const msgId   = row.dataset.msgId;
        if (!msgId) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        openCtxMenu(msgId, author, bubble, cx, cy);
      }, 500);
    }

    function cancelPress(e) {
      if (!pressTimer) return;
      // 若移动超过 8px 则取消
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      if (Math.abs(cx - pressStartX) > 8 || Math.abs(cy - pressStartY) > 8) {
        clearTimeout(pressTimer); pressTimer = null;
      }
    }

    function endPress() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    msgContainer.addEventListener('touchstart',  startPress,  { passive: true });
    msgContainer.addEventListener('touchmove',   cancelPress, { passive: true });
    msgContainer.addEventListener('touchend',    endPress);
    msgContainer.addEventListener('touchcancel', endPress);
    // 桌面端右键
    msgContainer.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.msg');
      if (!row) return;
      e.preventDefault();
      const bubble = row.querySelector('.msg__bubble');
      if (!bubble) return;
      const author = row.classList.contains('msg--mine') ? 'mine' : 'peer';
      const msgId  = row.dataset.msgId;
      if (!msgId) return;
      openCtxMenu(msgId, author, bubble, e.clientX, e.clientY);
    });
  }
}

function initChatSettings() {
  const back = document.querySelector('#btn-back');
  if (!back) return;
  const route = parseChatRoute();
  back.setAttribute('href', route.conversationId ? chatRoomHref(route.conversationId, route.mode, route.source) : chatListHref(route.source));
}

function initSettingsPage() {
  const root = document.querySelector('#screen-settings');
  if (!root) return;

  // 来源判断：from=other 时显示返回键、隐藏 Tab 栏
  const from = new URLSearchParams(window.location.search).get('from');
  if (from === 'other') {
    const backBtn    = document.getElementById('btn-settings-back');
    const spacerLeft = document.getElementById('settings-spacer-left');
    const tabbar     = document.getElementById('tabbar');
    if (backBtn)    backBtn.style.display = 'flex';
    if (spacerLeft) spacerLeft.style.display = 'none';
    if (tabbar)     tabbar.style.display = 'none';
    const settingsMain = document.getElementById('settings-main');
    if (settingsMain) settingsMain.style.paddingBottom = '40px';
  }

  // ── range 滑块配置表 ──────────────────────────────────────────────────────
  const RANGE_CONFIGS = {
    'range-temp':  { paramKey: 'temperature',      valId: 'val-temp',  fmt: v => v.toFixed(1) },
    'range-topp':  { paramKey: 'topP',             valId: 'val-topp',  fmt: v => v.toFixed(2).replace(/0$/,'') },
    'range-ctx':   { paramKey: 'context',          valId: 'val-ctx',   fmt: v => `${v}k` },
    'range-freq':  { paramKey: 'frequencyPenalty', valId: 'val-freq',  fmt: v => v.toFixed(1) },
    'range-pres':  { paramKey: 'presencePenalty',  valId: 'val-pres',  fmt: v => v.toFixed(1) },
  };

  // 更新 range 轨道填充渐变
  function updateRangeTrack(input) {
    const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
    input.style.backgroundImage = `linear-gradient(to right,#9CC4E4 0%,#9CC4E4 ${pct}%,#E2EDF5 ${pct}%,#E2EDF5 100%)`;
    input.style.backgroundSize = '100% 4px';
    input.style.backgroundRepeat = 'no-repeat';
    input.style.backgroundPosition = 'center';
  }

  // 从 settings 同步所有控件
  function render(settings) {
    // 模型名
    ['text','voice','image'].forEach((k) => {
      const el = document.querySelector(`#row-${k}-model .set-row__value`);
      if (el) el.textContent = settings.models[k]?.name ?? '';
    });
    // 滑块
    Object.entries(RANGE_CONFIGS).forEach(([rangeId, cfg]) => {
      const input = document.getElementById(rangeId);
      const valEl = document.getElementById(cfg.valId);
      const param = settings.parameters[cfg.paramKey];
      if (!input || !param) return;
      input.value = param.value;
      updateRangeTrack(input);
      if (valEl) valEl.textContent = cfg.fmt(param.value);
    });
    // 超时
    const timeoutEl = document.getElementById('val-timeout');
    if (timeoutEl) timeoutEl.textContent = `${settings.parameters.timeout}s`;
    // MCP 开关
    const sw = document.getElementById('switch-mcp');
    if (sw) {
      sw.classList.toggle('switch--on', settings.mcpEnabled);
      sw.setAttribute('aria-checked', String(settings.mcpEnabled));
    }
  }

  render(loadSettings());
  subscribeToSettings(render);

  // ── 滑块事件绑定 ─────────────────────────────────────────────────────────
  Object.entries(RANGE_CONFIGS).forEach(([rangeId, cfg]) => {
    const input = document.getElementById(rangeId);
    if (!input) return;
    input.addEventListener('input', () => {
      const v = Number(Number(input.value).toFixed(3));
      updateRangeTrack(input);
      const valEl = document.getElementById(cfg.valId);
      if (valEl) valEl.textContent = cfg.fmt(v);
      updateSettings((s) => {
        const pct = ((v - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
        s.parameters[cfg.paramKey] = { value: v, progress: Math.round(pct) };
      });
    });
  });

  // ── MCP 实际连接逻辑 ─────────────────────────────────────────────────────
  const mcpSwitch   = document.getElementById('switch-mcp');
  const statusDot   = document.getElementById('mcp-status-dot');
  const statusLabel = document.getElementById('mcp-status-label');
  const statusValue = document.getElementById('mcp-status-value');

  function setMcpStatus(state, label, value = '') {
    // state: 'connecting' | 'on' | 'off' | 'err'
    if (!statusDot) return;
    statusDot.className = `service-dot service-dot--${state === 'connecting' ? 'off' : state}`;
    if (state === 'connecting') statusDot.style.animation = 'pulse 1s ease infinite';
    else statusDot.style.animation = '';
    if (statusLabel) statusLabel.textContent = label;
    if (statusValue) statusValue.textContent = value;
  }

  let probeController = null;
  let probeSequence = 0;
  async function tryConnectMcp() {
    probeController?.abort();
    const sequence = ++probeSequence;
    const settings = loadSettings();
    if (!settings.mcpEnabled) { setMcpStatus('off', '未检测'); return; }
    if (!settings.models.text.baseUrl) { setMcpStatus('err', '未配置接口地址'); return; }
    const controller = new AbortController(); probeController = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    setMcpStatus('connecting', '检测模型接口…');
    try {
      const headers = {};
      if (settings.models.text.apiKey) headers.Authorization = `Bearer ${settings.models.text.apiKey}`;
      const response = await fetch(apiEndpoint(settings.models.text.baseUrl, 'models'), { headers, signal: controller.signal });
      if (sequence !== probeSequence || !loadSettings().mcpEnabled) return;
      if (response.status === 401 || response.status === 403) setMcpStatus('err', '接口可达，认证失败', String(response.status));
      else if (!response.ok) setMcpStatus('err', '接口检测失败', String(response.status));
      else {
        const json = await response.json();
        if (!Array.isArray(json.data) && !Array.isArray(json)) throw new Error('无效模型列表');
        if (sequence === probeSequence && loadSettings().mcpEnabled) setMcpStatus('on', '模型接口可用', 'MCP 未接入');
      }
    } catch (error) {
      if (sequence === probeSequence && loadSettings().mcpEnabled) setMcpStatus('err', error.name === 'AbortError' ? '检测超时' : '接口检测失败');
    } finally { clearTimeout(timer); }
  }

  // 初始化时根据当前设置决定是否探测
  const initialSettings = loadSettings();
  if (initialSettings.mcpEnabled) tryConnectMcp();
  else setMcpStatus('off', '未连接');

  mcpSwitch?.addEventListener('click', () => {
    const next = !loadSettings().mcpEnabled;
    updateSettings((s) => { s.mcpEnabled = next; });
    if (next) tryConnectMcp();
    else { probeSequence++; probeController?.abort(); setMcpStatus('off', '未检测'); }
  });

  // ── 颜色选择弹层（font color） ────────────────────────────────────────────
  const COLOR_PRESETS = [
    '#4E6B80','#7FA8CC','#9DB4C4','#B8CFE0','#FDFEFF',
    '#5E4B8B','#8B4B6E','#4B7A5E','#7A6B4B','#4B5E7A',
  ];
  const colorMask    = document.getElementById('color-mask');
  const colorClose   = document.getElementById('color-sheet-close');
  const colorPresets = document.getElementById('color-presets');
  const colorPreview = document.getElementById('color-custom-preview');
  const colorInput   = document.getElementById('color-custom-input');
  const colorApply   = document.getElementById('color-sheet-apply');

  let pendingColor = loadSettings().theme?.fontColor || '#4E6B80';
  // 确保是 hex
  const legacyMap = { ink: '#4E6B80', gray: '#9DB4C4', white: '#FFFFFF' };
  if (!pendingColor.startsWith('#')) pendingColor = legacyMap[pendingColor] || '#4E6B80';

  // 生成预设色块
  if (colorPresets) {
    COLOR_PRESETS.forEach((hex) => {
      const swatch = document.createElement('button');
      swatch.className = 'color-swatch';
      swatch.style.background = hex;
      swatch.setAttribute('aria-label', hex);
      swatch.addEventListener('click', () => {
        pendingColor = hex;
        updateColorPreview(hex);
      });
      colorPresets.appendChild(swatch);
    });
  }

  function updateColorPreview(hex) {
    if (colorPreview) colorPreview.style.background = hex;
    if (colorInput)   colorInput.value = hex.replace('#', '');
    // 更新色块选中态
    colorPresets?.querySelectorAll('.color-swatch').forEach((sw) => {
      sw.classList.toggle('is-active', sw.style.background === hex || sw.style.background === hexToRgb(hex));
    });
  }

  function hexToRgb(hex) {
    // 浏览器设置 background 后读出来可能是 rgb() 格式
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgb(${r}, ${g}, ${b})`;
  }

  colorInput?.addEventListener('input', () => {
    const raw = colorInput.value.replace(/[^0-9a-fA-F]/g,'');
    if (raw.length === 6) {
      pendingColor = '#' + raw;
      if (colorPreview) colorPreview.style.background = pendingColor;
    }
  });

  colorApply?.addEventListener('click', () => {
    updateSettings((s) => { s.theme.fontColor = pendingColor; });
    // 同步美化页预览（若存在）
    const fp = document.getElementById('font-color-preview');
    if (fp) fp.style.background = pendingColor;
    const pk = document.getElementById('font-color-picker');
    if (pk) pk.value = pendingColor;
    closeColorSheet();
  });

  function openColorSheet() {
    pendingColor = (() => {
      const c = loadSettings().theme?.fontColor || '#4E6B80';
      return c.startsWith('#') ? c : (legacyMap[c] || '#4E6B80');
    })();
    updateColorPreview(pendingColor);
    colorMask?.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeColorSheet() {
    colorMask?.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  colorClose?.addEventListener('click', closeColorSheet);
  colorMask?.addEventListener('click', (e) => { if (e.target === colorMask) closeColorSheet(); });

  // 美化页的字体颜色预览球点击 → 打开颜色弹层（theme.html 场景）
  document.getElementById('font-color-preview')?.addEventListener('click', (e) => {
    e.preventDefault(); // 阻止底层 input[type=color]
    openColorSheet();
  });

  // ── 模型 API 配置弹层 ────────────────────────────────────────────────────────
  const MODEL_PRESETS = {
    text: [
      { name: 'kimi-k2-0711-preview',      baseUrl: 'https://api.moonshot.cn/v1',              tag: 'Moonshot' },
      { name: 'gpt-4o',                    baseUrl: 'https://api.openai.com/v1',                tag: 'OpenAI' },
      { name: 'deepseek-chat',             baseUrl: 'https://api.deepseek.com/v1',              tag: 'DeepSeek' },
      { name: 'qwen3-235b-a22b',           baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tag: 'Alibaba' },
    ],
    voice: [
      { name: 'tts-1',                     baseUrl: 'https://api.openai.com/v1',                tag: 'OpenAI' },
      { name: 'cosyvoice-v2',              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tag: 'Alibaba' },
      { name: 'speech-01-turbo',           baseUrl: 'https://api.minimaxi.chat/v1',             tag: 'MiniMax' },
    ],
    image: [
      { name: 'flux.1-schnell',            baseUrl: 'https://api.bfl.ml/v1',                   tag: 'Black Forest' },
      { name: 'stable-diffusion-3-5-large',baseUrl: 'https://api.stability.ai/v2beta',         tag: 'Stability' },
      { name: 'wanx2.1-t2i-turbo',         baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', tag: 'Alibaba' },
    ],
  };

  const MODEL_TITLE = { text: 'Text Model', voice: 'Voice Model', image: 'Image Model' };
  const modelMask    = document.getElementById('model-mask');
  const modelTitle   = document.getElementById('model-sheet-title');
  const inputUrl     = document.getElementById('model-input-url');
  const inputKey     = document.getElementById('model-input-key');
  const inputName    = document.getElementById('model-input-name');
  const modelPresets = document.getElementById('model-sheet-presets');
  const modelSaveBtn = document.getElementById('model-sheet-save');
  const modelClose   = document.getElementById('model-sheet-close');
  const keyToggle    = document.getElementById('model-key-toggle');
  let activeModelKey = null;
  let listController = null;
  let listSequence = 0;
  let keyOrigin = '';
  inputUrl?.addEventListener('change', () => {
    try { const next = new URL(apiEndpoint(inputUrl.value)).origin; if (next !== keyOrigin && inputKey) inputKey.value = ''; keyOrigin = next; } catch { /* save validates */ }
  });

  keyToggle?.addEventListener('click', () => {
    if (!inputKey) return;
    const isHidden = inputKey.type === 'password';
    inputKey.type = isHidden ? 'text' : 'password';
    const icon = keyToggle.querySelector('i');
    if (icon) icon.className = isHidden ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  });

  function openModelSheet(key) {
    listController?.abort(); listSequence++;
    activeModelKey = key;
    const current = loadSettings().models[key];
    if (modelTitle) modelTitle.textContent = MODEL_TITLE[key] || 'Model';
    if (inputUrl) inputUrl.value = current.baseUrl || '';
    try { keyOrigin = new URL(apiEndpoint(current.baseUrl)).origin; } catch { keyOrigin = ''; }
    if (inputKey) { inputKey.value  = current.apiKey  || ''; inputKey.type = 'password'; }
    if (inputName)  inputName.value = current.name    || '';
    const icon = keyToggle?.querySelector('i');
    if (icon) icon.className = 'fa-regular fa-eye';
    if (modelPresets) {
      modelPresets.innerHTML = '';
      (MODEL_PRESETS[key] || []).forEach(({ name, baseUrl, tag }) => {
        const btn = document.createElement('button');
        btn.className = 'model-preset-btn';
        btn.innerHTML = `<span class="model-preset-btn__name">${escapeHtml(name)}</span><span class="model-preset-btn__tag">${escapeHtml(tag)}</span>`;
        btn.addEventListener('click', () => {
          if (inputUrl) {
            const next = new URL(baseUrl).origin;
            if (next !== keyOrigin && inputKey) inputKey.value = '';
            keyOrigin = next; inputUrl.value = baseUrl;
          }
          if (inputName) inputName.value = name;
          inputKey?.focus();
        });
        modelPresets.appendChild(btn);
      });
    }
    if (modelMask) { modelMask.classList.add('is-open'); document.body.style.overflow = 'hidden'; setTimeout(() => inputUrl?.focus(), 350); }
  }

  function closeModelSheet() {
    listController?.abort(); listSequence++;
    modelMask?.classList.remove('is-open'); document.body.style.overflow = ''; activeModelKey = null;
  }

  modelClose?.addEventListener('click', closeModelSheet);
  modelMask?.addEventListener('click', (e) => { if (e.target === modelMask) closeModelSheet(); });
  modelSaveBtn?.addEventListener('click', () => {
    if (!activeModelKey) return;
    const name = inputName?.value.trim(), baseUrl = inputUrl?.value.trim(), apiKey = inputKey?.value.trim();
    if (!name) { inputName?.focus(); return; }
    const savedKey = activeModelKey;
    try { apiEndpoint(baseUrl); } catch (error) { reportError(error); return; }
    updateSettings((s) => { s.models[savedKey] = { name, baseUrl, apiKey }; });
    closeModelSheet();
    // 保存后重新探测（只对 text model 有意义）
    if (savedKey === 'text' && loadSettings().mcpEnabled) tryConnectMcp();
  });

  // 拉取模型列表
  const fetchBtn  = document.getElementById('model-fetch-btn');
  const fetchText = document.getElementById('model-fetch-text');
  async function fetchModelList() {
    const url = inputUrl?.value.trim(); const key = inputKey?.value.trim();
    if (!url) { inputUrl?.focus(); if (fetchText) { fetchText.textContent = '请先填写接口地址'; setTimeout(() => { if (fetchText) fetchText.textContent = '拉取列表'; }, 2000); } return; }
    listController?.abort();
    const controller = new AbortController(); listController = controller;
    const sequence = ++listSequence;
    const timer = setTimeout(() => controller.abort(), 10000);
    if (fetchBtn) fetchBtn.disabled = true;
    if (fetchText) fetchText.textContent = '拉取中…';
    const icon = fetchBtn?.querySelector('i'); icon?.classList.add('spinning');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['Authorization'] = `Bearer ${key}`;
      const resp = await fetch(apiEndpoint(url, 'models'), { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`${resp.status}`);
      const json = await resp.json();
      if (sequence !== listSequence) return;
      const items = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
      if (!items.length) throw new Error('列表为空');
      if (modelPresets) {
        modelPresets.innerHTML = '';
        const filtered = items.filter((m) => { const id = String(m.id || '').toLowerCase(); return !id.includes('embedding')&&!id.includes('moderation')&&!id.includes('tts')&&!id.includes('whisper')&&!id.includes('dall-e'); });
        (filtered.length ? filtered : items).forEach((m) => {
          const id = m.id || String(m);
          const btn = document.createElement('button'); btn.className = 'model-preset-btn';
          btn.innerHTML = `<span class="model-preset-btn__name">${escapeHtml(id)}</span>`;
          btn.addEventListener('click', () => { if (inputName) inputName.value = id; });
          modelPresets.appendChild(btn);
        });
      }
      if (fetchText) fetchText.textContent = `${items.length} 个模型`;
    } catch (err) {
      if (fetchText && sequence === listSequence) { fetchText.textContent = `失败: ${err.message}`; setTimeout(() => { if (fetchText) fetchText.textContent = '重试'; }, 2500); }
    } finally { clearTimeout(timer); icon?.classList.remove('spinning'); if (fetchBtn) fetchBtn.disabled = false; }
  }
  fetchBtn?.addEventListener('click', fetchModelList);
  document.getElementById('row-text-model')?.addEventListener('click',  () => openModelSheet('text'));
  document.getElementById('row-voice-model')?.addEventListener('click', () => openModelSheet('voice'));
  document.getElementById('row-image-model')?.addEventListener('click', () => openModelSheet('image'));
}

// ─── Memory 页 ───────────────────────────────────────────────────────────────

function buildMemoryCard(mem) {
  const article = document.createElement('article');
  article.className = 'mem-card glass';
  article.dataset.memId = String(mem.id);

  // 来源标签：区分 source
  const sourceLabel = mem.source === 'system' ? 'Echo 记的' : '我记的';
  const tagsText = mem.tags.length ? mem.tags.map((t) => `#${t}`).join('  ') : '';
  const dateText = formatMemoryDate(mem.createdAt);

  article.innerHTML = `
    <p class="mem-card__meta">${sourceLabel} · ${dateText}</p>
    <p class="mem-card__text">${escapeHtml(mem.content)}</p>
    <div class="mem-card__foot">
      <div class="mem-card__tags">${tagsText ? escapeHtml(tagsText) : ''}</div>
      <button class="mem-card__more" data-action="delete" aria-label="删除记忆">
        删除<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
    </div>
  `;

  article.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!window.confirm('删除这条记忆？')) return;
    await deleteMemory(mem.id);

  });

  return article;
}

function renderMemoryEmpty(container) {
  const empty = document.createElement('p');
  empty.id = 'memory-empty';
  empty.style.cssText = 'text-align:center;color:var(--brand-muted);font-size:13px;padding:32px 0;';
  empty.textContent = '还没有记忆，对话中有意义的内容会自动提取，也可输入「记住：…」手动记录';
  container.appendChild(empty);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function initMemoryPage() {
  if (page !== 'memory.html') return;

  const container = document.getElementById('memory-main');
  const searchInput = document.getElementById('search-memory-input');
  const filterChips = document.querySelectorAll('#memory-filter .filter-chip');
  if (!container) return;

  // 移除静态 mock 卡片（保留搜索栏和筛选行）
  container.querySelectorAll('.mem-card').forEach((el) => el.remove());

  let activeTag = '';  // '' | 'promise' | 'event' | 'hobby'
  let activeQuery = '';

  function render() {
    // 清除上次动态卡片和空态
    container.querySelectorAll('.mem-card, #memory-empty').forEach((el) => el.remove());
    const list = filterMemories(activeQuery, activeTag);
    if (list.length === 0) {
      renderMemoryEmpty(container);
    } else {
      const fragment = document.createDocumentFragment();
      list.forEach((mem) => fragment.appendChild(buildMemoryCard(mem)));
      container.appendChild(fragment);
    }
  }

  // 搜索
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      activeQuery = searchInput.value;
      render();
    });
  }

  // chip 筛选
  const TAG_KEY_MAP = {
    'filter-all':     '',
    'filter-promise': 'promise',
    'filter-event':   'event',
    'filter-hobby':   'hobby',
  };
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('filter-chip--active'));
      chip.classList.add('filter-chip--active');
      activeTag = TAG_KEY_MAP[chip.id] ?? '';
      render();
    });
  });

  // 监听聊天室写入（同一标签页内通过 CustomEvent 通知）
  subscribeToMemories(render);

  render();
}

// ─── My Profile 页 ───────────────────────────────────────────────────────────

function initProfilePage() {
  if (page !== 'my-profile.html') return;

  const nicknameEl = document.getElementById('input-nickname');
  const idEl       = document.getElementById('input-id');
  const bioEl      = document.getElementById('input-bio');
  const saveBtn    = document.getElementById('btn-save');
  if (!saveBtn) return;

  const profile = loadProfile();
  if (nicknameEl) nicknameEl.value = profile.nickname;
  if (idEl)       idEl.value       = profile.id;
  if (bioEl)      bioEl.value      = profile.bio;

  saveBtn.addEventListener('click', async () => {
    const next = {
      nickname:   nicknameEl?.value.trim() || profile.nickname,
      id:         idEl?.value.trim()       || profile.id,
      bio:        bioEl?.value.trim()      || profile.bio,
      avatarData: profile.avatarData,
    };
    await updateProfile(next);

    // 按钮短暂变为"已保存"反馈
    const orig = saveBtn.textContent;
    saveBtn.textContent = '已保存 ✓';
    saveBtn.disabled = true;
    setTimeout(() => {
      saveBtn.textContent = orig;
      saveBtn.disabled = false;
    }, 1500);
  });
}

// ─── Chat Create 页 ──────────────────────────────────────────────────────────

function initChatCreatePage() {
  if (page !== 'chat-create.html') return;

  const segSingle = document.getElementById('seg-single');
  const segGroup  = document.getElementById('seg-group');
  const submitBtn = document.getElementById('btn-create-submit');
  const singleMode= document.getElementById('single-mode');
  const groupMode = document.getElementById('group-mode');
  const createForm= document.getElementById('create-form');

  // 单人模式字段
  const nameInput    = document.getElementById('input-name');
  const aliasInput   = document.getElementById('input-alias');
  const personaInput = document.getElementById('input-persona');
  const avatarFile   = document.getElementById('single-avatar-file');
  const avatarBtn    = document.getElementById('btn-avatar-upload');

  // 群聊模式字段
  const groupNameInput  = document.getElementById('input-group-name');
  const charSelectList  = document.getElementById('char-select-list');
  const groupPreview    = document.getElementById('group-avatar-preview');
  const groupCountHint  = document.getElementById('group-select-count');

  let isGroupMode   = false;
  let pendingAvatar = null;       // 单人头像
  let selectedIds   = new Set();  // 群聊已选角色 id

  // ── 模式切换 ────────────────────────────────────────────────────────────────
  function setMode(isGroup) {
    isGroupMode = isGroup;
    segSingle?.classList.toggle('seg__item--active', !isGroup);
    segGroup?.classList.toggle('seg__item--active', isGroup);
    if (singleMode) singleMode.style.display = isGroup ? 'none' : '';
    if (createForm) createForm.style.display  = isGroup ? 'none' : '';
    if (groupMode)  groupMode.style.display   = isGroup ? 'flex' : 'none';
    if (submitBtn) submitBtn.disabled = isGroup && selectedIds.size < 2;
    submitBtn && (submitBtn.textContent = isGroup ? '创建群聊' : '创建');
    if (isGroup) {
      buildCharList();
      updateGroupPreview();
    }
  }

  segSingle?.addEventListener('click', () => setMode(false));
  segGroup?.addEventListener('click',  () => setMode(true));

  // ── 单人头像上传 ────────────────────────────────────────────────────────────
  avatarBtn?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', async () => {
    const file = avatarFile.files?.[0]; if (!file) return;
    const data = await resizeImage(file, 160);
    if (!data) return;
    pendingAvatar = data;
    if (avatarBtn) {
      avatarBtn.innerHTML = `<img src="${safeImage(pendingAvatar)}" alt="头像"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    }
    avatarFile.value = '';
  });

  // ── 群聊：读取单人角色列表并渲染 ────────────────────────────────────────────
  function getAvailableChars() {
    try {
      const st = loadChatState();
      return (st.conversations || []).filter((c) => c.avatar !== 'group');
    } catch { return []; }
  }

  function buildCharList() {
    if (!charSelectList) return;
    charSelectList.innerHTML = '';
    const chars = getAvailableChars();
    if (!chars.length) {
      charSelectList.innerHTML = '<p style="padding:20px;text-align:center;color:var(--brand-muted);font-size:13px">还没有单人角色，请先创建</p>';
      return;
    }
    chars.forEach((conv) => {
      const btn = document.createElement('button');
      btn.className = `char-select-item${selectedIds.has(conv.id) ? ' char-select-item--checked' : ''}`;
      btn.dataset.charId = conv.id;
      btn.type = 'button';

      const avatarEl = document.createElement('div');
      avatarEl.className = 'char-select-item__avatar';
      if (conv.avatarData) {
        avatarEl.innerHTML = `<img src="${safeImage(conv.avatarData)}" alt="${escapeHtml(conv.name)}">`;
      } else {
        avatarEl.textContent = conv.initial || conv.name.charAt(0).toUpperCase();
      }

      const body = document.createElement('div');
      body.className = 'char-select-item__body';
      body.innerHTML = `<div class="char-select-item__name">${escapeHtml(conv.name)}</div>
        ${conv.alias ? `<div class="char-select-item__desc">${escapeHtml(conv.alias)}</div>` : ''}`;

      const check = document.createElement('div');
      check.className = 'char-select-item__check';

      btn.append(avatarEl, body, check);
      btn.addEventListener('click', () => toggleChar(conv.id));
      charSelectList.appendChild(btn);
    });
  }

  function toggleChar(id) {
    if (selectedIds.has(id)) { selectedIds.delete(id); }
    else { selectedIds.add(id); }
    // 更新列表行选中态
    charSelectList?.querySelectorAll('.char-select-item').forEach((item) => {
      item.classList.toggle('char-select-item--checked', selectedIds.has(item.dataset.charId));
    });
    updateGroupPreview();
  }

  function updateGroupPreview() {
    const count = selectedIds.size;
    if (groupCountHint) {
      groupCountHint.textContent = count < 2
        ? `再选 ${2 - count} 个角色才能创建`
        : `已选 ${count} 个角色`;
    }
    if (submitBtn) submitBtn.disabled = count < 2;

    if (!groupPreview) return;
    if (count === 0) {
      groupPreview.className = 'group-avatar-preview is-empty';
      groupPreview.innerHTML = '<i class="fa-solid fa-user-group"></i>';
      return;
    }
    // 拼合最多4个角色首字
    const chars = getAvailableChars().filter((c) => selectedIds.has(c.id)).slice(0, 4);
    groupPreview.className = 'group-avatar-preview';
    groupPreview.innerHTML = chars.map((c) => `
      <div class="group-avatar-preview__cell">
        ${c.avatarData
          ? `<img src="${safeImage(c.avatarData)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
          : escapeHtml(c.initial || c.name.charAt(0).toUpperCase())}
      </div>`).join('');
  }

  // ── 提交 ────────────────────────────────────────────────────────────────────
  if (!submitBtn) return;
  submitBtn.disabled = false;

  submitBtn.addEventListener('click', async () => {
    try {
      let input;
      if (isGroupMode) {
        const chars = getAvailableChars().filter(c => selectedIds.has(c.id));
        if (chars.length < 2) return;
        input = { name: groupNameInput?.value.trim() || chars.map(c => c.name).join('、'), avatar: 'group', status: `${chars.length} 人`, members: chars.map(c => c.id) };
      } else {
        const name = nameInput?.value.trim();
        if (!name) { nameInput?.focus(); return; }
        input = { name, avatar: 'peer', alias: aliasInput?.value.trim() || '', persona: personaInput?.value.trim() || '', avatarData: pendingAvatar || '' };
      }
      const created = await createConversation(input);
      window.location.href = chatRoomHref(created.id, 'list', 'home');
    } catch (error) { reportError(error); }
  });
}

// ─── Home 页 ────────────────────────────────────────────────────────────────

function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 9)  return '早上好，今天也一起加油';
  if (hour >= 9 && hour < 12) return '上午好，有什么想聊的？';
  if (hour >= 12 && hour < 14) return '午安，记得吃饭';
  if (hour >= 14 && hour < 18) return '下午好，今天也在等你';
  if (hour >= 18 && hour < 22) return '晚上好，今天怎么样';
  return '夜深了，还没睡呀';
}

function initHomePage() {
  if (page !== 'home.html') return;

  // 动态问候语
  const greetEl = document.querySelector('.home-head__greeting');
  if (greetEl) greetEl.textContent = getGreeting();

  // 应用已保存的自定义图标
  const ICON_IDS = ['btn-music','btn-diary','btn-invite','btn-trip','btn-pet','btn-home-feature'];
  ICON_IDS.forEach((id) => {
    const img = loadThemeAsset(`icon.${id}`);
    if (!img) return;
    const chip = document.querySelector(`#${id} .feature-card__chip`);
    if (chip) chip.innerHTML = `<img src="${safeImage(img)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:var(--icon-chip-radius)">`;
  });

  // 功能卡片路由表：id → href
  // chat 卡片从主页进入走 list 模式（有返回键）
  const cardRoutes = {
    'btn-diary':        'chat-list.html?from=home',
    'btn-invite':       'chat-list.html?from=home',
    'btn-trip':         'chat-list.html?from=home',
    'btn-pet':          'chat-list.html?from=home',
    'btn-home-feature': 'couple-space.html',
    'btn-music':        'other.html',
  };

  Object.entries(cardRoutes).forEach(([id, href]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { window.location.href = href; });
  });
}

// ─── Chat-List 页：我的资料卡 + 底部弹层 ────────────────────────────────────

function applyAvatarToEl(el, profile) {
  if (profile.avatarData) {
    el.innerHTML = `<img src="${safeImage(profile.avatarData)}" alt="头像">`;
  } else {
    const initial = (profile.nickname || '我').charAt(0);
    el.innerHTML = `<span>${escapeHtml(initial)}</span>`;
  }
}

function initChatListProfileSheet() {
  if (page !== 'chat-list.html') return;

  const cardBtn    = document.getElementById('btn-my-profile');
  const cardAvatar = document.getElementById('profile-card-avatar');
  const cardName   = document.getElementById('profile-card-name');
  const cardId     = document.getElementById('profile-card-id');
  const mask       = document.getElementById('profile-sheet-mask');
  const avatarBtn  = document.getElementById('sheet-avatar-btn');
  const avatarFile = document.getElementById('sheet-avatar-file');
  const inputNick  = document.getElementById('sheet-input-nickname');
  const inputId    = document.getElementById('sheet-input-id');
  const inputBio   = document.getElementById('sheet-input-bio');
  const saveBtn    = document.getElementById('sheet-save-btn');

  // 朋友圈封面上传区（替换原色板区域）
  const swatchArea = document.getElementById('sheet-cover-swatches');
  if (swatchArea) {
    // 把色板区改造成图片上传按钮
    swatchArea.innerHTML = '';
    const coverBtn = document.createElement('button');
    coverBtn.id = 'sheet-cover-upload-btn';
    coverBtn.style.cssText = `
      display:flex;align-items:center;gap:6px;
      padding:6px 14px;border-radius:14px;
      background:rgba(156,196,228,0.18);border:1px solid rgba(156,196,228,0.4);
      font-size:12.5px;color:var(--brand-ink);cursor:pointer;
    `;
    coverBtn.innerHTML = '<i class="fa-solid fa-image" style="color:var(--icon-tint)"></i>上传封面图片';
    const coverFile = document.createElement('input');
    coverFile.type = 'file'; coverFile.accept = 'image/*';
    coverFile.id = 'sheet-cover-file'; coverFile.style.display = 'none';
    const coverPreview = document.createElement('span');
    coverPreview.id = 'sheet-cover-preview';
    coverPreview.style.cssText = 'font-size:11.5px;color:var(--brand-muted);';
    swatchArea.append(coverBtn, coverFile, coverPreview);
  }

  if (!mask || !cardBtn) return;

  let pendingAvatarData = null;
  let pendingCoverImage = null;

  function loadAndFill() {
    const profile = loadProfile();
    if (cardAvatar) applyAvatarToEl(cardAvatar, profile);
    if (cardName)   cardName.textContent = profile.nickname;
    if (cardId)     cardId.textContent   = profile.id;
    if (inputNick)  inputNick.value = profile.nickname;
    if (inputId)    inputId.value   = profile.id;
    if (inputBio)   inputBio.value  = profile.bio;
    if (avatarBtn)  applyAvatarToEl(avatarBtn, { ...profile, avatarData: pendingAvatarData ?? profile.avatarData });
    if (avatarBtn && !avatarBtn.querySelector('.profile-sheet__avatar-badge')) {
      const badge = document.createElement('span');
      badge.className = 'profile-sheet__avatar-badge'; badge.setAttribute('aria-hidden','true');
      badge.innerHTML = '<i class="fa-solid fa-camera"></i>';
      avatarBtn.appendChild(badge);
    }
    const preview = document.getElementById('sheet-cover-preview');
    if (preview) {
      const hasImg = pendingCoverImage ?? profile.coverImage;
      preview.textContent = hasImg ? '已选择图片 ✓' : (profile.coverImage ? '当前已有封面' : '');
    }
  }

  loadAndFill();

  function openSheet() {
    pendingAvatarData = null; pendingCoverImage = null;
    loadAndFill();
    mask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    inputNick?.focus();
  }
  function closeSheet() {
    mask.classList.remove('is-open');
    document.body.style.overflow = '';
    pendingAvatarData = null; pendingCoverImage = null;
  }

  cardBtn.addEventListener('click', openSheet);
  mask.addEventListener('click', (e) => { if (e.target === mask) closeSheet(); });

  // 头像上传
  avatarBtn?.addEventListener('click', () => avatarFile?.click());
  avatarFile?.addEventListener('change', async () => {
    const file = avatarFile.files?.[0]; if (!file) return;
    pendingAvatarData = await resizeImage(file, 160);
    if (!pendingAvatarData) return;
    if (avatarBtn) avatarBtn.innerHTML = `<img src="${safeImage(pendingAvatarData)}" alt="头像">
      <span class="profile-sheet__avatar-badge" aria-hidden="true"><i class="fa-solid fa-camera"></i></span>`;
    avatarFile.value = '';
  });

  // 封面图片上传
  document.getElementById('sheet-cover-upload-btn')?.addEventListener('click', () => {
    document.getElementById('sheet-cover-file')?.click();
  });
  document.getElementById('sheet-cover-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    pendingCoverImage = await resizeImage(file, 1200, 0.85);
    const preview = document.getElementById('sheet-cover-preview');
    if (preview) preview.textContent = '已选择图片 ✓';
    e.target.value = '';
  });

  // 保存
  saveBtn?.addEventListener('click', async () => {
    const current = loadProfile();
    const next = {
      nickname:    inputNick?.value.trim()  || current.nickname,
      id:          inputId?.value.trim()    || current.id,
      bio:         inputBio?.value.trim()   || current.bio,
      avatarData:  pendingAvatarData  !== null ? pendingAvatarData  : current.avatarData,
      coverImage:  pendingCoverImage  !== null ? pendingCoverImage  : current.coverImage,
    };
    await updateProfile(next);
    loadAndFill();
    const orig = saveBtn.textContent;
    saveBtn.textContent = '已保存 ✓'; saveBtn.disabled = true;
    setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; closeSheet(); }, 900);
  });
}

// ─── 角色主页（chat-settings.html）────────────────────────────────────────
function initCharProfilePage() {
  if (page !== 'chat-settings.html') return;

  const route       = parseChatRoute();
  const state       = loadChatState();
  const conv        = getConversation(route.conversationId, state);
  if (!conv) { window.location.replace(chatListHref(route.source)); return; }
  const isGroup     = conv.avatar === 'group';

  // ── 切换单人 / 群聊 UI ─────────────────────────────────────────────────
  const singleSection = document.getElementById('single-char-section');
  const groupSection  = document.getElementById('group-chat-section');
  const deleteBtn     = document.getElementById('btn-delete-char');
  const subnavTitle   = document.getElementById('subnav-title');

  if (subnavTitle) subnavTitle.textContent = conv.name;

  if (isGroup) {
    if (singleSection) singleSection.style.display = 'none';
    if (groupSection)  groupSection.style.display  = 'flex';
    if (deleteBtn)     deleteBtn.textContent        = '解散群聊';

    // ── 群聊设置 UI ──────────────────────────────────────────────────────
    const groupHeroName  = document.getElementById('group-hero-name');
    const groupHeroCount = document.getElementById('group-hero-count');
    const groupInputName = document.getElementById('group-input-name');
    const membersList    = document.getElementById('group-members-list');
    const saveGroupBtn   = document.getElementById('btn-save-group');

    function fillGroup() {
      const s  = loadChatState();
      const c  = s.conversations.find((x) => x.id === conv.id) || conv;
      const members = (c.members || [])
        .map((mid) => s.conversations.find((x) => x.id === mid))
        .filter(Boolean);

      if (groupHeroName)  groupHeroName.textContent  = c.name;
      if (groupHeroCount) groupHeroCount.textContent = `${members.length} 位成员`;
      if (groupInputName) groupInputName.value       = c.name;

      // 渲染成员列表
      if (membersList) {
        membersList.innerHTML = '';
        if (!members.length) {
          membersList.innerHTML = '<div style="padding:16px;font-size:13px;color:var(--brand-muted);text-align:center">暂无成员</div>';
        } else {
          members.forEach((m, i) => {
            const row = document.createElement('div');
            row.className = 'edit-row';
            if (i > 0) row.style.borderTop = '1px solid var(--divider)';

            // 头像
            const av = document.createElement('div');
            av.style.cssText = 'width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;border:1.5px solid rgba(255,255,255,0.8);overflow:hidden;';
            av.style.background = `linear-gradient(135deg,var(--avatar-a-start),var(--avatar-a-end))`;
            if (m.avatarData) {
              av.innerHTML = `<img src="${safeImage(m.avatarData)}" style="width:100%;height:100%;object-fit:cover;">`;
            } else {
              av.textContent = m.initial || m.name.charAt(0).toUpperCase();
            }

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'flex:1;font-size:13.5px;color:var(--brand-ink);';
            nameSpan.textContent = m.name;

            const aliasSpan = document.createElement('span');
            aliasSpan.style.cssText = 'font-size:12px;color:var(--brand-muted);';
            aliasSpan.textContent = m.alias || m.status || '在线';

            row.append(av, nameSpan, aliasSpan);
            membersList.appendChild(row);
          });
        }
      }
    }
    fillGroup();

    // 保存群名
    saveGroupBtn?.addEventListener('click', async () => {
      const newName = groupInputName?.value.trim();
      if (!newName) return;
      await updateConversation(conv.id, { name: newName });
      fillGroup();
      if (subnavTitle) subnavTitle.textContent = groupInputName?.value.trim() || conv.name;
      const orig = saveGroupBtn.textContent;
      saveGroupBtn.textContent = '已保存 ✓'; saveGroupBtn.disabled = true;
      setTimeout(() => { saveGroupBtn.textContent = orig; saveGroupBtn.disabled = false; }, 1200);
    });

  } else {
    // ── 单人角色 UI（保持原逻辑）──────────────────────────────────────────
    if (singleSection) singleSection.style.display = '';
    if (groupSection)  groupSection.style.display  = 'none';

    const nameEl      = document.getElementById('char-name');
    const aliasEl     = document.getElementById('char-alias');
    const avatarBtn   = document.getElementById('char-avatar-btn');
    const avatarFile  = document.getElementById('char-avatar-file');
    const avatarInit  = document.getElementById('char-avatar-initial');
    const inputName   = document.getElementById('char-input-name');
    const inputAlias  = document.getElementById('char-input-alias');
    const inputPersona= document.getElementById('char-input-persona');
    const saveBtn     = document.getElementById('btn-save-char');

    function fill() {
      const s = loadChatState();
      const c = getConversation(route.conversationId, s);
      if (subnavTitle) subnavTitle.textContent = c.name;
      if (nameEl)      nameEl.textContent      = c.name;
      if (aliasEl)     aliasEl.textContent     = c.alias || c.name;
      if (inputName)   inputName.value         = c.name;
      if (inputAlias)  inputAlias.value        = c.alias  || '';
      if (inputPersona) inputPersona.value     = c.persona || '';
      if (avatarBtn) {
        if (c.avatarData) {
          avatarBtn.innerHTML = `<img src="${safeImage(c.avatarData)}" alt="头像">
            <span class="char-hero__avatar-badge" aria-hidden="true"><i class="fa-solid fa-camera"></i></span>`;
        } else {
          if (avatarInit) avatarInit.textContent = c.initial || c.name.charAt(0).toUpperCase();
        }
      }
    }

    fill();
    let pendingAvatar     = null;
    let pendingBubble     = null;
    let pendingPeerBubble = undefined;

    avatarBtn?.addEventListener('click', () => avatarFile?.click());
    avatarFile?.addEventListener('change', async () => {
      const file = avatarFile.files?.[0]; if (!file) return;
      pendingAvatar = await resizeImage(file, 160);
      if (!pendingAvatar) return;
      if (avatarBtn) avatarBtn.innerHTML = `<img src="${safeImage(pendingAvatar)}" alt="头像">
        <span class="char-hero__avatar-badge" aria-hidden="true"><i class="fa-solid fa-camera"></i></span>`;
      avatarFile.value = '';
    });

    saveBtn?.addEventListener('click', async () => {
      const name    = inputName?.value.trim()    || conv.name;
      const alias   = inputAlias?.value.trim()   || '';
      const persona = inputPersona?.value.trim() || '';
      const patch = { name, alias, persona };
      if (pendingAvatar !== null) patch.avatarData = pendingAvatar;
      if (pendingBubble !== null) patch.bubbleColor = pendingBubble;
      if (pendingPeerBubble !== undefined) patch.peerBubbleColor = pendingPeerBubble;
      await updateConversation(conv.id, patch);
      fill();
      const orig = saveBtn.textContent;
      saveBtn.textContent = '已保存 ✓'; saveBtn.disabled = true;
      setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 1200);
    });

    // 世界书绑定弹层
    const worldMask   = document.getElementById('world-select-mask');
    const worldClose  = document.getElementById('world-select-close');
    const worldList   = document.getElementById('world-select-list');
    const valWorld    = document.getElementById('val-world');
    const bindWorldBtn= document.getElementById('btn-bind-world');

    function getWorldbooks() {
      const books = readJson('echo-world-v1', []);
      return Array.isArray(books) ? books : [];
    }
    function getCurrentWorldId() { return getConversation(conv.id)?.worldId || null; }
    function renderWorldList() {
      if (!worldList) return;
      const books  = getWorldbooks();
      const active = getCurrentWorldId();
      worldList.innerHTML = '';
      const noneBtn = document.createElement('button');
      noneBtn.className = 'world-option world-option--none';
      noneBtn.innerHTML = `
        <span class="world-option__chip"><i class="fa-solid fa-ban" aria-hidden="true"></i></span>
        <span class="world-option__body">
          <span class="world-option__name">不绑定</span>
          <span class="world-option__meta">纯角色对话，不注入世界观</span>
        </span>
        ${!active ? '<i class="fa-solid fa-check world-option__check" aria-hidden="true"></i>' : ''}`;
      noneBtn.addEventListener('click', () => bindWorld(null));
      worldList.appendChild(noneBtn);
      books.forEach((book) => {
        const btn = document.createElement('button');
        btn.className = 'world-option';
        btn.innerHTML = `
          <span class="world-option__chip"><i class="fa-solid fa-earth-asia" aria-hidden="true"></i></span>
          <span class="world-option__body">
            <span class="world-option__name">${escapeHtml(book.name)}</span>
            <span class="world-option__meta">${escapeHtml(book.meta)}</span>
          </span>
          ${active === book.id ? '<i class="fa-solid fa-check world-option__check" aria-hidden="true"></i>' : ''}`;
        btn.addEventListener('click', () => bindWorld(book.id, book.name));
        worldList.appendChild(btn);
      });
    }
    async function bindWorld(worldId, worldName) {
      await updateConversation(conv.id, { worldId, worldName: worldName || null });
      if (valWorld) valWorld.textContent = worldName || '未绑定';
      closeWorldSheet();
    }
    function openWorldSheet()  { if (!worldMask) return; renderWorldList(); worldMask.classList.add('is-open'); document.body.style.overflow = 'hidden'; }
    function closeWorldSheet() { if (!worldMask) return; worldMask.classList.remove('is-open'); document.body.style.overflow = ''; }
    bindWorldBtn?.addEventListener('click', openWorldSheet);
    worldClose?.addEventListener('click', closeWorldSheet);
    worldMask?.addEventListener('click', (e) => { if (e.target === worldMask) closeWorldSheet(); });
    (function initWorldDisplay() {
      try {
        const st = loadChatState();
        const c  = (st.conversations || []).find((c) => c.id === conv.id);
        if (valWorld) valWorld.textContent = c?.worldName || '未绑定';
      } catch { /* ignore */ }
    })();

    // 聊天样式弹层
    const styleMask  = document.getElementById('style-sheet-mask');
    const styleClose = document.getElementById('style-sheet-close');
    const styleBtn   = document.getElementById('btn-chat-style');
    const BUBBLE_MAP = {
      'bubble-blue':  'rgba(156,196,228,0.35)',
      'bubble-cyan':  'rgba(168,216,216,0.40)',
      'bubble-ivory': 'rgba(237,230,216,0.40)',
      'bubble-lilac': 'rgba(197,190,220,0.40)',
      'bubble-rose':  'rgba(227,198,204,0.40)',
    };
    const PEER_BUBBLE_MAP = {
      'peer-bubble-default':  null,
      'peer-bubble-blue':     'rgba(156,196,228,0.35)',
      'peer-bubble-green':    'rgba(168,216,190,0.45)',
      'peer-bubble-sand':     'rgba(220,210,195,0.50)',
      'peer-bubble-lavender': 'rgba(197,190,220,0.40)',
    };
    // pendingBubble / pendingPeerBubble 已在上方声明，此处不再重复 let
    function applyBubbleActive(color) {
      const target = Object.entries(BUBBLE_MAP).find(([, v]) => v === color);
      document.querySelectorAll('.bubble-dot').forEach((dot) => {
        const isActive = target ? dot.id === target[0] : dot.id === 'bubble-blue';
        dot.classList.toggle('bubble-dot--active', isActive);
        dot.setAttribute('aria-checked', String(isActive));
      });
    }
    function applyPeerBubbleActive(color) {
      document.querySelectorAll('.peer-bubble-dot').forEach((dot) => {
        const dotColor = PEER_BUBBLE_MAP[dot.id];
        const isActive = color === null ? dot.id === 'peer-bubble-default' : dotColor === color;
        dot.classList.toggle('peer-bubble-dot--active', isActive);
        dot.setAttribute('aria-checked', String(isActive));
        dot.style.outline   = isActive ? '2px solid var(--brand-blue-deep)' : '';
        dot.style.boxShadow = isActive ? '0 0 0 3px rgba(156,196,228,0.35)' : '';
      });
    }
    function openStyleSheet() {
      if (!styleMask) return;
      try {
        const st = loadChatState();
        const c  = (st.conversations || []).find((c) => c.id === conv.id);
        applyBubbleActive(c?.bubbleColor || null);
        applyPeerBubbleActive(c?.peerBubbleColor ?? null);
      } catch { applyBubbleActive(null); applyPeerBubbleActive(null); }
      pendingBubble = null; pendingPeerBubble = undefined;
      styleMask.classList.add('is-open');
      document.body.style.overflow = 'hidden';
    }
    async function closeStyleSheet() {
      if (!styleMask) return;
      if (pendingBubble !== null || pendingPeerBubble !== undefined) {
        const patch = {};
        if (pendingBubble !== null) patch.bubbleColor = pendingBubble;
        if (pendingPeerBubble !== undefined) patch.peerBubbleColor = pendingPeerBubble;
        await updateConversation(conv.id, patch);
        pendingBubble = null; pendingPeerBubble = undefined;
      }
      styleMask.classList.remove('is-open');
      document.body.style.overflow = '';
    }
    styleBtn?.addEventListener('click', openStyleSheet);
    styleClose?.addEventListener('click', closeStyleSheet);
    styleMask?.addEventListener('click', (e) => { if (e.target === styleMask) closeStyleSheet(); });
    document.querySelectorAll('.bubble-dot').forEach((dot) => {
      dot.addEventListener('click', () => { pendingBubble = BUBBLE_MAP[dot.id] || null; applyBubbleActive(pendingBubble); });
    });
    document.querySelectorAll('.peer-bubble-dot').forEach((dot) => {
      dot.addEventListener('click', () => { pendingPeerBubble = PEER_BUBBLE_MAP[dot.id] ?? null; applyPeerBubbleActive(pendingPeerBubble); });
    });
  } // end single-char branch

  // ── 删除角色 / 解散群聊（共用）────────────────────────────────────────
  const deleteBtn2         = document.getElementById('btn-delete-char');
  const deleteConfirmMask  = document.getElementById('delete-confirm-mask');
  const deleteConfirmTitle = document.getElementById('delete-confirm-title');
  const deleteConfirmCancel= document.getElementById('delete-confirm-cancel');
  const deleteConfirmOk    = document.getElementById('delete-confirm-ok');

  function openDeleteConfirm() {
    if (deleteConfirmTitle) deleteConfirmTitle.textContent = isGroup ? `解散「${conv.name}」` : `删除「${conv.name}」`;
    if (deleteConfirmMask)  deleteConfirmMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeDeleteConfirm() {
    if (deleteConfirmMask) deleteConfirmMask.classList.remove('is-open');
    document.body.style.overflow = '';
  }
  async function doDeleteChar() {
    closeDeleteConfirm();
    await deleteConversation(conv.id);
    window.location.href = 'chat-list.html';
  }
  deleteBtn2?.addEventListener('click', openDeleteConfirm);
  deleteConfirmCancel?.addEventListener('click', closeDeleteConfirm);
  deleteConfirmOk?.addEventListener('click', doDeleteChar);
  deleteConfirmMask?.addEventListener('click', (e) => { if (e.target === deleteConfirmMask) closeDeleteConfirm(); });
}

// ─── Moments 页：封面图片上传 + 头像/昵称同步 ────────────────────────────────

function initMomentsPage() {
  if (page !== 'moments.html') return;

  const coverImg  = document.getElementById('cover-img');
  const myAvatar  = document.getElementById('moments-my-avatar');
  const myInitial = document.getElementById('moments-my-initial');
  const postList  = document.getElementById('post-list');
  const composer  = document.getElementById('btn-composer');

  // ── Profile 同步 ──────────────────────────────────────────────────────────
  function applyCover(p) {
    if (coverImg && p.coverImage) {
      coverImg.src = safeImage(p.coverImage);
      coverImg.classList.add('is-loaded');
    } else if (coverImg) {
      coverImg.classList.remove('is-loaded');
    }
  }

  function applyMyAvatar(p) {
    if (!myAvatar) return;
    if (p.avatarData) {
      myAvatar.innerHTML = `<img src="${safeImage(p.avatarData)}" alt="${escapeHtml(p.nickname)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      if (myInitial) myInitial.textContent = (p.nickname || '我').charAt(0);
    }
  }

  function refreshProfile() {
    const p = loadProfile();
    applyCover(p);
    applyMyAvatar(p);
  }

  refreshProfile();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshProfile();
  });
  subscribeToProfile(refreshProfile);

  // ── 帖子渲染 ──────────────────────────────────────────────────────────────
  function buildAvatar(post) {
    const div = document.createElement('div');
    div.className = `avatar avatar--${post.authorType}`;

    // 「我」的帖子：优先用 profile 的最新头像和昵称首字
    if (post.authorType === 'mine') {
      const myProfile = loadProfile();
      if (myProfile.avatarData) {
        div.innerHTML = `<img src="${safeImage(myProfile.avatarData)}" alt="${escapeHtml(myProfile.nickname)}"
          style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      } else {
        const sp = document.createElement('span');
        sp.className = 'avatar__initial';
        sp.textContent = (myProfile.nickname || post.authorName || '我').charAt(0);
        div.appendChild(sp);
      }
      return div;
    }

    // 角色帖子：从 chat-state 查最新头像
    const chatAvatarData = (() => {
      try {
        const st = loadChatState();
        const conv = (st.conversations || []).find((c) => c.id === post.authorId || c.name === post.authorName);
        return conv?.avatarData || '';
      } catch { return ''; }
    })();

    const avatarSrc = post.authorAvatar || chatAvatarData;
    if (avatarSrc) {
      div.innerHTML = `<img src="${safeImage(avatarSrc)}" alt="${escapeHtml(post.authorName)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      const sp = document.createElement('span');
      sp.className = 'avatar__initial';
      sp.textContent = post.authorInitial;
      div.appendChild(sp);
    }
    return div;
  }

  function buildPostEl(post) {
    const article = document.createElement('article');
    article.className = 'post glass';
    article.dataset.postId = post.id;

    const avatar = buildAvatar(post);
    const body   = document.createElement('div');
    body.className = 'post__body';

    const head = document.createElement('div');
    head.className = 'post__head';
    // 「我」的帖子用 profile 的最新昵称；角色帖子用 chat-state 里的最新名字
    let displayName = post.authorName;
    if (post.authorType === 'mine') {
      displayName = loadProfile().nickname || post.authorName || '我';
    } else {
      try {
        const st = loadChatState();
        const conv = (st.conversations || []).find((c) => c.id === post.authorId || c.name === post.authorName);
        if (conv) displayName = conv.name;
      } catch { /* ignore */ }
    }
    head.innerHTML = `<span class="post__name">${escapeHtml(displayName)}</span>
      <span class="post__time">${escapeHtml(post.time)}</span>`;

    const text = document.createElement('p');
    text.className = 'post__text';
    text.textContent = post.text;

    body.append(head, text);

    // 图片网格（有内容时渲染）
    if (post.images.length) {
      const grid = document.createElement('div');
      grid.className = 'post__images';
      grid.setAttribute('aria-hidden', 'true');
      post.images.forEach((src) => {
        const img = document.createElement('div');
        img.className = 'post__img';
        if (safeImage(src)) img.style.backgroundImage = `url(${safeImage(src)})`;
        grid.appendChild(img);
      });
      body.appendChild(grid);
    }

    // 操作栏
    const foot = document.createElement('div');
    foot.className = 'post__foot';

    const likeBtn = document.createElement('button');
    likeBtn.className = `post__action${post.liked ? ' post__action--liked' : ''}`;
    likeBtn.setAttribute('aria-label', '喜欢');
    likeBtn.innerHTML = `<i class="fa-${post.liked ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i>`;
    if (post.likeCount > 0) {
      const count = document.createElement('span');
      count.style.cssText = 'font-size:11px;margin-left:3px;';
      count.textContent = post.likeCount;
      likeBtn.appendChild(count);
    }
    likeBtn.addEventListener('click', async () => {
      const updated = await toggleLike(post.id);
      if (!updated) return;
      likeBtn.className = `post__action${updated.liked ? ' post__action--liked' : ''}`;
      const icon = likeBtn.querySelector('i');
      if (icon) icon.className = `fa-${updated.liked ? 'solid' : 'regular'} fa-heart`;
      const countEl = likeBtn.querySelector('span');
      if (updated.likeCount > 0) {
        if (countEl) { countEl.textContent = updated.likeCount; }
        else {
          const c = document.createElement('span');
          c.style.cssText = 'font-size:11px;margin-left:3px;';
          c.textContent = updated.likeCount;
          likeBtn.appendChild(c);
        }
      } else if (countEl) {
        countEl.remove();
      }
    });

    const commentBtn = document.createElement('button');
    commentBtn.className = 'post__action';
    commentBtn.setAttribute('aria-label', '评论');
    commentBtn.innerHTML = '<i class="fa-regular fa-comment" aria-hidden="true"></i>';

    foot.append(likeBtn, commentBtn);
    body.appendChild(foot);
    article.append(avatar, body);
    return article;
  }

  function renderPosts(posts) {
    if (!postList) return;
    postList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    posts.forEach((post, i) => {
      fragment.appendChild(buildPostEl(post));
      if (i < posts.length - 1) {
        const gap = document.createElement('div');
        gap.style.height = '16px';
        fragment.appendChild(gap);
      }
    });
    postList.appendChild(fragment);
  }

  renderPosts(loadPosts());
  subscribeToPosts(renderPosts);

  // ── 发布弹层 ──────────────────────────────────────────────────────────────
  const composeMask    = document.getElementById('compose-mask');
  const composeClose   = document.getElementById('compose-close');
  const composeTA      = document.getElementById('compose-textarea');
  const composeSubmit  = document.getElementById('compose-submit');

  function openCompose() {
    if (!composeMask) return;
    if (composeTA) composeTA.value = '';
    composeMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    // 稍延迟聚焦，等动画完成
    setTimeout(() => composeTA?.focus(), 350);
  }
  function closeCompose() {
    if (!composeMask) return;
    composeMask.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  composer?.addEventListener('click', openCompose);
  composeClose?.addEventListener('click', closeCompose);
  composeMask?.addEventListener('click', (e) => {
    if (e.target === composeMask) closeCompose();
  });

  composeSubmit?.addEventListener('click', async () => {
    const text = composeTA?.value.trim();
    if (!text) return;
    await addPost(text);
    closeCompose();
    // subscribeToPosts 会自动触发 renderPosts
  });

  // 快捷键：Cmd/Ctrl+Enter 发布
  composeTA?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      composeSubmit?.click();
    }
  });
}

// ─── 档案页（archive.html）────────────────────────────────────────────────

// ─── 美化页（theme.html）─────────────────────────────────────────────────────

function initThemePage() {
  if (page !== 'theme.html') return;

  // ── 图标定义表（id → 显示名 + FA 默认图标类） ────────────────────────────
  const ICON_DEFS = [
    { id: 'btn-music',        name: '音乐',   fa: 'fa-solid fa-music' },
    { id: 'btn-diary',        name: '日记',   fa: 'fa-solid fa-book' },
    { id: 'btn-invite',       name: '邀约',   fa: 'fa-solid fa-calendar-check' },
    { id: 'btn-trip',         name: '行程',   fa: 'fa-solid fa-map' },
    { id: 'btn-pet',          name: '宠物',   fa: 'fa-solid fa-paw' },
    { id: 'btn-home-feature', name: '家园',   fa: 'fa-solid fa-house' },
  ];

  // ── 辅助：把主题值注入到当前页面 CSS 变量 ─────────────────────────────────
  function injectTokens(th) {
    const root = document.documentElement;
    const fsPx = 12 + (th.fontSize / 100) * 5;
    root.style.setProperty('--font-size-base', `${fsPx.toFixed(1)}px`);
    root.style.setProperty('--font-color-base', th.fontColor || '#4E6B80');
    const icPx = 30 + (th.iconSize / 100) * 16;
    root.style.setProperty('--icon-chip-size', `${Math.round(icPx)}px`);
    root.style.setProperty('--icon-chip-radius', th.iconShape === 'square' ? '10px' : '13px');
    root.style.setProperty('--icon-font-size', `${Math.round(icPx * 0.42)}px`);
  }

  // ── renderTheme: 同步所有控件状态 ────────────────────────────────────────
  function renderTheme(settings) {
    const th = settings.theme;

    // 滑杆
    const iconRange = document.getElementById('range-icon-size');
    const fontRange = document.getElementById('range-font-size');
    if (iconRange) {
      iconRange.value = th.iconSize;
      updateRangeTrack(iconRange);
      const lbl = document.getElementById('icon-size-label');
      if (lbl) lbl.textContent = th.iconSize < 34 ? '小' : th.iconSize < 67 ? '中' : '大';
    }
    if (fontRange) {
      fontRange.value = th.fontSize;
      updateRangeTrack(fontRange);
      const lbl = document.getElementById('font-size-label');
      if (lbl) lbl.textContent = th.fontSize < 34 ? '小' : th.fontSize < 67 ? '标准' : '大';
    }

    // 图标形状
    document.getElementById('shape-round')?.classList.toggle('seg__item--active', th.iconShape !== 'square');
    document.getElementById('shape-square')?.classList.toggle('seg__item--active', th.iconShape === 'square');

    // 字体颜色预览
    const preview = document.getElementById('font-color-preview');
    const picker  = document.getElementById('font-color-picker');
    const colorHex = th.fontColor || '#4E6B80';
    if (preview) preview.style.background = colorHex;
    if (picker)  picker.value = colorHex;

    injectTokens(th);
  }

  // ── 更新 range 轨道填充渐变（视觉反馈） ──────────────────────────────────
  function updateRangeTrack(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.backgroundImage = `linear-gradient(to right, #9CC4E4 0%, #9CC4E4 ${pct}%, #E2EDF5 ${pct}%, #E2EDF5 100%)`;
    input.style.backgroundSize = '100% 4px';
    input.style.backgroundRepeat = 'no-repeat';
    input.style.backgroundPosition = 'center';
  }

  renderTheme(loadSettings());
  subscribeToSettings(renderTheme);

  // ── 滑杆事件（原生 range，立即响应） ─────────────────────────────────────
  const iconRange = document.getElementById('range-icon-size');
  iconRange?.addEventListener('input', () => {
    const v = Number(iconRange.value);
    updateRangeTrack(iconRange);
    const lbl = document.getElementById('icon-size-label');
    if (lbl) lbl.textContent = v < 34 ? '小' : v < 67 ? '中' : '大';
    updateSettings((s) => { s.theme.iconSize = v; });
  });

  const fontRange = document.getElementById('range-font-size');
  fontRange?.addEventListener('input', () => {
    const v = Number(fontRange.value);
    updateRangeTrack(fontRange);
    const lbl = document.getElementById('font-size-label');
    if (lbl) lbl.textContent = v < 34 ? '小' : v < 67 ? '标准' : '大';
    updateSettings((s) => { s.theme.fontSize = v; });
  });

  // ── 图标形状切换 ──────────────────────────────────────────────────────────
  ['round', 'square'].forEach((shape) => {
    document.getElementById(`shape-${shape}`)?.addEventListener('click', () => {
      updateSettings((s) => { s.theme.iconShape = shape; });
    });
  });

  // ── 字体颜色预览球 → 打开颜色选择弹层 ──────────────────────────────────
  // 颜色弹层逻辑（与 settings.html 共用同一份实现，通过 initSettingsPage 中的 openColorSheet 挂载）
  // theme.html 只需要让预览球点击时调用 initSettingsPage 已经注册的处理器，
  // 但因为 initSettingsPage 在 theme.html 上不会运行（page !== 'settings.html'），
  // 所以在这里独立初始化颜色弹层。
  (function initColorSheet() {
    const COLOR_PRESETS_THEME = [
      '#4E6B80','#7FA8CC','#9DB4C4','#B8CFE0','#FDFEFF',
      '#5E4B8B','#8B4B6E','#4B7A5E','#7A6B4B','#4B5E7A',
    ];
    const cmask    = document.getElementById('color-mask');
    const cclose   = document.getElementById('color-sheet-close');
    const cpresets = document.getElementById('color-presets');
    const cpreview = document.getElementById('color-custom-preview');
    const cinput   = document.getElementById('color-custom-input');
    const capply   = document.getElementById('color-sheet-apply');
    if (!cmask) return;

    let pendCol = (() => {
      const c = loadSettings().theme?.fontColor || '#4E6B80';
      const lm = { ink:'#4E6B80', gray:'#9DB4C4', white:'#FFFFFF' };
      return c.startsWith('#') ? c : (lm[c] || '#4E6B80');
    })();

    if (cpresets) {
      COLOR_PRESETS_THEME.forEach((hex) => {
        const sw = document.createElement('button');
        sw.className = 'color-swatch'; sw.style.background = hex; sw.setAttribute('aria-label', hex);
        sw.addEventListener('click', () => { pendCol = hex; updateCP(hex); });
        cpresets.appendChild(sw);
      });
    }

    function updateCP(hex) {
      if (cpreview) cpreview.style.background = hex;
      if (cinput)   cinput.value = hex.replace('#','');
      cpresets?.querySelectorAll('.color-swatch').forEach((s) => {
        const bg = s.style.background;
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
        s.classList.toggle('is-active', bg === hex || bg === `rgb(${r}, ${g}, ${b})`);
      });
    }

    cinput?.addEventListener('input', () => {
      const raw = cinput.value.replace(/[^0-9a-fA-F]/g,'');
      if (raw.length === 6) { pendCol = '#'+raw; if (cpreview) cpreview.style.background = pendCol; }
    });

    capply?.addEventListener('click', () => {
      updateSettings((s) => { s.theme.fontColor = pendCol; });
      const fp = document.getElementById('font-color-preview');
      if (fp) fp.style.background = pendCol;
      cmask.classList.remove('is-open'); document.body.style.overflow = '';
    });

    cclose?.addEventListener('click', () => { cmask.classList.remove('is-open'); document.body.style.overflow = ''; });
    cmask.addEventListener('click', (e) => { if (e.target === cmask) { cmask.classList.remove('is-open'); document.body.style.overflow = ''; } });

    // 预览球点击
    document.getElementById('font-color-preview')?.addEventListener('click', () => {
      pendCol = (() => { const c = loadSettings().theme?.fontColor||'#4E6B80'; const lm={ink:'#4E6B80',gray:'#9DB4C4',white:'#FFFFFF'}; return c.startsWith('#') ? c : (lm[c]||'#4E6B80'); })();
      updateCP(pendCol);
      cmask.classList.add('is-open'); document.body.style.overflow = 'hidden';
    });
  })();

  // ── 自定义图标网格 ────────────────────────────────────────────────────────
  const iconGrid = document.getElementById('icon-grid');
  if (iconGrid) {
    ICON_DEFS.forEach(({ id, name, fa }) => {
      const slot = document.createElement('div');
      slot.className = 'icon-slot';

      const chip = document.createElement('div');
      chip.className = 'icon-slot__chip';
      chip.id = `icon-slot-${id}`;

      // 读已存图片
      const existing = loadThemeAsset(`icon.${id}`);
      if (existing) {
        chip.classList.add('has-img');
        chip.innerHTML = `<img src="${existing}" alt="${name}">`;
      } else {
        chip.innerHTML = `<i class="${fa}" aria-hidden="true"></i>`;
      }

      const label = document.createElement('span');
      label.className = 'icon-slot__name';
      label.textContent = name;

      // 隐藏文件输入
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';

      chip.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]; if (!file) return;
        const data = await resizeImage(file, 96, 0.85);
        if (!data) return;
        saveThemeAsset(`icon.${id}`, data);
        chip.classList.add('has-img');
        chip.innerHTML = `<img src="${data}" alt="${name}">`;
        fileInput.value = '';
        // 同步到 home.html 的卡片（如果当前页有的话）
        const homeChip = document.querySelector(`#${id} .feature-card__chip`);
        if (homeChip) homeChip.innerHTML = `<img src="${data}" alt="${name}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--icon-chip-radius)">`;
      });

      slot.append(chip, label, fileInput);
      iconGrid.appendChild(slot);
    });
  }

  // ── 自定义字体上传 ────────────────────────────────────────────────────────
  const fontUploadBtn    = document.getElementById('btn-font-upload');
  const fontFile         = document.getElementById('font-file');
  const fontUploadStatus = document.getElementById('font-upload-status');

  // 读取已存字体并注入
  const savedFont = loadThemeAsset('customFont');
  const savedFontName = localStorage.getItem('echo-theme-assets-v1.customFontName') || '';
  if (savedFont && savedFontName) {
    injectCustomFont(savedFont, savedFontName);
    if (fontUploadStatus) fontUploadStatus.textContent = savedFontName;
  }

  function injectCustomFont(base64, name) {
    document.getElementById('__custom_font_style__')?.remove();
    const style = document.createElement('style');
    style.id = '__custom_font_style__';
    style.textContent = `@font-face { font-family: "EchoCustomFont"; src: url("${base64}"); } body, .phone { font-family: "EchoCustomFont", var(--font-zh) !important; }`;
    document.head.appendChild(style);
  }

  fontUploadBtn?.addEventListener('click', () => fontFile?.click());
  fontFile?.addEventListener('change', async () => {
    const file = fontFile.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result;
      const name = file.name;
      saveThemeAsset('customFont', base64);
      localStorage.setItem('echo-theme-assets-v1.customFontName', name);
      injectCustomFont(base64, name);
      if (fontUploadStatus) fontUploadStatus.textContent = name;
    };
    reader.readAsDataURL(file);
    fontFile.value = '';
  });

  // ── 锁屏圆环头像 ────────────────────────────────────────────────────────────
  const lockAvatarBtn   = document.getElementById('btn-lock-avatar');
  const lockAvatarFile  = document.getElementById('lock-avatar-file');
  const lockAvatarInner = document.getElementById('lock-avatar-inner');
  const lockAvatarValue = document.getElementById('lock-avatar-value');

  function applyLockAvatar(src) {
    if (!lockAvatarInner) return;
    if (src) {
      lockAvatarInner.innerHTML = `<img src="${src}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      if (lockAvatarValue) lockAvatarValue.textContent = '已设置';
    } else {
      lockAvatarInner.innerHTML = '<i class="fa-solid fa-user" aria-hidden="true"></i>';
      if (lockAvatarValue) lockAvatarValue.textContent = '导入图片';
    }
  }
  // 从独立存储读取，不走 settings JSON
  applyLockAvatar(loadThemeAsset('lockAvatar'));

  lockAvatarBtn?.addEventListener('click', () => lockAvatarFile?.click());
  lockAvatarFile?.addEventListener('change', async () => {
    const file = lockAvatarFile.files?.[0]; if (!file) return;
    const data = await resizeImage(file, 256);
    if (!data) return;
    saveThemeAsset('lockAvatar', data);
    applyLockAvatar(data);
    lockAvatarFile.value = '';
  });

  // ── 锁屏壁纸 ─────────────────────────────────────────────────────────────
  const lockWallpaperBtn   = document.getElementById('btn-lock-wallpaper');
  const lockWallpaperFile  = document.getElementById('lock-wallpaper-file');
  const lockWallpaperThumb = document.getElementById('lock-wallpaper-thumb');
  const lockWallpaperValue = document.getElementById('lock-wallpaper-value');

  function applyLockWallpaperThumb(src) {
    if (!lockWallpaperThumb) return;
    if (src) {
      lockWallpaperThumb.style.backgroundImage = `url(${src})`;
      lockWallpaperThumb.style.backgroundSize  = 'cover';
      lockWallpaperThumb.style.backgroundPosition = 'center';
      if (lockWallpaperValue) lockWallpaperValue.textContent = '已设置';
    } else {
      lockWallpaperThumb.style.backgroundImage = '';
      if (lockWallpaperValue) lockWallpaperValue.textContent = '未设置';
    }
  }
  applyLockWallpaperThumb(loadThemeAsset('lockScreenWallpaper'));

  lockWallpaperBtn?.addEventListener('click', () => lockWallpaperFile?.click());
  lockWallpaperFile?.addEventListener('change', async () => {
    const file = lockWallpaperFile.files?.[0]; if (!file) return;
    const data = await resizeImage(file, 1200, 0.80);
    if (!data) return;
    saveThemeAsset('lockScreenWallpaper', data);
    applyLockWallpaperThumb(data);
    lockWallpaperFile.value = '';
  });

  // ── 壁纸 ────────────────────────────────────────────────────────────────────
  const wallpaperBtn   = document.getElementById('btn-wallpaper');
  const wallpaperFile  = document.getElementById('wallpaper-file');
  const wallpaperThumb = document.getElementById('wallpaper-thumb');

  function applyWallpaperThumb(src) {
    if (!wallpaperThumb) return;
    if (src) {
      wallpaperThumb.style.backgroundImage = `url(${src})`;
      wallpaperThumb.style.backgroundSize  = 'cover';
      wallpaperThumb.style.backgroundPosition = 'center';
    } else {
      wallpaperThumb.style.backgroundImage = '';
    }
  }
  applyWallpaperThumb(loadThemeAsset('wallpaper'));

  // 壁纸 value 状态文字
  const wallpaperValue = document.getElementById('wallpaper-value');
  if (wallpaperValue) {
    wallpaperValue.textContent = loadThemeAsset('wallpaper') ? '已设置' : '未设置';
  }

  wallpaperBtn?.addEventListener('click', () => wallpaperFile?.click());
  wallpaperFile?.addEventListener('change', async () => {
    const file = wallpaperFile.files?.[0]; if (!file) return;
    const data = await resizeImage(file, 1200, 0.80);
    if (!data) return;
    saveThemeAsset('wallpaper', data);
    applyWallpaperThumb(data);
    if (wallpaperValue) wallpaperValue.textContent = '已设置';
    // 实时预览：固定壁纸层
    document.getElementById('__wallpaper_layer__')?.remove();
    const phone = document.querySelector('.phone');
    if (phone) {
      const layer = document.createElement('div');
      layer.id = '__wallpaper_layer__';
      layer.style.cssText = [
        'position:fixed;inset:0;',
        `background:url(${data}) center top / cover no-repeat;`,
        'z-index:-1;pointer-events:none;',
      ].join('');
      phone.parentNode.insertBefore(layer, phone);
      phone.style.background = 'linear-gradient(135deg,rgba(253,254,255,0.72),rgba(240,247,252,0.72))';
    }
    wallpaperFile.value = '';
  });

  // ── 聊天背景（仅 chat-room.html 生效，其他页面透明） ────────────────────
  const chatBgBtn   = document.getElementById('btn-chat-bg');
  const chatBgFile  = document.getElementById('chat-bg-file');
  const chatBgThumb = document.getElementById('chat-bg-thumb');
  const chatBgValue = document.getElementById('chat-bg-value');

  function applyChatBgThumb(src) {
    if (!chatBgThumb) return;
    if (src) {
      chatBgThumb.style.backgroundImage = `url(${src})`;
      chatBgThumb.style.backgroundSize  = 'cover';
      chatBgThumb.style.backgroundPosition = 'center';
      if (chatBgValue) chatBgValue.textContent = '已设置';
    } else {
      chatBgThumb.style.backgroundImage = '';
      if (chatBgValue) chatBgValue.textContent = '未设置';
    }
  }
  applyChatBgThumb(loadThemeAsset('chatBg'));

  chatBgBtn?.addEventListener('click', () => chatBgFile?.click());
  chatBgFile?.addEventListener('change', async () => {
    const file = chatBgFile.files?.[0]; if (!file) return;
    const data = await resizeImage(file, 1200, 0.80);
    if (!data) return;
    saveThemeAsset('chatBg', data);
    applyChatBgThumb(data);
    chatBgFile.value = '';
  });

  // ── settings 变更后实时重注入 CSS 变量（图标形状/大小、字体）──────────────
  subscribeToSettings((s) => {
    const th = s.theme;
    const root = document.documentElement;
    const fsPx = 12 + (th.fontSize / 100) * 5;
    root.style.setProperty('--font-size-base', `${fsPx.toFixed(1)}px`);
    const legacyMap2 = { ink: '#4E6B80', gray: '#9DB4C4', white: '#FFFFFF' };
    const fc2 = (th.fontColor && th.fontColor.startsWith('#')) ? th.fontColor : (legacyMap2[th.fontColor] || '#4E6B80');
    root.style.setProperty('--font-color-base', fc2);
    const icPx = 30 + (th.iconSize / 100) * 16;
    root.style.setProperty('--icon-chip-size', `${Math.round(icPx)}px`);
    root.style.setProperty('--icon-chip-radius', th.iconShape === 'square' ? '10px' : '13px');
    root.style.setProperty('--icon-font-size', `${Math.round(icPx * 0.42)}px`);
  });
}

function initArchivePage() {
  if (page !== 'archive.html') return;

  const ME_ID       = '__me__';  // 虚拟 id，代表「我」的档案
  const charSwitch  = document.getElementById('char-switch');
  const btnEdit     = document.getElementById('btn-edit');

  const FIELD_MAP = {
    'field-name':             { key: 'name',         parent: 'conv' },
    'field-gender':           { key: 'gender',       parent: 'archive' },
    'field-age':              { key: 'age',           parent: 'archive' },
    'field-birthday':         { key: 'birthday',     parent: 'archive' },
    'field-appearance':       { key: 'appearance',   parent: 'archive' },
    'field-personality':      { key: 'personality',  parent: 'archive' },
    'field-hobbies':          { key: 'hobbies',      parent: 'archive' },
  };

  let activeId  = ME_ID;
  let isEditing = false;

  function getState() { return loadChatState(); }

  // ── 渲染切换条：「我」固定第一位，后跟单人角色 ──────────────────────────
  function renderSwitchBar(conversations) {
    if (!charSwitch) return;
    const addBtn = document.getElementById('btn-char-add');
    charSwitch.innerHTML = '';

    // 「我」芯片（不可删除）
    const meProfile = loadProfile();
    const meBtn = document.createElement('button');
    meBtn.className = `char-chip${activeId === ME_ID ? ' char-chip--active' : ' glass'}`;
    meBtn.dataset.charId = ME_ID;
    meBtn.type = 'button';

    const meAvSpan = document.createElement('span');
    meAvSpan.className = 'char-chip__avatar';
    if (meProfile.avatarData) {
      meAvSpan.innerHTML = `<img src="${safeImage(meProfile.avatarData)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      meAvSpan.textContent = (meProfile.nickname || '我').charAt(0);
    }
    meBtn.append(meAvSpan, document.createTextNode(meProfile.nickname || '我'));
    meBtn.addEventListener('click', () => switchChar(ME_ID));
    charSwitch.appendChild(meBtn);

    // 角色芯片（编辑模式下显示删除按钮）
    const singles = conversations.filter((c) => c.avatar !== 'group');
    singles.forEach((conv) => {
      const btn = document.createElement('button');
      btn.className = `char-chip${conv.id === activeId ? ' char-chip--active' : ' glass'}`;
      btn.dataset.charId = conv.id;
      btn.type = 'button';

      const avatarSpan = document.createElement('span');
      avatarSpan.className = 'char-chip__avatar char-chip__avatar--b';
      if (conv.avatarData) {
        avatarSpan.innerHTML = `<img src="${safeImage(conv.avatarData)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      } else {
        avatarSpan.textContent = conv.initial || conv.name.charAt(0).toUpperCase();
      }
      btn.append(avatarSpan, document.createTextNode(conv.name));
      btn.addEventListener('click', () => switchChar(conv.id));
      charSwitch.appendChild(btn);

      // 编辑模式下在 chip 旁边显示删除按钮
      const delBtn = document.createElement('button');
      delBtn.className = `btn-del-char${isEditing ? ' is-visible' : ''}`;
      delBtn.type = 'button';
      delBtn.title = `删除${conv.name}`;
      delBtn.innerHTML = '<i class="fa-solid fa-trash" style="font-size:11px"></i>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openArcDel(conv.id, conv.name);
      });
      charSwitch.appendChild(delBtn);
    });

    if (addBtn) charSwitch.appendChild(addBtn);
  }

  // ── 填充字段：「我」用 profile，角色用 conv.archive ──────────────────────
  function fillFields(convOrMe) {
    const isMe = convOrMe === ME_ID || (convOrMe && convOrMe.__isMe__);
    const profile = isMe ? loadProfile() : null;
    const conv    = isMe ? null : convOrMe;
    const arc     = isMe ? (profile.archive || {}) : (conv?.archive || {});

    const fields = [
      { id: 'field-name',        key: isMe ? 'nickname' : 'name',  parent: isMe ? 'top' : 'conv',    isLong: false },
      { id: 'field-gender',      key: 'gender',      parent: 'archive', isLong: false },
      { id: 'field-age',         key: 'age',          parent: 'archive', isLong: false },
      { id: 'field-birthday',    key: 'birthday',    parent: 'archive', isLong: false },
      { id: 'field-appearance',  key: 'appearance',  parent: 'archive', isLong: true  },
      { id: 'field-personality', key: 'personality', parent: 'archive', isLong: true  },
      { id: 'field-hobbies',     key: 'hobbies',     parent: 'archive', isLong: true  },
    ];

    fields.forEach(({ id, key, parent, isLong }) => {
      let value = '';
      if (parent === 'archive') {
        value = arc[key] || '';
      } else if (parent === 'top') {
        value = profile[key] || '';
      } else {
        value = conv?.[key] || '';
      }

      if (isEditing) {
        let inp = document.querySelector(`[data-field-id="${id}"]`);
        if (!inp) {
          const el = document.getElementById(id);
          if (!el) return;
          inp = document.createElement(isLong ? 'textarea' : 'input');
          inp.className = 'arc-edit-input';
          inp.style.cssText = [
            'flex:1;width:100%;border:none;outline:none;',
            'background:rgba(156,196,228,0.08);',
            `font-family:var(--font-zh);font-size:${isLong ? '13px' : '14px'};`,
            'color:var(--brand-ink);border-radius:8px;padding:4px 8px;',
            isLong ? 'resize:none;line-height:1.6;min-height:72px;' : '',
          ].join('');
          inp.dataset.fieldId = id;
          el.parentNode.replaceChild(inp, el);
        }
        inp.value = value; inp.dataset.originalValue = value;
      } else {
        const staleInp = document.querySelector(`[data-field-id="${id}"]`);
        if (staleInp) {
          const tag  = isLong ? 'p' : 'span';
          const span = document.createElement(tag);
          span.id        = id;
          span.className = isLong ? 'arc-text' : 'arc-row__value';
          span.textContent = value || (isLong ? '暂未填写' : '—');
          staleInp.parentNode.replaceChild(span, staleInp);
        } else {
          const el = document.getElementById(id);
          if (el) el.textContent = value || (isLong ? '暂未填写' : '—');
        }
      }
    });
  }

  function switchChar(id) {
    isEditing = false;
    if (btnEdit) btnEdit.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>编辑';
    activeId = id;
    const st = getState();
    renderSwitchBar(st?.conversations || []);
    if (id === ME_ID) {
      fillFields(ME_ID);
    } else {
      const conv = st?.conversations.find((c) => c.id === id);
      if (conv) fillFields(conv);
    }
  }

  // ── 保存编辑：区分「我」和角色 ──────────────────────────────────────────
  async function saveEdits() {
    const patch = {}, archive = {};
    document.querySelectorAll('[data-field-id]').forEach(input => {
      const value = input.value.trim();
      if (value === input.dataset.originalValue) return;
      const meta = FIELD_MAP[input.dataset.fieldId];
      if (!meta) return;
      if (meta.parent === 'conv') patch[activeId === ME_ID ? 'nickname' : meta.key] = value;
      else archive[meta.key] = value;
    });
    if (Object.keys(archive).length) patch.archive = archive;
    if (activeId === ME_ID) return await updateProfile(patch);
    return await updateConversation(activeId, patch);
  }

  function updateEditUI() {
    if (!btnEdit) return;
    btnEdit.innerHTML = isEditing
      ? '<i class="fa-solid fa-check" aria-hidden="true"></i>完成'
      : '<i class="fa-solid fa-pen"   aria-hidden="true"></i>编辑';
    const st = getState();
    if (activeId === ME_ID) {
      fillFields(ME_ID);
    } else {
      const conv = st?.conversations.find((c) => c.id === activeId);
      if (conv) fillFields(conv);
    }
  }

  // ── 初始化：默认显示「我」──────────────────────────────────────────────
  const st = getState();
  activeId = ME_ID;
  renderSwitchBar(st?.conversations || []);
  fillFields(ME_ID);

  btnEdit?.addEventListener('click', async () => {
    if (isEditing) { await saveEdits(); isEditing = false; }
    else { isEditing = true; }
    updateEditUI();
    const updated = getState();
    renderSwitchBar(updated?.conversations || []);
  });

  // ── 删除角色确认弹层 ──────────────────────────────────────────────────────
  const arcDelMask   = document.getElementById('arc-del-mask');
  const arcDelTitle  = document.getElementById('arc-del-title');
  const arcDelCancel = document.getElementById('arc-del-cancel');
  const arcDelOk     = document.getElementById('arc-del-ok');
  let pendingDelId   = null;

  function openArcDel(id, name) {
    pendingDelId = id;
    if (arcDelTitle) arcDelTitle.textContent = `删除「${name}」`;
    arcDelMask?.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }
  function closeArcDel() {
    arcDelMask?.classList.remove('is-open');
    document.body.style.overflow = '';
    pendingDelId = null;
  }
  async function doArcDel() {
    if (!pendingDelId) { closeArcDel(); return; }
    const id = pendingDelId;
    closeArcDel();
    await deleteConversation(id);
    // 切换到「我」或第一个可用角色
    activeId = ME_ID;
    isEditing = false;
    if (btnEdit) btnEdit.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i>编辑';
    const refreshed = getState();
    renderSwitchBar(refreshed?.conversations || []);
    fillFields(ME_ID);
  }

  arcDelCancel?.addEventListener('click', closeArcDel);
  arcDelOk?.addEventListener('click', doArcDel);
  arcDelMask?.addEventListener('click', (e) => { if (e.target === arcDelMask) closeArcDel(); });

  // ── 新建角色弹层 ──────────────────────────────────────────────────────────
  const newCharMask   = document.getElementById('new-char-mask');
  const newCharClose  = document.getElementById('new-char-close');
  const newCharName   = document.getElementById('new-char-name');
  const newCharPersona= document.getElementById('new-char-persona');
  const newCharSubmit = document.getElementById('new-char-submit');

  function openNewChar() {
    if (!newCharMask) return;
    if (newCharName)    newCharName.value    = '';
    if (newCharPersona) newCharPersona.value = '';
    newCharMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => newCharName?.focus(), 350);
  }
  function closeNewChar() {
    if (!newCharMask) return;
    newCharMask.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  document.getElementById('btn-char-add')?.addEventListener('click', openNewChar);
  newCharClose?.addEventListener('click', closeNewChar);
  newCharMask?.addEventListener('click', (e) => { if (e.target === newCharMask) closeNewChar(); });

  newCharSubmit?.addEventListener('click', async () => {
    const name = newCharName?.value.trim();
    if (!name) {
      newCharName?.focus();
      newCharName && (newCharName.style.outline = '2px solid var(--brand-blue)');
      setTimeout(() => newCharName && (newCharName.style.outline = ''), 1200);
      return;
    }
    const persona = newCharPersona?.value.trim() || '';
    const created = await createConversation({ name, persona, avatar: 'peer', archive: {} });
    const id = created.id;
    closeNewChar();
    const refreshed = getState();
    if (refreshed) {
      activeId = id;
      renderSwitchBar(refreshed.conversations);
      const newConv = refreshed.conversations.find((c) => c.id === id);
      if (newConv) fillFields(newConv);
    }
  });
}

// ─── 情侣空间页 ───────────────────────────────────────────────────────────────

function initCoupleSpacePage() {
  if (page !== 'couple-space.html') return;

  const COUPLE_KEY   = 'echo-couple-v1';
  const myAvatarEl   = document.getElementById('couple-my-avatar');
  const charAvatarEl = document.getElementById('couple-char-avatar');
  const heroNames    = document.getElementById('couple-hero-names');
  const pickBtn      = document.getElementById('btn-pick-char');
  const pickMask     = document.getElementById('char-pick-mask');
  const pickClose    = document.getElementById('char-pick-close');
  const pickList     = document.getElementById('char-pick-list');

  // 读取当前选中角色 id（优先 echo-couple-v1，fallback activeConversationId）
  function getSavedCharId() { return readJson(COUPLE_KEY, {}).charId || null; }
  async function saveCharId(id) { await writeJson(COUPLE_KEY, { ...readJson(COUPLE_KEY, {}), charId: id }); }

  function getCharConv() {
    try {
      const st = loadChatState();
      const singles = st.conversations.filter(c => c.avatar !== 'group');
      const savedId = getSavedCharId();
      return singles.find(c => c.id === savedId)
          || singles.find(c => c.id === st.activeConversationId)
          || singles[0]
          || null;
    } catch { return null; }
  }

  function applyChar() {
    const conv = getCharConv();
    if (!conv || !charAvatarEl) return;
    if (conv.avatarData) {
      charAvatarEl.innerHTML = `<img src="${safeImage(conv.avatarData)}" alt="${escapeHtml(conv.name)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      charAvatarEl.innerHTML = `<span class="avatar__initial">${escapeHtml(conv.initial || conv.name.charAt(0))}</span>`;
    }
    if (heroNames) {
      const p = loadProfile();
      heroNames.textContent = `${conv.name} & ${p.nickname || '拾贝人'}`;
    }
  }

  function apply(profile) {
    if (myAvatarEl) {
      if (profile.avatarData) {
        myAvatarEl.innerHTML = `<img src="${safeImage(profile.avatarData)}" alt="${escapeHtml(profile.nickname)}"
          style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      } else {
        myAvatarEl.innerHTML = `<span class="avatar__initial">${escapeHtml((profile.nickname || '我').charAt(0))}</span>`;
      }
    }
    applyChar();
  }

  applyChar();
  apply(loadProfile());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { applyChar(); apply(loadProfile()); }
  });
  subscribeToProfile(apply);

  // ── 角色选择弹层 ─────────────────────────────────────────────────────────
  function openPick() {
    if (!pickMask || !pickList) return;
    const st      = loadChatState();
    const singles = st.conversations.filter(c => c.avatar !== 'group');
    const current = getCharConv();

    pickList.innerHTML = '';
    singles.forEach((conv) => {
      const btn = document.createElement('button');
      btn.className = `char-pick-item${conv.id === current?.id ? ' char-pick-item--active' : ''}`;
      btn.type = 'button';

      const av = document.createElement('div');
      av.className = 'char-pick-item__avatar';
      if (conv.avatarData) {
        av.innerHTML = `<img src="${safeImage(conv.avatarData)}" alt="${escapeHtml(conv.name)}">`;
      } else {
        av.textContent = conv.initial || conv.name.charAt(0).toUpperCase();
      }

      const body = document.createElement('div');
      body.className = 'char-pick-item__body';
      body.innerHTML = `<div class="char-pick-item__name">${escapeHtml(conv.name)}</div>
        ${conv.alias ? `<div class="char-pick-item__alias">${escapeHtml(conv.alias)}</div>` : ''}`;

      btn.append(av, body);
      if (conv.id === current?.id) {
        const check = document.createElement('i');
        check.className = 'fa-solid fa-check char-pick-item__check';
        btn.appendChild(check);
      }

      btn.addEventListener('click', async () => {
        await saveCharId(conv.id);
        applyChar();
        apply(loadProfile());
        closePick();
      });
      pickList.appendChild(btn);
    });

    pickMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closePick() {
    pickMask?.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  pickBtn?.addEventListener('click', openPick);
  pickClose?.addEventListener('click', closePick);
  pickMask?.addEventListener('click', (e) => { if (e.target === pickMask) closePick(); });
}

// ─── 自动记忆提取 ─────────────────────────────────────────────────────────────
// 每轮对话结束后静默调用，提取有价值的信息写入记忆库
// 不阻塞 UI，失败静默忽略

async function extractMemories(speaker, userText, aiText, conversationId, turnId, signal) {
  if (!loadSettings().models.text.apiKey || signal?.aborted) return;
  try {
    const raw = await requestCompletion({
      signal, temperature: 0.3, timeout: 20,
      messages: [
        { role: 'system', content: '提取对话中明确的约定、事件、喜好或羁绊。只返回 JSON 数组，每项为 {"content":"20字以内的事实","tags":["约定"或"事件"或"喜好"或"羁绊"]}。不记录普通寒暄或推测，最多3项，没有则返回 []。' },
        { role: 'user', content: `用户：${userText.slice(0, 4000)}\n${speaker.name}：${aiText.slice(0, 4000)}` },
      ],
    });
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const items = JSON.parse(cleaned);
    if (!Array.isArray(items) || !getConversation(conversationId) || !getConversation(speaker.id)) return;
    for (const item of items.slice(0, 3)) {
      if (typeof item?.content !== 'string' || !item.content.trim()) continue;
      await saveMemory({ id: Date.now() + Math.random(), content: item.content.trim().slice(0, 200), source: 'system', tags: Array.isArray(item.tags) ? item.tags.filter(tag => ['约定','事件','喜好','羁绊'].includes(tag)).slice(0, 4) : [], conversationId, charId: speaker.id, turnId });
    }
  } catch (error) { console.warn('[Echo] 记忆提取未完成：', error.message); }
}

// ─── 图片压缩工具 ────────────────────────────────────────────────────────────
// 上传时统一压缩，大幅减小 localStorage 占用
// maxSize: 最长边像素上限；quality: JPEG 质量 0~1
function resizeImage(file, maxSize, quality = 0.82) {
  if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 15 * 1024 * 1024) {
    reportError(new Error('请选择不超过 15MB 的 JPG、PNG、WebP 或 GIF 图片。'));
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    const timer = setTimeout(() => resolve(null), 15000);
    const finish = value => { clearTimeout(timer); resolve(value); };
    reader.onerror = () => finish(null);
    reader.onload = event => {
      const image = new Image();
      image.onerror = () => finish(null);
      image.onload = () => {
        try {
          if (!image.width || !image.height || image.width * image.height > 40000000) throw new Error('图片分辨率过大。');
          const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * ratio));
          canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', quality));
        } catch (error) { reportError(error); finish(null); }
      };
      image.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function initBackupActions() {
  if (page !== 'world.html') return;
  document.getElementById('btn-backup')?.addEventListener('click', async () => {
    try {
      const blob = new Blob([JSON.stringify(await createBackup(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `echo-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { reportError(error); }
  });
  document.getElementById('btn-restore')?.addEventListener('click', () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      try {
        const file = input.files?.[0]; if (!file) return;
        if (file.size > 128 * 1024 * 1024) throw new Error('备份文件过大。');
        const backup = JSON.parse(await file.text());
        if (!confirm('将恢复备份中包含的数据。请确认已导出当前备份。API Key 不会从文件导入。')) return;
        await restoreBackup(backup); alert('恢复完成。'); window.location.reload();
      } catch (error) { reportError(error); }
    });
    input.click();
  });
}

async function init() {
  // ── 全局壁纸应用（排除 chat-room 和 lock-screen，它们有专属背景逻辑）────
  (function applyWallpaper() {
    if (page === 'chat-room.html' || page === 'lock-screen.html') return;
    try {
      const wallpaper = localStorage.getItem('echo-theme-assets-v1.wallpaper');
      if (!wallpaper) return;
      const phone = document.querySelector('.phone');
      if (!phone) return;
      document.getElementById('__wallpaper_layer__')?.remove();
      const layer = document.createElement('div');
      layer.id = '__wallpaper_layer__';
      layer.style.cssText = [
        'position:fixed;inset:0;',
        `background:url(${wallpaper}) center top / cover no-repeat;`,
        'z-index:-1;pointer-events:none;',
      ].join('');
      phone.parentNode.insertBefore(layer, phone);
      phone.style.background = 'linear-gradient(135deg,rgba(253,254,255,0.72),rgba(240,247,252,0.72))';
    } catch { /* ignore */ }
  })();

  // ── 聊天背景应用（仅 chat-room.html，替代全局壁纸） ──────────────────────
  (function applyChatBg() {
    if (page !== 'chat-room.html') return;
    try {
      const chatBg = localStorage.getItem('echo-theme-assets-v1.chatBg');
      const layer  = document.getElementById('__chatbg_layer__');
      if (chatBg && layer) {
        layer.style.backgroundImage = `url(${chatBg})`;
        layer.style.display = 'block';
      }
    } catch { /* ignore */ }
  })();

  // ── 主题字体/图标 CSS 变量注入（排除 lock-screen） ───────────────────────
  (function applyThemeTokens() {
    if (page === 'lock-screen.html') return;
    try {
      // 直接读 localStorage，避免 volatileSettings 缓存返回默认值
      const raw = localStorage.getItem('echo-settings-v1');
      const s = raw ? JSON.parse(raw) : null;
      const th = (s && s.theme) ? s.theme : { fontSize: 45, fontColor: 'ink', iconSize: 50, iconShape: 'round' };
      const root = document.documentElement;

      // 字体大小：0→12px  45→14.25px  100→17px
      const fsPx = 12 + (th.fontSize / 100) * 5;
      root.style.setProperty('--font-size-base', `${fsPx.toFixed(1)}px`);

      // 字体颜色 —— fontColor 存的是 hex（#rrggbb），兼容旧版 ink/gray/white 字符串
      const legacyColorMap = { ink: '#4E6B80', gray: '#9DB4C4', white: '#FFFFFF' };
      const fc = (th.fontColor && th.fontColor.startsWith('#'))
        ? th.fontColor
        : (legacyColorMap[th.fontColor] || '#4E6B80');
      root.style.setProperty('--font-color-base', fc);

      // 图标芯片大小：0→30px  50→38px  100→46px
      const icPx = 30 + (th.iconSize / 100) * 16;
      root.style.setProperty('--icon-chip-size', `${Math.round(icPx)}px`);
      root.style.setProperty('--icon-chip-radius', th.iconShape === 'square' ? '10px' : '13px');
      root.style.setProperty('--icon-font-size', `${Math.round(icPx * 0.42)}px`);
    } catch { /* ignore */ }
  })();
  initBackupActions();
  initMainNavigation();
  initHomePage();
  if (page === 'chat-list.html') {
    renderChatList();
    subscribeToChatState(renderChatList);
    initChatListProfileSheet();
  }
  if (page === 'chat-room.html')     await initChatRoom();
  if (page === 'chat-settings.html') { initChatSettings(); initCharProfilePage(); }
  if (page === 'settings.html')      initSettingsPage();
  if (page === 'memory.html')        initMemoryPage();
  if (page === 'my-profile.html')    initProfilePage();
  if (page === 'chat-create.html')   initChatCreatePage();
  if (page === 'moments.html')       initMomentsPage();
  if (page === 'archive.html')        initArchivePage();
  if (page === 'theme.html')          initThemePage();
  if (page === 'couple-space.html')   initCoupleSpacePage();
}

document.getElementById('input-message')?.setAttribute('disabled', '');
window.echoReady = (async () => {
  await initializeStorage({ defaults: { 'echo-chat-state-v1': defaultChatState() } });
  await init();
})();
window.echoReady.catch(reportError);
window.addEventListener('echo-storage-error', event => reportError(event.detail));

