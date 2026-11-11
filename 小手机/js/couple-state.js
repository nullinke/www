import { cachedRecord, CHAT_KEY, requestResult, transact, StorageError } from './database-state.js';
import { subscribe } from './storage-state.js';
const KEY = 'echo-couple-v1';
export const DEFAULT_AUTOMATION = { autoMessages: false, autoMoments: false, intervalMinutes: 30, includeImages: false, showThoughts: true, summarizeRounds: 10 };
export function loadCouple() { return { ...DEFAULT_AUTOMATION, ...cachedRecord(KEY, {}) }; }
export function setCoupleCharacter(charId) {
  return transact(['records'], async tx => {
    const store = tx.objectStore('records'), chat = await requestResult(store.get(CHAT_KEY));
    if (charId !== null && !chat?.conversations.some(character => character.id === charId && character.avatar !== 'group')) throw new StorageError('角色已不存在，请重新选择。');
    const current = await requestResult(store.get(KEY)) || {};
    store.put({ ...current, charId }, KEY);
  }, { keys: [KEY] });
}
export function updateCoupleSettings(patch) {
  return transact(['records'], async tx => {
    const store = tx.objectStore('records'), current = await requestResult(store.get(KEY)) || {};
    const next = { ...DEFAULT_AUTOMATION, ...current, ...patch };
    next.intervalMinutes = Math.min(1440, Math.max(5, Number(next.intervalMinutes) || 30));
    next.summarizeRounds = Math.min(100, Math.max(1, Number(next.summarizeRounds) || 10));
    store.put(next, KEY);
  }, { keys: [KEY] });
}
export function subscribeToCouple(handler) { return subscribe(KEY, 'echo-couple-change', handler, loadCouple); }
