/** Shared persistence boundary. Failed writes never publish success or prune data. */
export class StorageError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'StorageError';
  }
}

export function readJson(key, fallback) {
  let raw;
  try { raw = window.localStorage.getItem(key); }
  catch (error) { throw new StorageError('无法读取本地数据，请检查浏览器存储权限。', error); }
  if (raw === null) return typeof fallback === 'function' ? fallback() : fallback;
  try { return JSON.parse(raw); }
  catch (error) { throw new StorageError(`本地数据损坏（${key}），已保留原始内容，请先备份后恢复。`, error); }
}

export function writeJson(key, value, eventName) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); }
  catch (error) {
    throw new StorageError('保存失败，原有数据未被截断。请先备份并释放存储空间，或检查存储权限。', error);
  }
  if (eventName) window.dispatchEvent(new CustomEvent(eventName));
  return value;
}

export function subscribe(key, eventName, handler, load) {
  const custom = () => handler(load());
  const storage = (event) => { if (event.key === key || event.key === null) custom(); };
  window.addEventListener(eventName, custom);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(eventName, custom);
    window.removeEventListener('storage', storage);
  };
}

export function uniqueId(prefix = '') {
  return prefix + crypto.randomUUID();
}

/** Only local uploaded raster images may be placed in image attributes. */
export function safeImage(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value) ? value : '';
}

const BACKUP_KEYS = /^(?:echo-(?:chat-state|profile|settings|memory|moments|couple|world)-v1|echo-chat-drafts-v2|echo-business-asset-v2\.[\w-]+|echo-conv-avatar-v1\.[^\u0000-\u001f]+|echo-theme-assets-v1\.[\w.-]+)$/;

export function createBackup() {
  const data = {};
  const warnings = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !BACKUP_KEYS.test(key)) continue;
    let value = localStorage.getItem(key);
    if (key === 'echo-settings-v1') {
      let settings;
      try { settings = JSON.parse(value); }
      catch { warnings.push('设置数据损坏，未导出该项，以免包含未脱敏的 API Key。原始内容仍保留在浏览器中。'); continue; }
      for (const model of Object.values(settings.models || {})) {
        if (model && typeof model === 'object') model.apiKey = '';
      }
      value = JSON.stringify(settings);
    }
    data[key] = value;
  }
  return { format: 'echo-backup', version: 1, createdAt: new Date().toISOString(), credentialsIncluded: false, warnings, data };
}

/** Restore only keys owned by Echo; roll back every changed key on failure. */
export function restoreBackup(backup) {
  if (backup?.format !== 'echo-backup' || backup.version !== 1 || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
    throw new Error('备份格式不正确。');
  }
  const allowed = BACKUP_KEYS;
  const entries = Object.entries(backup.data);
  if (entries.length > 10000 || entries.some(([key, value]) => !allowed.test(key) || typeof value !== 'string')) throw new Error('备份包含无效数据。');
  // Validate all structured data before any write; preserve locally configured credentials.
  const prepared = entries.map(([key, value]) => {
    if (!key.startsWith('echo-theme-assets-v1.') && !key.startsWith('echo-conv-avatar-v1.') && !key.startsWith('echo-business-asset-v2.')) {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') throw new Error('备份数据结构不正确。');
      if (['echo-memory-v1', 'echo-moments-v1', 'echo-world-v1'].includes(key) && !Array.isArray(parsed)) throw new Error('备份列表格式不正确。');
      if (!['echo-memory-v1', 'echo-moments-v1', 'echo-world-v1'].includes(key) && Array.isArray(parsed)) throw new Error('备份记录格式不正确。');
      if (key === 'echo-chat-state-v1' && (!Array.isArray(parsed.conversations) || !parsed.messagesByConversation || typeof parsed.messagesByConversation !== 'object')) throw new Error('备份聊天数据不完整。');
      if (key === 'echo-settings-v1') {
        const current = readJson(key, {});
        for (const [type, model] of Object.entries(parsed.models || {})) {
          if (model && typeof model === 'object') {
            const old = current.models?.[type];
            model.apiKey = old?.baseUrl === model.baseUrl ? (old.apiKey || '') : '';
          }
        }
        value = JSON.stringify(parsed);
      }
    } else if (key.startsWith('echo-theme-assets-v1.') && ['customFontName'].includes(key.split('.').at(-1))) {
      if (value.length > 500) throw new Error('字体文件名无效。');
    } else if (key === 'echo-theme-assets-v1.customFont') {
      if (!/^data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(value)) throw new Error('字体数据无效。');
    } else if (!safeImage(value)) throw new Error('备份包含无效图片。');
    return [key, value];
  });
  const previous = new Map(prepared.map(([key]) => [key, localStorage.getItem(key)]));
  try { for (const [key, value] of prepared) localStorage.setItem(key, value); }
  catch (error) {
    let rollbackFailed = false;
    for (const [key, value] of previous) {
      try { if (localStorage.getItem(key) === value) continue; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      catch { rollbackFailed = true; }
    }
    throw new StorageError(rollbackFailed ? '恢复未完成，部分数据无法回滚。请保留备份文件并释放空间后重试。' : '恢复失败，已回滚本次更改。请释放存储空间后重试。', error);
  }
}

const IMAGE_FIELDS = { avatarData: 'avatarRef', coverImage: 'coverImageRef', replyCharAvatar: 'replyCharAvatarRef', authorAvatar: 'authorAvatarRef' };

export function hydrateImages(value) {
  if (Array.isArray(value)) return value.map(hydrateImages);
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrateImages(item)]));
  for (const [field, ref] of Object.entries(IMAGE_FIELDS)) {
    if (!copy[field] && typeof copy[ref] === 'string' && copy[ref].startsWith('echo-business-asset-v2.')) {
      try { copy[field] = localStorage.getItem(copy[ref]) || ''; }
      catch (error) { throw new StorageError('无法读取本地图片资源。', error); }
    }
  }
  return copy;
}

/** Immutable assets are staged before the single canonical JSON commit. Old references stay valid. */
export function writeImageRecord(key, value, eventName) {
  const staged = [];
  const dedup = new Map();
  function serialize(item) {
    if (Array.isArray(item)) return item.map(serialize);
    if (!item || typeof item !== 'object') return item;
    const copy = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, serialize(child)]));
    for (const [field, ref] of Object.entries(IMAGE_FIELDS)) {
      const image = copy[field];
      if (!image) { if (Object.hasOwn(copy, field)) delete copy[ref]; continue; }
      if (!safeImage(image)) throw new StorageError('图片资源格式无效，原有数据已保留。');
      let assetKey = copy[ref];
      if (!assetKey?.startsWith('echo-business-asset-v2.') || localStorage.getItem(assetKey) !== image) {
        assetKey = dedup.get(image);
        if (!assetKey) {
          assetKey = uniqueId('echo-business-asset-v2.');
          localStorage.setItem(assetKey, image);
          staged.push(assetKey); dedup.set(image, assetKey);
        }
      } else dedup.set(image, assetKey);
      copy[ref] = assetKey;
      delete copy[field];
    }
    return copy;
  }
  let encoded;
  try { encoded = serialize(value); writeJson(key, encoded); }
  catch (error) {
    for (const assetKey of staged) { try { localStorage.removeItem(assetKey); } catch { /* harmless orphan */ } }
    if (error instanceof StorageError) throw error;
    throw new StorageError('图片或记录保存失败，原有数据已保留。请先备份并释放空间。', error);
  }
  if (eventName) window.dispatchEvent(new CustomEvent(eventName));
  return hydrateImages(encoded);
}
