import { page, reportError, resizeImage } from './ui-helpers.js';
import { StorageError, initializeStorage } from './storage-state.js';
import { defaultChatState, loadChatState } from './chat-state.js';
import { chatRoomHref, chatListHref } from './chat-router.js';
import { loadSettings, updateSettings, subscribeToSettings, saveThemeAsset, loadThemeAsset } from './settings-state.js';

window.addEventListener('error', event => {
  if (event.error instanceof StorageError) { event.preventDefault(); reportError(event.error); }
});
window.addEventListener('unhandledrejection', event => {
  event.preventDefault(); reportError(event.reason);
});


function currentPageName() {
  if (page === 'chat-room.html') return 'chat';
  if (page === 'chat-list.html') return 'chat-list';
  return page.replace('.html', '');
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

// @theme-controller-end

async function init() {
  // ── 全局壁纸应用（排除 chat-room 和 lock-screen，它们有专属背景逻辑）────
  (function applyWallpaper() {
    if (!['home.html', 'other.html'].includes(page)) return;
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
  initMainNavigation();
  const pages = {
    'home.html': () => import('./pages/home.js'),
    'chat-list.html': () => import('./pages/chat-list.js'),
    'chat-room.html': () => import('./pages/chat-room.js'),
    'chat-settings.html': () => import('./pages/chat-settings.js'),
    'settings.html': () => import('./pages/settings.js'),
    'memory.html': () => import('./pages/memory.js'),
    'my-profile.html': () => import('./pages/profile.js'),
    'chat-create.html': () => import('./pages/create.js'),
    'moments.html': () => import('./pages/moments.js'),
    'archive.html': () => import('./pages/archive.js'),
    'couple-space.html': () => import('./pages/couple-space.js'),
    'world.html': () => import('./pages/world.js'),
    'chat-automation.html': () => import('./pages/automation.js'),
  };
  if (pages[page]) await (await pages[page]()).initPage();
  if (page === 'theme.html') initThemePage();
}

document.getElementById('input-message')?.setAttribute('disabled', '');
window.echoReady = (async () => {
  await initializeStorage({ defaults: { 'echo-chat-state-v1': defaultChatState() } });
  await init();
})();
window.echoReady.catch(reportError);
window.addEventListener('echo-storage-error', event => reportError(event.detail));

