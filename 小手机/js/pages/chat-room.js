import { loadProfile } from '../profile-state.js';
import { loadChatState, getMessages, getConversation, setActiveConversation, markConversationRead, recoverReplyTask, loadMessagePage, currentReplyTask, subscribeToChatState, messageWindow, setDraft, appendMessage, rememberMessage, updateMessage, deleteMessage } from '../chat-state.js';
import { safeImage } from '../storage-state.js';
import { escapeHtml, setText, reportError } from '../ui-helpers.js';
import { parseChatRoute, chatListHref, chatSettingsHref } from '../chat-router.js';
import { createReplyRunner } from '../reply-service.js';
import { updateSettings } from '../settings-state.js';

const renderedRooms = new WeakMap();
function renderMessages(conversation, messages) {
  const container = document.querySelector('#room-msgs');
  if (!container) return;
  const nodes = [], nextRows = new Map();
  const previous = renderedRooms.get(container) || { rows: new Map() };
  let previousTime = '';

  // 读取「我」的 profile，用于头像和昵称首字
  const myProfile = loadProfile();
  // 一次性读取最新 state，供头像查找使用（避免每条消息都读 localStorage）
  let freshState = null;
  function getFreshState() {
    if (!freshState) freshState = loadChatState();
    return freshState;
  }
  const context = JSON.stringify([myProfile.nickname, myProfile.avatarData, getFreshState().conversations.map(c => [c.id, c.name, c.initial, c.avatar, c.avatarData, c.members])]);
  const reuse = previous.context === context;

  const legacyPeerIndices = conversation.avatar === 'group'
    ? new Map(getMessages(conversation.id, getFreshState()).filter(m => m.author !== 'mine').map((m, index) => [m.id, index]))
    : new Map();

  messages.forEach((message) => {
    if (message.time !== previousTime) {
      const key = 'time:' + message.id;
      const time = previous.rows.get(key)?.node || document.createElement('time');
      time.className = 'msg-time';
      time.textContent = message.time;
      nodes.push(time); nextRows.set(key, { node: time });
      previousTime = message.time;
    }

    const key = 'message:' + message.id, signature = JSON.stringify(message);
    const cached = previous.rows.get(key);
    if (reuse && cached?.signature === signature) { nodes.push(cached.node); nextRows.set(key, cached); return; }

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

    nodes.push(row); nextRows.set(key, { node: row, signature });
  });

  // Leave unchanged rows attached, preserving selection, editing and expanded thoughts.
  let cursor = container.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(node, cursor);
  }
  const keep = new Set(nodes);
  for (const node of [...container.childNodes]) if (!keep.has(node)) node.remove();
  renderedRooms.set(container, { rows: nextRows, context });

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
  let activeTask = null, isGenerating = false, commandBusy = false, draftTimer = null, loadingOlder = false, disposed = false, taskOwner = null;
  const hidden = new Set();
  const scrollingElement = () => msgContainer.scrollHeight > msgContainer.clientHeight + 2 ? msgContainer : document.scrollingElement;
  const nearBottom = () => { const node = scrollingElement(); return node.scrollHeight - node.clientHeight - node.scrollTop < 120; };
  const render = ({ follow = false } = {}) => {
    if (disposed) return;
    const current = getConversation(conversation.id);
    if (!current) { activeTask?.abort(); window.location.replace(chatListHref(route.source)); return; }
    setText('.room-nav__name', current.name);
    setText('.room-nav__status', current.alias || current.status || '在线');
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
    replyRunner.dispose(); clearTimeout(draftTimer); clearInterval(recoveryTimer); disposed = true; unsubscribe();
    window.removeEventListener('scroll', loadOlder); msgContainer.removeEventListener('scroll', loadOlder);
  }, { once: true });
  const replyRunner = createReplyRunner({
    conversationId: conversation.id,
    onState({ running, owner }) {
      isGenerating = running; taskOwner = owner;
      activeTask = running ? { abort: () => replyRunner.cancel() } : null;
      if (!running) hidden.clear();
      render();
    },
    onUserCommitted() { input.value = ''; render({ follow: true }); },
    onChunk({ messageId, text }) {
      if (disposed) return;
      const bubble = msgContainer.querySelector(`[data-msg-id="${CSS.escape(messageId)}"] .msg__bubble`);
      if (bubble) {
        const follow = nearBottom(); bubble.textContent = text;
        if (follow) requestAnimationFrame(() => msgContainer.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'instant' }));
      }
    },
    onStaging(entries) { entries.slice(1).forEach(entry => hidden.add(entry.id)); },
    onReveal(id) { hidden.delete(id); render(); },
  });
  async function runGeneration(options = {}) {
    try { await replyRunner.run(options); }
    catch (error) { if (error.name !== 'AbortError' && !disposed) reportError(error); }
  }
  async function sendMessage() {
    if (isGenerating || commandBusy) return;
    const text = input.value.trim(); if (!text) return;
    commandBusy = true;
    try {
      clearTimeout(draftTimer); draftTimer = null;
      const autoMemory = text.match(/^自动记忆[：:]\s*(开|关)$/);
      if (autoMemory) {
        updateSettings(settings => { settings.memory.autoExtract = autoMemory[1] === '开'; });
        await appendMessage(conversation.id, { author: 'peer', text: `✓ 已${autoMemory[1] === '开' ? '开启' : '关闭'}自动记忆` }, { clearDraft: true });
        input.value = ''; return;
      }
      const remember = text.match(/^记住[：:]\s*(.+)$/i);
      if (remember) {
        await rememberMessage(conversation.id, text, remember[1].trim());
        input.value = ''; return;
      }
      await runGeneration({ userText: text });
    } catch (error) { reportError(error); }
    finally { commandBusy = false; }
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
      if (e.type === 'keydown' && (e.isComposing || e.keyCode === 229)) return;
      if (e.type === 'keydown' && e.key !== 'Enter') return;
      if (e.type === 'keydown' && e.shiftKey) return;
      if (e.type === 'keydown') e.preventDefault();
      const newText = bubble.textContent.trim();
      bubble.contentEditable = 'false';
      bubble.classList.remove('msg__bubble--editing');
      bubble.removeEventListener('blur', commitEdit);
      bubble.removeEventListener('keydown', commitEdit);
      renderedRooms.get(msgContainer)?.rows.delete('message:' + msgId);
      if (!newText) { render(); return; }
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

export async function initPage() { await initChatRoom(); }
