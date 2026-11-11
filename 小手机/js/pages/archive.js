import { page } from '../ui-helpers.js';
import { loadChatState, updateConversation, deleteConversation, createConversation } from '../chat-state.js';
import { loadProfile, updateProfile } from '../profile-state.js';
import { safeImage } from '../storage-state.js';

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

export async function initPage() { initArchivePage(); }
