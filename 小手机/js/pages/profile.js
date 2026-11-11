import { page, resizeImage, reportError } from '../ui-helpers.js';
import { loadProfile, updateProfile } from '../profile-state.js';
import { safeImage } from '../storage-state.js';

function initProfilePage() {
  if (page !== 'my-profile.html') return;

  const nicknameEl = document.getElementById('input-nickname');
  const idEl       = document.getElementById('input-id');
  const bioEl      = document.getElementById('input-bio');
  const saveBtn    = document.getElementById('btn-save');
  if (!saveBtn) return;

  let profile = loadProfile(), pendingAvatar;
  if (nicknameEl) nicknameEl.value = profile.nickname;
  if (idEl)       idEl.value       = profile.id;
  if (bioEl)      bioEl.value      = profile.bio;
  const avatar = document.getElementById('btn-avatar-upload');
  function renderAvatar(data) {
    if (!avatar || !safeImage(data)) return;
    let image = avatar.querySelector('img');
    if (!image) { image = document.createElement('img'); image.alt = '头像'; image.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit'; avatar.prepend(image); }
    image.src = data;
    const initial = avatar.querySelector('.profile-avatar__initial'); if (initial) initial.hidden = true;
  }
  renderAvatar(profile.avatarData);
  avatar?.addEventListener('click', () => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png,image/webp,image/gif';
    picker.addEventListener('change', async () => {
      const data = await resizeImage(picker.files?.[0], 320);
      if (data) { pendingAvatar = data; renderAvatar(data); }
    }); picker.click();
  });

  saveBtn.addEventListener('click', async () => {
    const next = {};
    if (nicknameEl && nicknameEl.value.trim() !== profile.nickname && nicknameEl.value.trim()) next.nickname = nicknameEl.value.trim();
    if (bioEl && bioEl.value.trim() !== profile.bio) next.bio = bioEl.value.trim();
    if (pendingAvatar !== undefined) next.avatarData = pendingAvatar;
    try { await updateProfile(next); profile = loadProfile(); pendingAvatar = undefined; }
    catch (error) { reportError(error); return; }

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

export async function initPage() { initProfilePage(); }
