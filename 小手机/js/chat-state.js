import { subscribe, uniqueId } from './storage-state.js';
import {
  CHAT_KEY, DRAFTS_KEY, StorageError, cachedRecord, cachedMessages, cachedTask, hydrate,
  transact, transactionOn, database, requestResult, encodeImages, hydrateInTransaction,
} from './database-state.js';

const DEFAULT_STATE = {
  version: 1,
  activeConversationId: 'nereus',
  conversations: [
    {
      id: 'nereus',
      name: 'Nereus',
      initial: 'N',
      avatar: 'peer',
      status: '在线',
      preview: '今天海边的风很轻，想到你了',
      time: '21:47',
      unread: true,
    },
    {
      id: 'momo',
      name: 'Momo',
      initial: 'M',
      avatar: 'mine',
      status: '在线',
      preview: '新买的唱片到了，周末来听',
      time: '19:02',
      unread: false,
    },
    {
      id: 'group',
      name: '潮汐小屋',
      initial: '群',
      avatar: 'group',
      status: '3 人在线',
      preview: 'Momo：今晚一起听歌吗',
      time: '昨天',
      unread: false,
    },
  ],
  messagesByConversation: {
    nereus: [
      { id: 'nereus-1', author: 'peer', text: '今天海边的风很轻，想到你了', time: '21:32' },
      { id: 'nereus-2', author: 'peer', text: '就把今天的晚霞装进瓶子里，放在窗台上了', time: '21:32' },
      { id: 'nereus-3', author: 'mine', text: '那我明天来取，顺便带刚烤好的饼干', time: '21:47' },
      { id: 'nereus-4', author: 'peer', text: '好，我等你 (≧▽≦)', time: '21:47' },
    ],
    momo: [
      { id: 'momo-1', author: 'peer', text: '新买的唱片到了，周末来听', time: '19:02' },
    ],
    group: [
      { id: 'group-1', author: 'peer', text: '今晚一起听歌吗', time: '昨天' },
    ],
  },
  drafts: {},
  updatedAt: 0,
};

export function defaultChatState() { return structuredClone(DEFAULT_STATE); }
export function loadChatState() {
  const state = hydrate(cachedRecord(CHAT_KEY, { ...defaultChatState(), messagesByConversation: undefined }));
  state.drafts = cachedRecord(DRAFTS_KEY, state.drafts || {});
  state.messagesByConversation = Object.fromEntries(state.conversations.map(c => [c.id, cachedMessages(c.id)]));
  return state;
}
export function getConversation(id, state = loadChatState()) { return state.conversations.find(c => c.id === id) || null; }
export function getMessages(id) { return cachedMessages(id); }
export { loadMessagePage, messageWindow, forgetMessages } from './database-state.js';

async function mutation(id, run, changes = {}) {
  return transact(['records', 'messages', 'assets', 'tasks'], async tx => {
    const metadata = await requestResult(tx.objectStore('records').get(CHAT_KEY));
    if (!metadata) throw new StorageError('会话数据尚未初始化。');
    if (id && !metadata.conversations.some(c => c.id === id)) throw new StorageError('会话已被删除。');
    const result = await run(tx, metadata);
    metadata.updatedAt = Date.now(); metadata.revision = (metadata.revision || 0) + 1;
    tx.objectStore('records').put(encodeImages(metadata, tx.objectStore('assets')), CHAT_KEY);
    return result;
  }, { keys: [CHAT_KEY], conversationIds: id ? [id] : [], ...changes });
}
function stats(meta, id) { return (meta.messageStats ||= {})[id] ||= { count: 0, nextSequence: 0, peerCount: 0 }; }
function messageEntry(id, message) {
  return {
    ...message, id: message.id || uniqueId('message-'), conversationId: id,
    author: message.author === 'mine' ? 'mine' : 'peer', text: String(message.text || '').trim(),
    time: message.time || new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
  };
}
async function assertOwner(tx, id, owner) {
  if (!owner) return;
  const lease = await requestResult(tx.objectStore('tasks').get(id));
  if (lease?.owner !== owner) throw new StorageError('回复任务已失效，已阻止过期结果写入。');
}
async function preview(tx, metadata, id) {
  const conversation = metadata.conversations.find(c => c.id === id);
  if (!conversation) return;
  const last = await new Promise((resolve, reject) => {
    const request = tx.objectStore('messages').index('byConversation').openCursor(IDBKeyRange.only(id), 'prev');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(null); return; }
      if (['pending', 'failed', 'cancelled', 'interrupted'].includes(cursor.value.status)) cursor.continue();
      else resolve(cursor.value);
    };
  });
  conversation.preview = last?.text || ''; conversation.time = last?.time || '';
}
export async function createConversation(input) {
  const entry = { avatar: 'peer', status: '在线', preview: '', time: '', unread: false, ...input, id: uniqueId(input.avatar === 'group' ? 'group-' : 'char-') };
  if (!entry.name?.trim()) throw new StorageError('请填写角色或群聊名称。');
  entry.name = entry.name.trim(); entry.initial = entry.name.charAt(0).toUpperCase();
  await mutation(null, (_tx, metadata) => {
    metadata.conversations.push(entry); metadata.activeConversationId = entry.id; stats(metadata, entry.id);
  });
  return entry;
}
export function updateConversation(id, patch) {
  return mutation(id, (_tx, metadata) => {
    const conversation = metadata.conversations.find(c => c.id === id);
    const { archive, ...rest } = patch;
    Object.assign(conversation, rest, { id });
    if (archive) conversation.archive = { ...conversation.archive, ...archive };
    if (patch.name !== undefined) conversation.initial = String(patch.name).charAt(0).toUpperCase();
  });
}
export function setActiveConversation(id) {
  return mutation(id, (_tx, meta) => { meta.activeConversationId = id; });
}
export function markConversationRead(id) {
  return mutation(id, (_tx, meta) => { meta.conversations.find(c => c.id === id).unread = false; });
}
export function setDraft(id, text) {
  return transact(['records'], async tx => {
    const recordStore = tx.objectStore('records');
    const metadata = await requestResult(recordStore.get(CHAT_KEY));
    if (!metadata?.conversations.some(c => c.id === id)) throw new StorageError('会话已被删除。');
    const drafts = await requestResult(recordStore.get(DRAFTS_KEY)) || {};
    if (text) drafts[id] = text; else delete drafts[id];
    recordStore.put(drafts, DRAFTS_KEY);
  }, { keys: [DRAFTS_KEY] });
}
export function appendMessage(id, message, { owner } = {}) {
  return mutation(id, async (tx, metadata) => {
    await assertOwner(tx, id, owner);
    const store = tx.objectStore('messages'), counter = stats(metadata, id);
    const entry = messageEntry(id, message);
    if (owner && entry.replyCharId && !metadata.conversations.some(c => c.id === entry.replyCharId)) throw new StorageError('回复角色已被删除。');
    if (await requestResult(store.index('byId').getKey([id, entry.id]))) throw new StorageError('消息 ID 已存在，未重复写入。');
    entry.sequence = counter.nextSequence++;
    if (entry.author !== 'mine') entry.peerOrdinal = counter.peerCount++;
    counter.count++;
    store.add(encodeImages(entry, tx.objectStore('assets')));
    await preview(tx, metadata, id);
    metadata.conversations.find(c => c.id === id).unread = false;
    return entry;
  });
}
export function updateMessage(id, messageId, patch, { owner } = {}) {
  return mutation(id, async (tx, metadata) => {
    await assertOwner(tx, id, owner);
    const store = tx.objectStore('messages');
    const current = await requestResult(store.index('byId').get([id, messageId]));
    if (!current) throw new StorageError('消息已不存在。');
    const next = { ...current, ...patch, id: messageId, conversationId: id, sequence: current.sequence };
    store.put(encodeImages(next, tx.objectStore('assets')));
    await preview(tx, metadata, id);
  });
}
export function deleteMessage(id, messageId) {
  return mutation(id, async (tx, metadata) => {
    const store = tx.objectStore('messages');
    const key = await requestResult(store.index('byId').getKey([id, messageId]));
    if (key) { store.delete(key); stats(metadata, id).count--; }
    await preview(tx, metadata, id);
  });
}
export function deleteConversation(id) {
  return mutation(id, async (tx, metadata) => {
    metadata.conversations = metadata.conversations.filter(c => c.id !== id);
    for (const c of metadata.conversations) if (Array.isArray(c.members)) c.members = c.members.filter(member => member !== id);
    if (metadata.activeConversationId === id) metadata.activeConversationId = metadata.conversations[0]?.id || null;
    delete metadata.messageStats[id];
    tx.objectStore('messages').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    tx.objectStore('tasks').delete(id);
    const store = tx.objectStore('records');
    const drafts = await requestResult(store.get(DRAFTS_KEY)) || {}; delete drafts[id]; store.put(drafts, DRAFTS_KEY);
    const couple = await requestResult(store.get('echo-couple-v1'));
    if (couple?.charId === id) store.put({ ...couple, charId: null }, 'echo-couple-v1');
  }, { keys: [CHAT_KEY, DRAFTS_KEY, 'echo-couple-v1'], tasksChanged: true });
}
export async function loadReplyHistory(id, { message = null, maxChars = 68000 } = {}) {
  return transactionOn(database(), ['messages', 'assets'], 'readonly', async tx => {
    const store = tx.objectStore('messages');
    let before = Infinity;
    if (message) {
      const selected = message.turnId ? await requestResult(store.index('byTurn').getAll([id, message.turnId])) : [await requestResult(store.index('byId').get([id, message.id]))].filter(Boolean);
      if (!selected.length) throw new StorageError('原回复已不存在。');
      before = Math.min(...selected.map(row => row.sequence));
    }
    const rows = []; let characters = 0;
    await new Promise((resolve, reject) => {
      const request = store.openCursor(IDBKeyRange.bound([id, 0], [id, before], false, before !== Infinity), 'prev');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || characters >= maxChars) { resolve(); return; }
        rows.push(cursor.value); characters += cursor.value.text.length; cursor.continue();
      };
    });
    return hydrateInTransaction(rows.reverse(), tx);
  });
}
export function replaceReplyTurn(id, turnId, entries, legacyMessageId = null, { owner } = {}) {
  return mutation(id, async (tx, metadata) => {
    await assertOwner(tx, id, owner);
    if (owner && entries.some(entry => entry.replyCharId && !metadata.conversations.some(c => c.id === entry.replyCharId))) throw new StorageError('回复角色已被删除，未写入过期结果。');
    const store = tx.objectStore('messages');
    const selected = await requestResult(store.index('byTurn').getAll([id, turnId]));
    if (legacyMessageId) {
      const legacy = await requestResult(store.index('byId').get([id, legacyMessageId]));
      if (legacy && !selected.some(m => m.sequence === legacy.sequence)) selected.push(legacy);
    }
    const targets = selected.filter(row => row.author !== 'mine');
    if (!targets.length) throw new StorageError('回复占位或原回复已不存在。');
    const start = Math.min(...targets.map(row => row.sequence));
    const tailCount = await requestResult(store.count(IDBKeyRange.bound([id, start], [id, Infinity])));
    const counter = stats(metadata, id);
    if (tailCount === targets.length) {
      for (const row of targets) store.delete([id, row.sequence]);
      entries.forEach((entry, index) => store.put({ ...encodeImages(messageEntry(id, entry), tx.objectStore('assets')), sequence: start + index }));
      counter.nextSequence = start + entries.length;
    } else {
      // Regenerating an earlier turn is infrequent; preserve subsequent messages by renumbering only this conversation.
      const rows = await requestResult(store.index('byConversation').getAll(id));
      const targetSequences = new Set(targets.map(row => row.sequence));
      const first = rows.findIndex(row => targetSequences.has(row.sequence));
      const next = rows.filter(row => !targetSequences.has(row.sequence));
      next.splice(first, 0, ...entries.map(entry => messageEntry(id, entry)));
      store.delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
      next.forEach((entry, sequence) => store.put({ ...encodeImages(entry, tx.objectStore('assets')), sequence, conversationId: id }));
      counter.nextSequence = next.length;
    }
    counter.count += entries.length - targets.length;
    await preview(tx, metadata, id);
  });
}
export function subscribeToChatState(handler) { return subscribe(CHAT_KEY, 'echo-chat-change', handler, loadChatState); }
export function currentReplyTask(id) { return cachedTask(id); }

export async function recoverReplyTask(id) {
  const recover = async hasLock => {
    const current = cachedTask(id);
    if (current && current.expiresAt > Date.now() && !(hasLock && current.mode === 'web-lock')) return;
    await mutation(id, async (tx, meta) => {
      const task = await requestResult(tx.objectStore('tasks').get(id));
      if (task && task.expiresAt > Date.now() && !(hasLock && task.mode === 'web-lock')) return;
      tx.objectStore('tasks').delete(id);
      const pending = await requestResult(tx.objectStore('messages').index('byStatus').getAll([id, 'pending']));
      for (const row of pending) tx.objectStore('messages').put({ ...row, text: '⚠ 回复已中断，可重新生成', status: 'interrupted' });
      await preview(tx, meta, id);
    }, { tasksChanged: true });
  };
  if (globalThis.navigator?.locks) return navigator.locks.request('echo-reply:' + id, { ifAvailable: true }, lock => lock ? recover(true) : undefined);
  return recover(false);
}

/** A browser lock handles crash recovery; a persisted owner token fences every reply commit. */
export async function withReplyTask(id, { signal } = {}, run) {
  const execute = async hasBrowserLock => {
    const owner = uniqueId('task-');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let heartbeat;
    try {
      controller.signal.throwIfAborted();
      await mutation(id, async (tx, metadata) => {
        const taskStore = tx.objectStore('tasks');
        const existing = await requestResult(taskStore.get(id));
        if (existing && existing.expiresAt > Date.now() && !(hasBrowserLock && existing.mode === 'web-lock')) throw new StorageError('这个会话正在另一个标签页回复，请稍后再试。');
        taskStore.put({ conversationId: id, owner, mode: hasBrowserLock ? 'web-lock' : 'lease', expiresAt: Date.now() + 120000 });
        const pending = await requestResult(tx.objectStore('messages').index('byStatus').getAll([id, 'pending']));
        for (const row of pending) tx.objectStore('messages').put({ ...row, status: 'interrupted', text: '⚠ 回复已中断，可重新生成' });
        await preview(tx, metadata, id);
      }, { tasksChanged: true });
      heartbeat = setInterval(() => {
        void transact(['tasks'], async tx => {
          const store = tx.objectStore('tasks'), current = await requestResult(store.get(id));
          if (current?.owner !== owner) { controller.abort(); return; }
          store.put({ ...current, expiresAt: Date.now() + 120000 });
        }, { tasksChanged: true }).catch(() => controller.abort());
      }, 15000);
      return await run({ owner, signal: controller.signal });
    } finally {
      clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
      try {
        await transact(['tasks', 'messages'], async tx => {
          const store = tx.objectStore('tasks');
          if ((await requestResult(store.get(id)))?.owner !== owner) return;
          store.delete(id);
          const pending = await requestResult(tx.objectStore('messages').index('byStatus').getAll([id, 'pending']));
          for (const row of pending) tx.objectStore('messages').put({ ...row, status: 'interrupted', text: '⚠ 回复已中断，可重新生成' });
        }, { tasksChanged: true, conversationIds: [id] });
      } catch (error) { console.warn('回复任务清理未完成：', error.message); }
    }
  };
  if (globalThis.navigator?.locks) return navigator.locks.request('echo-reply:' + id, { ifAvailable: true }, lock => {
    if (!lock) throw new StorageError('这个会话正在另一个标签页回复，请稍后再试。');
    return execute(true);
  });
  return execute(false);
}
export { CHAT_KEY as STORAGE_KEY };
