import { mutateRecord, NO_CHANGE } from './database-state.js';
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
