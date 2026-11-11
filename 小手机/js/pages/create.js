import { page, resizeImage, escapeHtml, reportError } from '../ui-helpers.js';
import { safeImage } from '../storage-state.js';
import { loadChatState, createConversation } from '../chat-state.js';
import { chatRoomHref } from '../chat-router.js';

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

export async function initPage() { initChatCreatePage(); }
