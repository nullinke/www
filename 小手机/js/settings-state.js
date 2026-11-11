import { readJson, writeJson, StorageError } from './storage-state.js';
const STORAGE_KEY = 'echo-settings-v1';
// 图片资源单独存储，避免 base64 大数据撑爆 settings JSON
const ASSETS_KEY  = 'echo-theme-assets-v1';

const DEFAULT_SETTINGS = {
  version: 1,
  // 每个模型存储三字段：name（显示名）、baseUrl（API 地址）、apiKey（密钥）
  models: {
    text:  { name: 'Kimi K2',       baseUrl: '', apiKey: '' },
    voice: { name: 'Echo Voice',    baseUrl: '', apiKey: '' },
    image: { name: 'Tide Diffusion',baseUrl: '', apiKey: '' },
  },
  parameters: {
    temperature: { value: 0.8, progress: 62 },
    topP: { value: 0.9, progress: 72 },
    context: { value: 32, progress: 40 },
    frequencyPenalty: { value: 0.3, progress: 25 },
    presencePenalty: { value: 0.2, progress: 18 },
    timeout: 60,
  },
  mcpEnabled: true,
  memory: { autoExtract: true },
  theme: {
    iconSize:    50,       // 0~100，对应小/中/大
    iconShape:   'round',  // 'round' | 'square'
    fontSize:    45,       // 0~100，对应小/标准/大
    fontColor:   'ink',    // 'ink' | 'gray' | 'white'
    // lockAvatar 和 wallpaper 单独存在 ASSETS_KEY，不放在这里
  },
  updatedAt: 0,
};


function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeSettings(value) {
  const fallback = cloneDefaults();
  if (!isRecord(value)) return fallback;

  const models = isRecord(value.models) ? value.models : {};

  // 归一化单个模型配置，兼容旧版字符串格式
  function normalizeModel(raw, fallbackName) {
    if (typeof raw === 'string') {
      // 旧格式迁移：字符串直接作为 name
      return { name: raw || fallbackName, baseUrl: '', apiKey: '' };
    }
    if (isRecord(raw)) {
      return {
        name:    safeLabel(raw.name,    fallbackName, 120),
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().slice(0, 500) : '',
        apiKey:  typeof raw.apiKey  === 'string' ? raw.apiKey.trim().slice(0, 500)  : '',
      };
    }
    return { name: fallbackName, baseUrl: '', apiKey: '' };
  }
  const parameters = isRecord(value.parameters) ? value.parameters : {};
  const normalizeParameter = (key, min, max, step) => {
    const candidate = isRecord(parameters[key]) ? parameters[key] : {};
    const fallbackParameter = fallback.parameters[key];
    const rawValue = boundedNumber(candidate.value, fallbackParameter.value, min, max);
    const valueRounded = Math.round(rawValue / step) * step;
    return {
      value: Number(valueRounded.toFixed(3)),
      progress: Math.round(boundedNumber(candidate.progress, fallbackParameter.progress, 0, 100)),
    };
  };

  const timeout = Number(parameters.timeout);
  return {
    version: 1,
    models: {
      text:  normalizeModel(models.text,  fallback.models.text.name),
      voice: normalizeModel(models.voice, fallback.models.voice.name),
      image: normalizeModel(models.image, fallback.models.image.name),
    },
    parameters: {
      temperature: normalizeParameter('temperature', 0, 1.3, 0.1),
      topP: normalizeParameter('topP', 0, 1, 0.01),
      context: normalizeParameter('context', 8, 64, 8),
      frequencyPenalty: normalizeParameter('frequencyPenalty', 0, 1.2, 0.1),
      presencePenalty: normalizeParameter('presencePenalty', 0, 1.1, 0.1),
      timeout: Number.isFinite(timeout) ? Math.round(Math.min(600, Math.max(5, timeout))) : fallback.parameters.timeout,
    },
    mcpEnabled: typeof value.mcpEnabled === 'boolean' ? value.mcpEnabled : fallback.mcpEnabled,
    memory: { autoExtract: typeof value.memory?.autoExtract === 'boolean' ? value.memory.autoExtract : true },
    theme: (function() {
      const t = isRecord(value.theme) ? value.theme : {};
      return {
        iconSize:   boundedNumber(t.iconSize,  fallback.theme.iconSize,  0, 100),
        iconShape:  t.iconShape === 'square' ? 'square' : 'round',
        fontSize:   boundedNumber(t.fontSize,  fallback.theme.fontSize,  0, 100),
        fontColor:  (function(v) {
          // 兼容旧版 'ink'/'gray'/'white' 以及新版 '#rrggbb' hex
          if (['ink','gray','white'].includes(v)) return v;
          if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
          return fallback.theme.fontColor;
        })(t.fontColor),
      };
    })(),
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
  };
}

function safeLabel(value, fallback, maxLen = 80) {
  if (typeof value !== 'string') return fallback;
  const label = value.trim().slice(0, maxLen);
  return label || fallback;
}

export function loadSettings() {
  const settings = readJson(STORAGE_KEY, cloneDefaults);
  if (!isRecord(settings) || (settings.version !== undefined && settings.version !== 1)) throw new StorageError('设置数据结构不受支持，已保留原始内容。');
  return normalizeSettings(settings);
}

export function saveSettings(nextSettings) {
  const settings = normalizeSettings(nextSettings);
  settings.updatedAt = Date.now();
  writeJson(STORAGE_KEY, settings);
  window.dispatchEvent(new CustomEvent('echo-settings-change', { detail: settings }));
  return normalizeSettings(settings);
}

export function updateSettings(mutator) {
  const settings = loadSettings();
  mutator(settings);
  return saveSettings(settings);
}

export function subscribeToSettings(handler) {
  const onSettingsChange = (event) => handler(normalizeSettings(event.detail || loadSettings()));
  const onStorage = (event) => {
    if (event.key === STORAGE_KEY) handler(loadSettings());
  };

  window.addEventListener('echo-settings-change', onSettingsChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('echo-settings-change', onSettingsChange);
    window.removeEventListener('storage', onStorage);
  };
}

export { STORAGE_KEY };

// ── 主题图片资源独立存取（每个 key 占独立 localStorage 条目，避免合并超限）──
export function saveThemeAsset(key, base64) {
  try {
    window.localStorage.setItem(ASSETS_KEY + '.' + key, base64);
  } catch (e) {
    throw new StorageError('资源保存失败，请先备份并释放存储空间。', e);
  }
  window.dispatchEvent(new CustomEvent('echo-theme-assets-change', { detail: { key, value: base64 } }));
}

/** 读取单张主题图片 */
export function loadThemeAsset(key) {
  try {
    return window.localStorage.getItem(ASSETS_KEY + '.' + key) || '';
  } catch { return ''; }
}

/** 删除单张主题图片 */
export function deleteThemeAsset(key) {
  try {
    window.localStorage.removeItem(ASSETS_KEY + '.' + key);
  } catch { /* ignore */ }
}
