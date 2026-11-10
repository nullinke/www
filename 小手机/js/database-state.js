/** IndexedDB is the canonical business store. localStorage remains a read-only migration source. */
export class StorageError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = 'StorageError'; }
}
export const NO_CHANGE = Symbol('no-change');
export const CHAT_KEY = 'echo-chat-state-v1';
export const DRAFTS_KEY = 'echo-chat-drafts-v2';
export const BUSINESS_KEYS = [CHAT_KEY, DRAFTS_KEY, 'echo-profile-v1', 'echo-memory-v1', 'echo-moments-v1', 'echo-couple-v1', 'echo-world-v1'];
export const IMAGE_FIELDS = { avatarData: 'avatarRef', coverImage: 'coverImageRef', replyCharAvatar: 'replyCharAvatarRef', authorAvatar: 'authorAvatarRef' };
const EVENTS = { [CHAT_KEY]: 'echo-chat-change', [DRAFTS_KEY]: 'echo-drafts-change', 'echo-profile-v1': 'echo-profile-change', 'echo-memory-v1': 'echo-memory-change', 'echo-moments-v1': 'echo-moments-change', 'echo-couple-v1': 'echo-couple-change', 'echo-world-v1': 'echo-world-change' };
let db = null, startup = null, channel = null;
let records = new Map(), assets = new Map(), tasks = new Map();
const windows = new Map();
let refreshTail = Promise.resolve();

export function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function transactionOn(database, stores, mode, run) {
  const tx = database.transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new DOMException('事务已取消', 'AbortError'));
    tx.onerror = () => { /* abort handler supplies the transaction error */ };
  });
  // Attach a rejection handler immediately, before issuing any requests.
  finished.catch(() => {});
  try { const result = await run(tx); await finished; return result; }
  catch (error) { try { tx.abort(); } catch { /* already finished */ } await finished.catch(() => {}); throw error; }
}
export async function transact(stores, run, changes = {}) {
  if (!db) throw new StorageError('数据尚未就绪，请刷新后重试。');
  let result;
  try { result = await transactionOn(db, stores, 'readwrite', run); }
  catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('保存未完成，事务已回滚，原有数据已保留。请检查浏览器存储空间或权限。', error);
  }
  if (result === NO_CHANGE) return;
  await refreshStorage(changes);
  notify(changes);
  channel?.postMessage(changes);
  return result;
}
export function database() {
  if (!db) throw new StorageError('数据尚未就绪。');
  return db;
}
export function isBusinessKey(key) { return BUSINESS_KEYS.includes(key); }
export function cachedRecord(key, fallback) {
  if (!db) throw new StorageError('数据尚未就绪。');
  const value = records.get(key);
  return value === undefined ? (typeof fallback === 'function' ? fallback() : structuredClone(fallback)) : structuredClone(value);
}
export function cachedTask(id) { return tasks.get(id) || null; }
export function cachedMessages(id) { return structuredClone(windows.get(id)?.rows || []); }
export function messageWindow(id) { return windows.get(id) || null; }
export function forgetMessages(id) { windows.delete(id); }
export function notify({ keys = [], conversationIds = [], tasksChanged = false } = {}) {
  const names = new Set(keys.map(key => EVENTS[key]).filter(Boolean));
  if (conversationIds.length || tasksChanged) names.add(EVENTS[CHAT_KEY]);
  for (const name of names) window.dispatchEvent(new CustomEvent(name));
}
function refs(value, result = new Set()) {
  if (Array.isArray(value)) value.forEach(item => refs(item, result));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (Object.values(IMAGE_FIELDS).includes(key) && typeof item === 'string') result.add(item);
      else refs(item, result);
    }
  }
  return result;
}
export function hydrate(value, source = assets) {
  if (Array.isArray(value)) return value.map(item => hydrate(item, source));
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hydrate(item, source)]));
  for (const [field, ref] of Object.entries(IMAGE_FIELDS)) {
    if (!copy[field] && copy[ref]) {
      const image = source.get(copy[ref]);
      if (image === undefined) throw new StorageError('图片引用缺失，已保留原记录，请从备份恢复。');
      copy[field] = image;
    }
  }
  return copy;
}
export function safeImage(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(value) ? value : '';
}
export function encodeImages(value, assetStore, dedup = new Map()) {
  if (Array.isArray(value)) return value.map(item => encodeImages(item, assetStore, dedup));
  if (!value || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeImages(item, assetStore, dedup)]));
  for (const [field, ref] of Object.entries(IMAGE_FIELDS)) {
    if (!Object.hasOwn(copy, field)) continue;
    const image = copy[field];
    if (!image) { delete copy[field]; delete copy[ref]; continue; }
    if (!safeImage(image)) throw new StorageError('图片格式无效，事务未提交。');
    let assetKey = dedup.get(image);
    if (!assetKey) { assetKey = 'echo-business-asset-v2.' + crypto.randomUUID(); dedup.set(image, assetKey); assetStore.put(image, assetKey); }
    copy[ref] = assetKey; delete copy[field];
  }
  return copy;
}
export async function hydrateInTransaction(value, tx, images = new Map()) {
  await Promise.all([...refs(value)].map(async key => { const image = await requestResult(tx.objectStore('assets').get(key)); if (image !== undefined) images.set(key, image); }));
  return hydrate(value, images);
}
export async function mutateRecord(key, fallback, mutator, eventKey = key) {
  if (!isBusinessKey(key)) throw new StorageError('未知业务数据键。');
  return transact(['records', 'assets'], async tx => {
    const store = tx.objectStore('records');
    const raw = await requestResult(store.get(key));
    const images = new Map();
    const value = await hydrateInTransaction(raw === undefined ? structuredClone(typeof fallback === 'function' ? fallback() : fallback) : raw, tx, images);
    const result = mutator(value);
    if (result && typeof result.then === 'function') throw new StorageError('事务内禁止异步业务回调。');
    if (result === NO_CHANGE) return NO_CHANGE;
    const next = result === undefined ? value : result;
    store.put(encodeImages(next, tx.objectStore('assets'), new Map([...images].map(([key, image]) => [image, key]))), key);
    return next;
  }, { keys: [eventKey] });
}
function validateLegacyRecord(key, value) {
  if (!value || typeof value !== 'object') throw new StorageError(`旧数据结构无效：${key}`);
  if (['echo-memory-v1', 'echo-moments-v1', 'echo-world-v1'].includes(key)) {
    if (!Array.isArray(value)) throw new StorageError(`旧数据列表无效：${key}`);
  } else if (Array.isArray(value)) throw new StorageError(`旧数据记录无效：${key}`);
  if (value.version !== undefined && value.version !== 1) throw new StorageError(`不支持的旧数据版本：${key}`);
  if (key === CHAT_KEY) {
    if (!Array.isArray(value.conversations) || !value.messagesByConversation || typeof value.messagesByConversation !== 'object' || Array.isArray(value.messagesByConversation)) throw new StorageError('聊天数据结构无效，旧数据未改动。');
    if (value.conversations.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string') || new Set(value.conversations.map(c => c.id)).size !== value.conversations.length) throw new StorageError('角色数据无效，旧数据未改动。');
    for (const rows of Object.values(value.messagesByConversation)) if (!Array.isArray(rows) || rows.some(m => !m || typeof m.text !== 'string' || typeof m.id !== 'string')) throw new StorageError('消息数据无效，旧数据未改动。');
  }
}
export function readLegacy(defaults = {}) {
  const snapshot = Object.create(null), parsed = new Map(), imageMap = new Map();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (BUSINESS_KEYS.includes(key) || /^echo-(business-asset-v2|conv-avatar-v1)\./.test(key)) snapshot[key] = localStorage.getItem(key);
    }
    for (const key of BUSINESS_KEYS) {
      if (snapshot[key] === undefined) { if (defaults[key] !== undefined) parsed.set(key, structuredClone(defaults[key])); continue; }
      const value = JSON.parse(snapshot[key]); validateLegacyRecord(key, value); parsed.set(key, value);
    }
    for (const [key, value] of Object.entries(snapshot)) if (/^echo-business-asset-v2\./.test(key)) {
      if (!safeImage(value)) throw new StorageError('旧图片资源无效。'); imageMap.set(key, value);
    }
    const chat = parsed.get(CHAT_KEY);
    if (chat) {
      for (const conv of chat.conversations) if (!conv.avatarData && !conv.avatarRef && snapshot['echo-conv-avatar-v1.' + conv.id]) conv.avatarData = snapshot['echo-conv-avatar-v1.' + conv.id];
      if (!parsed.has(DRAFTS_KEY)) parsed.set(DRAFTS_KEY, chat.drafts || {});
    }
    // Resolve every reference before the first transaction write.
    for (const [key, value] of parsed) parsed.set(key, hydrate(value, imageMap));
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('无法迁移旧数据，原始 localStorage 已保留，请检查备份或存储权限。', error);
  }
  return { snapshot, parsed };
}
export async function importBusiness(tx, values) {
  const store = tx.objectStore('records'), assetStore = tx.objectStore('assets');
  const dedup = new Map();
  const summary = { conversations: 0, messages: 0 };
  for (const [key, value] of values) {
    validateLegacyRecord(key, value);
    if (key !== CHAT_KEY) { store.put(encodeImages(value, assetStore, dedup), key); continue; }
    const { messagesByConversation, drafts, ...metadata } = value;
    const messageStore = tx.objectStore('messages');
    metadata.messageStats = Object.create(null);
    for (const [conversationId, rows] of Object.entries(messagesByConversation)) {
      let peerOrdinal = 0;
      rows.forEach((row, sequence) => {
        messageStore.put({ ...encodeImages(row, assetStore, dedup), conversationId, sequence, ...(row.author !== 'mine' ? { peerOrdinal: peerOrdinal++ } : {}) });
      });
      metadata.messageStats[conversationId] = { count: rows.length, nextSequence: rows.length, peerCount: peerOrdinal };
      summary.messages += rows.length;
    }
    store.put(encodeImages(metadata, assetStore, dedup), key);
    summary.conversations = metadata.conversations.length;
  }
  return summary;
}
function comparable(value, message = false) {
  if (Array.isArray(value)) return value.map(item => comparable(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !Object.values(IMAGE_FIELDS).includes(key) &&
    !(Object.hasOwn(IMAGE_FIELDS, key) && !value[key]) &&
    !(message && ['conversationId', 'sequence', 'peerOrdinal'].includes(key))
  ).map(key => [key, comparable(value[key])]));
}
export async function verifyImport(tx, values) {
  for (const [key, expected] of values) {
    const raw = await requestResult(tx.objectStore('records').get(key));
    const actual = await hydrateInTransaction(raw, tx);
    if (key === CHAT_KEY) {
      const rows = await requestResult(tx.objectStore('messages').getAll());
      const sourceRows = Object.values(expected.messagesByConversation).reduce((sum, list) => sum + list.length, 0);
      if (rows.length !== sourceRows) throw new StorageError('消息数量校验失败，未提交迁移或恢复。');
      const hydrated = await hydrateInTransaction(rows, tx);
      for (const [id, source] of Object.entries(expected.messagesByConversation)) {
        const target = hydrated.filter(row => row.conversationId === id);
        if (target.length !== source.length || target.some((row, index) => JSON.stringify(comparable(row, true)) !== JSON.stringify(comparable(source[index], true)))) throw new StorageError('消息内容校验失败，未提交迁移或恢复。');
      }
      const { messagesByConversation, drafts, messageStats, ...sourceMetadata } = expected;
      const { messageStats: ignored, ...targetMetadata } = actual;
      if (JSON.stringify(comparable(sourceMetadata)) !== JSON.stringify(comparable(targetMetadata))) throw new StorageError('会话内容校验失败，未提交迁移或恢复。');
    } else if (JSON.stringify(comparable(expected)) !== JSON.stringify(comparable(actual))) throw new StorageError('记录内容校验失败，未提交迁移或恢复。');
  }
}

export async function initializeStorage({ defaults = {}, name = 'echo-phone-v3' } = {}) {
  if (startup) return startup;
  startup = (async () => {
    if (!globalThis.indexedDB) throw new StorageError('浏览器未提供 IndexedDB，旧数据已保留，暂未启用写入。');
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      const database = open.result;
      database.createObjectStore('records'); database.createObjectStore('assets'); database.createObjectStore('meta'); database.createObjectStore('tasks', { keyPath: 'conversationId' });
      const messages = database.createObjectStore('messages', { keyPath: ['conversationId', 'sequence'] });
      messages.createIndex('byConversation', 'conversationId');
      messages.createIndex('byId', ['conversationId', 'id']);
      messages.createIndex('byTurn', ['conversationId', 'turnId']);
      messages.createIndex('byStatus', ['conversationId', 'status']);
    };
    open.onblocked = () => { /* an existing reader must close; no destructive upgrade fallback */ };
    db = await requestResult(open);
    db.onversionchange = () => { db?.close(); db = null; };
    try {
      const marker = await transactionOn(db, ['meta'], 'readonly', tx => requestResult(tx.objectStore('meta').get('migration')));
      if (!marker) {
        const legacy = readLegacy(defaults);
        // Competing tabs recheck inside a shared readwrite transaction before importing.
        await transactionOn(db, ['records', 'messages', 'assets', 'meta'], 'readwrite', async tx => {
          const meta = tx.objectStore('meta');
          if (await requestResult(meta.get('migration'))) return;
          const summary = await importBusiness(tx, legacy.parsed);
          await verifyImport(tx, legacy.parsed);
          const actual = await requestResult(tx.objectStore('messages').count());
          if (actual !== summary.messages) throw new StorageError('迁移校验失败，未切换数据来源。');
          meta.put({ capturedAt: new Date().toISOString(), data: legacy.snapshot }, 'legacySnapshot');
          meta.put({ version: 1, completedAt: new Date().toISOString(), ...summary }, 'migration');
        });
      } else if (marker.version !== 1) throw new StorageError('数据库版本不受支持，请更新应用。');
      await refreshStorage();
      if (typeof BroadcastChannel !== 'undefined' && typeof document !== 'undefined') {
        channel = new BroadcastChannel('echo-database-v3');
        channel.onmessage = async event => { try { await refreshStorage(event.data); notify(event.data); } catch (error) { window.dispatchEvent(new CustomEvent('echo-storage-error', { detail: error })); } };
      }
    } catch (error) { db.close(); db = null; throw error; }
  })();
  try { return await startup; }
  catch (error) { startup = null; if (error instanceof StorageError) throw error; throw new StorageError('数据库初始化失败，原始数据已保留。', error); }
}
export async function refreshStorage(changes = null) {
  const refresh = async () => {
    if (!db) return;
    const result = await transactionOn(db, ['records', 'messages', 'assets', 'tasks'], 'readonly', async tx => {
      const store = tx.objectStore('records');
      const [keys, values, leases] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll()), requestResult(tx.objectStore('tasks').getAll())]);
      const nextRecords = new Map(keys.map((key, index) => [key, values[index]]));
      const pages = new Map();
      for (const [id, page] of windows) {
        if (!changes || changes.reset || changes.conversationIds?.includes(id)) pages.set(id, await readPageInTransaction(tx, id, { limit: Math.max(100, page.rows.length) }));
      }
      const allPages = new Map([...windows, ...pages]);
      const needed = refs([...nextRecords.values(), ...[...allPages.values()].map(page => page.rows)]);
      const nextAssets = new Map();
      await Promise.all([...needed].map(async key => {
        const value = assets.has(key) ? assets.get(key) : await requestResult(tx.objectStore('assets').get(key));
        if (value === undefined) throw new StorageError('数据库图片引用不完整，请保留备份。');
        nextAssets.set(key, value);
      }));
      return { nextRecords, pages, nextAssets, leases };
    });
    records = result.nextRecords; assets = result.nextAssets; tasks = new Map(result.leases.map(lease => [lease.conversationId, lease]));
    for (const [id, page] of result.pages) windows.set(id, { ...page, rows: hydrate(page.rows) });
  };
  refreshTail = refreshTail.catch(() => {}).then(refresh);
  return refreshTail;
}
export async function readPageInTransaction(tx, id, { before = Infinity, limit = 100 } = {}) {
  const range = IDBKeyRange.bound([id, 0], [id, before], false, before !== Infinity);
  const rows = [];
  const result = await new Promise((resolve, reject) => {
    const request = tx.objectStore('messages').openCursor(range, 'prev');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) { resolve({ hasMore: Boolean(cursor) }); return; }
      rows.push(cursor.value); cursor.continue();
    };
  });
  rows.reverse();
  return { rows, hasMore: result.hasMore, before: rows[0]?.sequence ?? before };
}
export async function loadMessagePage(id, options = {}) {
  const snapshot = windows.get(id)?.rows || [];
  const requested = options.append && snapshot.length ? { ...options, before: snapshot[0].sequence } : options;
  const page = await transactionOn(database(), ['messages', 'assets'], 'readonly', async tx => {
    const value = await readPageInTransaction(tx, id, requested);
    return { ...value, rows: await hydrateInTransaction(value.rows, tx) };
  });
  if (options.append) {
    const previous = windows.get(id)?.rows || [];
    const bySequence = new Map([...page.rows, ...snapshot, ...previous].map(row => [row.sequence, row]));
    windows.set(id, { ...page, rows: [...bySequence.values()].sort((a, b) => a.sequence - b.sequence) });
  } else windows.set(id, page);
  return structuredClone(windows.get(id));
}
export async function exportBusiness() {
  return transactionOn(database(), ['records', 'messages', 'assets'], 'readonly', async tx => {
    const store = tx.objectStore('records');
    const [keys, values, rows] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll()), requestResult(tx.objectStore('messages').getAll())]);
    const all = new Map(keys.map((key, index) => [key, values[index]]));
    const chat = all.get(CHAT_KEY);
    if (chat) {
      chat.messagesByConversation = Object.create(null);
      for (const row of rows) { const { conversationId, sequence, ...message } = row; (chat.messagesByConversation[conversationId] ||= []).push(message); }
      chat.drafts = all.get(DRAFTS_KEY) || {};
      delete chat.messageStats;
    }
    const result = new Map();
    for (const [key, value] of all) result.set(key, await hydrateInTransaction(value, tx));
    // Inline images make the backup independent of resource keys and readable by the old format.
    function inline(value) {
      if (Array.isArray(value)) return value.map(inline);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => !Object.values(IMAGE_FIELDS).includes(key)).map(([key, item]) => [key, inline(item)]));
    }
    return new Map([...result].map(([key, value]) => [key, inline(value)]));
  });
}
export async function collectUnusedAssets({ signal, onProgress } = {}) {
  return transact(['records', 'messages', 'assets'], async tx => {
    const needed = new Set(); let scanned = 0, removed = 0;
    for (const storeName of ['records', 'messages']) {
      await new Promise((resolve, reject) => {
        const request = tx.objectStore(storeName).openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          try {
            signal?.throwIfAborted();
            const cursor = request.result;
            if (!cursor) { resolve(); return; }
            refs(cursor.value, needed); scanned++;
            if (scanned % 100 === 0) onProgress?.({ phase: storeName, scanned, removed });
            cursor.continue();
          } catch (error) { reject(error); }
        };
      });
    }
    await new Promise((resolve, reject) => {
      const request = tx.objectStore('assets').openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          signal?.throwIfAborted();
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          if (!needed.has(cursor.key)) { cursor.delete(); removed++; }
          onProgress?.({ phase: 'assets', scanned, removed }); cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    return removed;
  });
}
export function closeStorage() {
  channel?.close(); channel = null; db?.close(); db = null; startup = null;
  records = new Map(); assets = new Map(); tasks = new Map(); windows.clear(); refreshTail = Promise.resolve();
}
