import { parseChatRoute, chatRoomHref, chatListHref } from '../chat-router.js';
import { page, resizeImage, escapeHtml } from '../ui-helpers.js';
import { loadChatState, getConversation, updateConversation, deleteConversation } from '../chat-state.js';
import { safeImage, readJson } from '../storage-state.js';

function initChatSettings() {
  const back = document.querySelector('#btn-back');
  if (!back) return;
  const route = parseChatRoute();
  back.setAttribute('href', route.conversationId ? chatRoomHref(route.conversationId, route.mode, route.source) : chatListHref(route.source));
}


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

export async function initPage() { initChatSettings(); initCharProfilePage(); }
