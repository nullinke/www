import { loadSettings, subscribeToSettings, updateSettings } from '../settings-state.js';
import { apiEndpoint, readResponseJson } from '../api.js';
import { escapeHtml, reportError, showPrompt } from '../ui-helpers.js';

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

  const timeoutRow = document.getElementById('row-timeout');
  let timeoutEditorOpen = false;
  async function editTimeout() {
    if (timeoutEditorOpen) return;
    timeoutEditorOpen = true;
    try {
      const raw = await showPrompt('请求超时（5–600 秒）', { title: '编辑请求超时', value: String(loadSettings().parameters.timeout), inputMode: 'numeric', placeholder: '输入 5–600 之间的整数', confirmText: '保存', maxLength: 3 });
      if (raw === null) return;
      const value = Number(raw.trim());
      if (!Number.isInteger(value) || value < 5 || value > 600) { reportError(new Error('请输入 5–600 之间的整数秒数。')); return; }
      updateSettings(settings => { settings.parameters.timeout = value; });
    } finally { timeoutEditorOpen = false; }
  }
  if (timeoutRow) {
    timeoutRow.setAttribute('role', 'button'); timeoutRow.tabIndex = 0; timeoutRow.title = '修改请求超时';
    timeoutRow.addEventListener('click', editTimeout);
    timeoutRow.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); editTimeout(); } });
  }

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
        const json = await readResponseJson(response, controller.signal);
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
      const json = await readResponseJson(resp, controller.signal);
      if (sequence !== listSequence) return;
      const items = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
      const names = [...new Set(items.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 120))];
      if (!names.length) throw new Error('列表为空或缺少有效模型 ID');
      if (modelPresets) {
        modelPresets.innerHTML = '';
        const filtered = names.filter(name => !/embedding|moderation|tts|whisper|dall-e/i.test(name));
        (filtered.length ? filtered : names).slice(0, 500).forEach((id) => {
          const btn = document.createElement('button'); btn.className = 'model-preset-btn';
          btn.innerHTML = `<span class="model-preset-btn__name">${escapeHtml(id)}</span>`;
          btn.addEventListener('click', () => { if (inputName) inputName.value = id; });
          modelPresets.appendChild(btn);
        });
      }
      if (fetchText) fetchText.textContent = names.length > 500 ? `显示前 500 个模型（共 ${names.length} 个）` : `${names.length} 个模型`;
    } catch (err) {
      if (fetchText && sequence === listSequence) { fetchText.textContent = `失败: ${err.message}`; setTimeout(() => { if (fetchText) fetchText.textContent = '重试'; }, 2500); }
    } finally { clearTimeout(timer); icon?.classList.remove('spinning'); if (fetchBtn) fetchBtn.disabled = false; }
  }
  fetchBtn?.addEventListener('click', fetchModelList);
  document.getElementById('row-text-model')?.addEventListener('click',  () => openModelSheet('text'));
  document.getElementById('row-voice-model')?.addEventListener('click', () => openModelSheet('voice'));
  document.getElementById('row-image-model')?.addEventListener('click', () => openModelSheet('image'));
}

export async function initPage() { initSettingsPage(); }
