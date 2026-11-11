import { page, escapeHtml } from '../ui-helpers.js';
import { safeImage } from '../storage-state.js';
import { loadChatState, subscribeToChatState } from '../chat-state.js';
import { loadCouple, setCoupleCharacter, subscribeToCouple } from '../couple-state.js';
import { loadProfile, subscribeToProfile } from '../profile-state.js';

function initCoupleSpacePage() {
  if (page !== 'couple-space.html') return;

  const myAvatarEl   = document.getElementById('couple-my-avatar');
  const charAvatarEl = document.getElementById('couple-char-avatar');
  const heroNames    = document.getElementById('couple-hero-names');
  const pickBtn      = document.getElementById('btn-pick-char');
  const pickMask     = document.getElementById('char-pick-mask');
  const pickClose    = document.getElementById('char-pick-close');
  const pickList     = document.getElementById('char-pick-list');

  // 读取当前选中角色 id（优先 echo-couple-v1，fallback activeConversationId）
  function getSavedCharId() { return loadCouple().charId || null; }

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
    if (!charAvatarEl) return;
    if (!conv) { charAvatarEl.textContent = ''; if (heroNames) heroNames.textContent = '请选择角色'; return; }
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
  subscribeToChatState(applyChar);
  subscribeToCouple(applyChar);

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
        await setCoupleCharacter(conv.id);
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

export async function initPage() { initCoupleSpacePage(); }
