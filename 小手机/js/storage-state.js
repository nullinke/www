import { assertPlainData } from './data-validation.js';
import {
  StorageError, isBusinessKey, cachedRecord, hydrate, mutateRecord,
  exportBusiness, database, transact, importBusiness, verifyImport, requestResult,
} from './database-state.js';
export { StorageError, safeImage, initializeStorage, closeStorage } from './database-state.js';

export function readJson(key, fallback) {
  if (isBusinessKey(key)) return cachedRecord(key, fallback);
  let raw;
  try { raw = localStorage.getItem(key); }
  catch (error) { throw new StorageError('无法读取本地设置，请检查存储权限。', error); }
  if (raw === null) return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
  try { return JSON.parse(raw); }
  catch (error) { throw new StorageError(`本地设置损坏（${key}），原始内容已保留。`, error); }
}
export function writeJson(key, value, eventName) {
  if (isBusinessKey(key)) return mutateRecord(key, null, () => value);
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (error) { throw new StorageError('设置保存失败，原有数据已保留。', error); }
  if (eventName) window.dispatchEvent(new CustomEvent(eventName));
  return value;
}
export function writeImageRecord(key, value) { return mutateRecord(key, null, () => value); }
export function hydrateImages(value) { return hydrate(value); }
export function subscribe(key, eventName, handler, load) {
  const custom = () => handler(load());
  const storage = event => { if (!isBusinessKey(key) && (event.key === key || event.key === null)) custom(); };
  window.addEventListener(eventName, custom); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, custom); window.removeEventListener('storage', storage); };
}
export function uniqueId(prefix = '') { return prefix + crypto.randomUUID(); }
const BACKUP_KEYS = /^(?:echo-(?:chat-state|profile|settings|memory|moments|couple|world)-v1|echo-chat-drafts-v2|echo-business-asset-v2\.[\w-]+|echo-conv-avatar-v1\.[^\u0000-\u001f]+|echo-theme-assets-v1\.[\w.-]+)$/;
function localBackup() {
  const data = {}, warnings = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== 'echo-settings-v1' && !key?.startsWith('echo-theme-assets-v1.')) continue;
    let value = localStorage.getItem(key);
    if (key === 'echo-settings-v1') {
      let settings;
      try { settings = JSON.parse(value); if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings'); }
      catch { warnings.push('设置损坏，未导出该项，避免包含未脱敏凭据。'); continue; }
      for (const model of Object.values(settings.models || {})) if (model && typeof model === 'object') model.apiKey = '';
      value = JSON.stringify(settings);
    }
    data[key] = value;
  }
  return { data, warnings };
}
export async function createBackup() {
  const { data, warnings } = localBackup();
  for (const [key, value] of await exportBusiness()) data[key] = JSON.stringify(value);
  return { format: 'echo-backup', version: 1, storage: 'indexeddb-v1', createdAt: new Date().toISOString(), credentialsIncluded: false, warnings, data };
}
function prepareBackup(backup) {
  try { assertPlainData(backup); } catch (error) { throw new StorageError('备份校验失败：' + error.message, error); }
  if (backup?.format !== 'echo-backup' || backup.version !== 1 || !backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) throw new StorageError('备份格式不正确。');
  const entries = Object.entries(backup.data);
  if (entries.length > 10000 || entries.some(([key, value]) => !BACKUP_KEYS.test(key) || typeof value !== 'string')) throw new StorageError('备份包含无效数据。');
  const business = new Map(), images = new Map(), local = new Map();
  for (const [key, raw] of entries) {
    if (isBusinessKey(key)) { business.set(key, JSON.parse(raw)); continue; }
    if (/^echo-(business-asset-v2|conv-avatar-v1)\./.test(key)) {
      if (!/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(raw)) throw new StorageError('备份图片无效。');
      images.set(key, raw); continue;
    }
    let value = raw;
    if (key === 'echo-settings-v1') {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.version !== undefined && parsed.version !== 1)) throw new StorageError('设置备份无效。');
      const current = readJson(key, {});
      for (const [type, model] of Object.entries(parsed.models || {})) if (model && typeof model === 'object') {
        const existing = current.models?.[type]; model.apiKey = existing?.baseUrl === model.baseUrl ? existing?.apiKey || '' : '';
      }
      value = JSON.stringify(parsed);
    } else if (key === 'echo-theme-assets-v1.customFontName') {
      if (raw.length > 500) throw new StorageError('字体文件名无效。');
    } else if (key === 'echo-theme-assets-v1.customFont') {
      if (!/^data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(raw)) throw new StorageError('字体备份无效。');
    } else if (!/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(raw)) throw new StorageError('主题图片无效。');
    local.set(key, value);
  }
  const chat = business.get('echo-chat-state-v1');
  if (chat && !business.has('echo-chat-drafts-v2')) business.set('echo-chat-drafts-v2', chat.drafts || {});
  if (chat?.conversations) for (const conv of chat.conversations) {
    if (!conv.avatarData && !conv.avatarRef && images.has('echo-conv-avatar-v1.' + conv.id)) conv.avatarData = images.get('echo-conv-avatar-v1.' + conv.id);
  }
  for (const [key, value] of business) business.set(key, hydrate(value, images));
  return { business, local };
}
export async function restoreBackup(backup) {
  const { business, local } = prepareBackup(backup);
  const previous = new Map([...local.keys()].map(key => [key, localStorage.getItem(key)]));
  // Validate business schema in an aborted transaction before touching settings/theme storage.
  const validation = database().transaction(['records', 'messages', 'assets'], 'readwrite');
  const validationDone = new Promise(resolve => { validation.onabort = resolve; validation.oncomplete = resolve; });
  try {
    if (business.has('echo-chat-state-v1')) validation.objectStore('messages').clear();
    await importBusiness(validation, business); await verifyImport(validation, business);
  } finally { try { validation.abort(); } catch { /* already aborted */ } await validationDone; }
  try {
    for (const [key, value] of local) localStorage.setItem(key, value);
    await transact(['records', 'messages', 'assets', 'tasks'], async tx => {
      if (business.has('echo-chat-state-v1')) { tx.objectStore('messages').clear(); tx.objectStore('tasks').clear(); }
      await importBusiness(tx, business); await verifyImport(tx, business);
    }, { keys: [...business.keys()], tasksChanged: true, reset: business.has('echo-chat-state-v1') });
  } catch (error) {
    let rollbackFailed = false;
    for (const [key, value] of previous) {
      try { if (localStorage.getItem(key) === value) continue; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
      catch { rollbackFailed = true; }
    }
    throw new StorageError(rollbackFailed ? '恢复失败，业务事务已回滚；部分设置未能恢复，请保留备份文件。' : '恢复失败，原有业务数据已保留，设置已回滚。', error);
  }
}
/** Recover the original migration snapshot as a portable backup without deleting the live database. */
export async function migrationBackup() {
  const tx = database().transaction(['meta'], 'readonly');
  const snapshot = await requestResult(tx.objectStore('meta').get('legacySnapshot'));
  return { format: 'echo-backup', version: 1, credentialsIncluded: false, data: snapshot?.data || {}, createdAt: snapshot?.capturedAt };
}
