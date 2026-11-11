import { loadChatState, subscribeToChatState } from '../chat-state.js';
import { safeImage } from '../storage-state.js';
import { escapeHtml, page, resizeImage } from '../ui-helpers.js';
import { chatRoomHref } from '../chat-router.js';
import { loadProfile, updateProfile } from '../profile-state.js';

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
  const automationLink = document.createElement('a');
  automationLink.className = 'entry-pill glass'; automationLink.id = 'btn-chat-automation'; automationLink.href = 'chat-automation.html';
  automationLink.innerHTML = '<i class="fa-solid fa-sliders" aria-hidden="true"></i>聊天设置';
  document.querySelector('.chatlist-entries')?.appendChild(automationLink);

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
      bio:         inputBio ? inputBio.value.trim() : current.bio,
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

export async function initPage() { renderChatList(); subscribeToChatState(renderChatList); initChatListProfileSheet(); }
