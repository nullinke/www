import { page } from '../ui-helpers.js';
import { loadThemeAsset } from '../settings-state.js';
import { safeImage } from '../storage-state.js';

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

export async function initPage() { initHomePage(); }
