import { mutateRecord, NO_CHANGE, transact, requestResult, CHAT_KEY } from './database-state.js';
import { readJson, subscribe } from './storage-state.js';
// echo-memory-v1 数据格式：
// { id: number, content: string, source: 'user'|'system', createdAt: ISO string, tags: string[] }

const STORAGE_KEY = 'echo-memory-v1';

function loadRaw() {
  const value = readJson(STORAGE_KEY, []);
  if (!Array.isArray(value)) throw new Error('记忆数据无效，请先备份。');
  return value;
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const id = Number(item.id) || (Date.now() + Math.random());
  const content = String(item.content || '').trim();
  if (!content) return null;
  return {
    id,
    content,
    source: item.source === 'system' ? 'system' : 'user',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    conversationId: String(item.conversationId || ''),
    charId: String(item.charId || ''),
    turnId: String(item.turnId || ''),
    sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds.map(String) : [],
  };
}

export function loadMemories() {
  return loadRaw().map(normalizeItem).filter(Boolean);
}

export function saveMemory(item) {
  const normalized = normalizeItem({ ...item, id: item.id || Date.now() + Math.random() });
  if (!normalized) return Promise.resolve();
  return mutateRecord(STORAGE_KEY, [], raw => {
    const list = raw.map(normalizeItem).filter(Boolean);
    if (list.some(m => m.content === normalized.content && m.charId === normalized.charId)) return NO_CHANGE;
    const index = list.findIndex(m => m.id === normalized.id);
    if (index >= 0) list[index] = normalized; else list.unshift(normalized);
    return list;
  });
}

export function deleteMemory(id) {
  return mutateRecord(STORAGE_KEY, [], raw => raw.map(normalizeItem).filter(m => m && m.id !== Number(id)));
}

// 搜索 + tag 筛选（均为可选）
// filterTag: '' | 'promise' | 'event' | 'hobby'（对应中文标签）
export function filterMemories(query = '', filterTag = '') {
  const TAG_MAP = { promise: '约定', event: '事件', hobby: '喜好' };
  const tagZh = TAG_MAP[filterTag] || '';
  const q = query.trim().toLowerCase();
  return loadMemories().filter((m) => {
    const matchTag = !tagZh || m.tags.includes(tagZh);
    const matchQuery = !q || m.content.toLowerCase().includes(q);
    return matchTag && matchQuery;
  });
}

// 格式化 createdAt → 显示用字符串
export function formatMemoryDate(isoStr) {
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7)  return `${diffDays} 天前`;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  } catch {
    return '';
  }
}

export function subscribeToMemories(handler) {
  return subscribe(STORAGE_KEY, 'echo-memory-change', handler, loadMemories);
}

export { STORAGE_KEY };

/** Late extraction may only attach to the exact completed reply that still exists. */
export function saveExtractedMemories({ conversationId, charId, turnId, sourceMessageIds, items }) {
  if (!sourceMessageIds?.length) return Promise.resolve();
  return transact(['records', 'messages'], async tx => {
    const store = tx.objectStore('records');
    const meta = await requestResult(store.get(CHAT_KEY));
    if (!meta?.conversations.some(c => c.id === conversationId) || !meta.conversations.some(c => c.id === charId)) return NO_CHANGE;
    const rows = await requestResult(tx.objectStore('messages').index('byTurn').getAll([conversationId, turnId]));
    const completed = rows.filter(row => row.status === 'complete' && row.replyCharId === charId);
    if (completed.length !== sourceMessageIds.length || !completed.every(row => sourceMessageIds.includes(row.id))) return NO_CHANGE;
    const list = (await requestResult(store.get(STORAGE_KEY)) || []).map(normalizeItem).filter(Boolean);
    let changed = false;
    for (const item of items.slice(0, 3)) {
      if (typeof item?.content !== 'string' || !item.content.trim()) continue;
      const value = normalizeItem({ id: Date.now() + Math.random(), content: item.content.trim().slice(0, 200), tags: Array.isArray(item.tags) ? item.tags.filter(tag => ['约定','事件','喜好','羁绊'].includes(tag)).slice(0, 4) : [], source: 'system', conversationId, charId, turnId, sourceMessageIds });
      if (list.some(existing => existing.charId === charId && existing.content === value.content)) continue;
      list.unshift(value); changed = true;
    }
    if (!changed) return NO_CHANGE;
    store.put(list, STORAGE_KEY);
  }, { keys: [STORAGE_KEY] });
}
