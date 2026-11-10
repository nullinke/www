import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
class MemoryStorage {
  values = new Map(); failure = null;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failure?.(key, value)) throw new DOMException('full', 'QuotaExceededError'); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); this.failure = null; }
}
const storage = new MemoryStorage();
Object.assign(globalThis, { indexedDB, IDBKeyRange, localStorage: storage, window: new EventTarget() });
window.localStorage = storage;
const chat = await import('../js/chat-state.js');
const profile = await import('../js/profile-state.js');
const settings = await import('../js/settings-state.js');
const memory = await import('../js/memory-state.js');
const moments = await import('../js/moments-state.js');
const persistence = await import('../js/storage-state.js');
const dbState = await import('../js/database-state.js');
const api = await import('../js/api.js');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
let name;
const originalPut = IDBObjectStore.prototype.put;
async function boot(legacy) {
  dbState.closeStorage(); name = 'test-' + crypto.randomUUID();
  if (legacy) for (const [key, value] of Object.entries(legacy)) storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  await persistence.initializeStorage({ name, defaults: { 'echo-chat-state-v1': chat.defaultChatState() } });
}
async function allMessages(id) { return (await dbState.exportBusiness()).get('echo-chat-state-v1').messagesByConversation[id] || []; }
async function record(key) { return dbState.transactionOn(dbState.database(), ['records'], 'readonly', tx => dbState.requestResult(tx.objectStore('records').get(key))); }
beforeEach(async () => { storage.clear(); await boot(); });
afterEach(() => { IDBObjectStore.prototype.put = originalPut; dbState.closeStorage(); });

test('first creation commits without a previous stored state and IDs remain unique', async () => {
  const created = await chat.createConversation({ name: 'First' });
  assert.equal(chat.getConversation(created.id).name, 'First');
  assert.notEqual((await chat.createConversation({ name: 'First' })).id, created.id);
  assert.equal(storage.getItem('echo-chat-state-v1'), null);
});

test('legacy data, old separate avatars, new image references, drafts and unknown fields migrate without changing the source', async () => {
  storage.clear(); const old = chat.defaultChatState();
  old.conversations[0].customField = 'preserve'; old.conversations[1].avatarRef = 'echo-business-asset-v2.old';
  old.messagesByConversation.nereus[0].custom = { keep: true }; old.drafts.nereus = 'draft';
  await boot({ 'echo-chat-state-v1': old, 'echo-conv-avatar-v1.nereus': image, 'echo-business-asset-v2.old': image, 'echo-profile-v1': { nickname: 'Old', archive: { hobbies: 'reading' }, coverImage: image } });
  const snapshot = new Map(storage.values);
  const backup = await persistence.createBackup();
  const migrated = JSON.parse(backup.data['echo-chat-state-v1']);
  assert.equal(migrated.conversations[0].customField, 'preserve');
  assert.equal(migrated.conversations[0].avatarData, image); assert.equal(migrated.conversations[1].avatarData, image);
  assert.deepEqual(migrated.messagesByConversation.nereus[0].custom, { keep: true });
  assert.equal(chat.loadChatState().drafts.nereus, 'draft');
  assert.deepEqual(storage.values, snapshot);
  const initial = await persistence.migrationBackup();
  assert.equal(initial.data['echo-chat-state-v1'], storage.getItem('echo-chat-state-v1'));
});

test('a completed migration is not replayed on reload', async () => {
  await chat.appendMessage('nereus', { author: 'mine', text: 'after migration' });
  dbState.closeStorage();
  storage.setItem('echo-chat-state-v1', '{old broken value ignored after migration}');
  await persistence.initializeStorage({ name });
  assert.equal((await allMessages('nereus')).at(-1).text, 'after migration');
});

test('a failed migration leaves no marker or partial records and retries safely', async () => {
  dbState.closeStorage(); storage.clear(); name = 'test-' + crypto.randomUUID();
  const old = chat.defaultChatState(); storage.setItem('echo-chat-state-v1', JSON.stringify(old));
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'messages') throw new DOMException('full', 'QuotaExceededError'); return originalPut.apply(this, args); };
  await assert.rejects(persistence.initializeStorage({ name }));
  assert.equal(storage.getItem('echo-chat-state-v1'), JSON.stringify(old));
  IDBObjectStore.prototype.put = originalPut;
  await persistence.initializeStorage({ name });
  assert.equal((await allMessages('nereus')).length, 4);
});

test('corrupt and unsupported legacy data is never replaced by demo content', async () => {
  for (const raw of ['{broken', JSON.stringify({ version: 99, conversations: [], messagesByConversation: {} })]) {
    dbState.closeStorage(); storage.clear(); name = 'test-' + crypto.randomUUID(); storage.setItem('echo-chat-state-v1', raw);
    await assert.rejects(persistence.initializeStorage({ name }), persistence.StorageError);
    assert.equal(storage.getItem('echo-chat-state-v1'), raw);
  }
});

test('business writes survive exhausted localStorage, while actual IDB failure rolls back and emits no success', async () => {
  storage.failure = () => true;
  await chat.appendMessage('nereus', { author: 'mine', text: 'IDB survives' });
  assert.equal((await allMessages('nereus')).at(-1).text, 'IDB survives');
  let success = 0; const off = chat.subscribeToChatState(() => success++);
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'records') throw new DOMException('full', 'QuotaExceededError'); return originalPut.apply(this, args); };
  await assert.rejects(chat.appendMessage('nereus', { author: 'mine', text: 'must roll back' }), persistence.StorageError);
  assert.equal((await allMessages('nereus')).at(-1).text, 'IDB survives'); assert.equal(success, 0); off();
});

test('concurrent appends and profile patches do not overwrite each other', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, index) => chat.appendMessage('nereus', { author: 'mine', text: 'parallel-' + index })));
  assert.equal((await allMessages('nereus')).filter(m => m.text.startsWith('parallel-')).length, 20);
  await Promise.all([profile.updateProfile({ nickname: 'New' }), profile.updateProfile({ archive: { hobbies: 'reading' } })]);
  assert.equal(profile.loadProfile().nickname, 'New'); assert.equal(profile.loadProfile().archive.hobbies, 'reading');
});

test('image references remain reusable; explicit collection deletes only orphaned assets', async () => {
  await profile.updateProfile({ avatarData: image, coverImage: image });
  const before = await record(profile.STORAGE_KEY);
  assert.equal(before.avatarData, undefined);
  await profile.updateProfile({ nickname: 'New' });
  const after = await record(profile.STORAGE_KEY);
  assert.equal(after.avatarRef, before.avatarRef);
  await profile.updateProfile({ avatarData: image.replace('png', 'jpeg'), coverImage: '' });
  assert.equal(await dbState.collectUnusedAssets(), 1);
  assert.equal(profile.loadProfile().avatarData, image.replace('png', 'jpeg'));
});

test('deleting the final conversation is atomic with messages, drafts, members and couple associations', async () => {
  const a = await chat.createConversation({ name: 'A' });
  const group = await chat.createConversation({ name: 'G', avatar: 'group', members: ['nereus', a.id] });
  await chat.setDraft(a.id, 'draft'); await persistence.writeJson('echo-couple-v1', { charId: a.id });
  await chat.deleteConversation(a.id);
  assert.deepEqual(chat.getConversation(group.id).members, ['nereus']); assert.equal(persistence.readJson('echo-couple-v1').charId, null);
  assert.equal(chat.loadChatState().drafts[a.id], undefined);
  for (const c of chat.loadChatState().conversations) await chat.deleteConversation(c.id);
  assert.equal(chat.loadChatState().conversations.length, 0); assert.equal(chat.loadChatState().activeConversationId, null);
  assert.deepEqual(await allMessages(a.id), []);
});

test('draft updates are isolated from message and conversation payloads', async () => {
  const previous = await allMessages('nereus'); const metadata = await record(chat.STORAGE_KEY);
  await chat.setDraft('nereus', 'typing');
  assert.deepEqual(await record(chat.STORAGE_KEY), metadata);
  assert.deepEqual(await allMessages('nereus'), previous);
  assert.equal(chat.loadChatState().drafts.nereus, 'typing');
  assert.equal(storage.getItem('echo-chat-drafts-v2'), null);
});

test('paging loads 100 of 10000 messages and ordinary writes avoid a full history read', async () => {
  storage.clear(); const state = chat.defaultChatState();
  state.messagesByConversation.nereus = Array.from({ length: 10000 }, (_, index) => ({ id: 'm-' + index, author: 'mine', text: 'history-' + index, time: '12:00' }));
  await boot({ 'echo-chat-state-v1': state });
  assert.equal(chat.getMessages('nereus').length, 0);
  const page = await chat.loadMessagePage('nereus');
  assert.equal(page.rows.length, 100); assert.equal(page.rows[0].text, 'history-9900'); assert.equal(page.hasMore, true);
  const previous = IDBObjectStore.prototype.getAll; let fullReads = 0;
  IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'messages') fullReads++; return previous.apply(this, args); };
  try { await chat.appendMessage('nereus', { author: 'mine', text: 'new' }); await chat.setDraft('nereus', 'draft'); }
  finally { IDBObjectStore.prototype.getAll = previous; }
  assert.equal(fullReads, 0);
  const older = await chat.loadMessagePage('nereus', { before: page.before, limit: 100, append: true });
  assert.equal(older.rows.length, 200); assert.equal(older.rows[0].text, 'history-9801');
  for (let index = 1; index < older.rows.length; index++) assert.equal(older.rows[index].sequence - older.rows[index - 1].sequence, 1);
});

test('editing and deleting one message refreshes the preview', async () => {
  await chat.appendMessage('nereus', { id: 'new', text: 'before', author: 'mine' });
  await chat.updateMessage('nereus', 'new', { text: 'after' }); assert.equal(chat.getConversation('nereus').preview, 'after');
  await chat.deleteMessage('nereus', 'new'); assert.notEqual(chat.getConversation('nereus').preview, 'after');
});

test('reply task ownership blocks simultaneous replies and rejects late commits', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }); const wait = new Promise(resolve => { release = resolve; });
  let token;
  const first = chat.withReplyTask('nereus', {}, async ({ owner }) => { token = owner; entered(); await wait; });
  await started;
  await assert.rejects(chat.withReplyTask('nereus', {}, async () => {}), /另一个标签/);
  release(); await first;
  await assert.rejects(chat.appendMessage('nereus', { text: 'late' }, { owner: token }), /失效/);
});

test('a full-turn replacement is atomic and preserves following messages', async () => {
  await chat.appendMessage('nereus', { id: 'a', text: 'a', author: 'peer', turnId: 'turn-a' });
  await chat.appendMessage('nereus', { id: 'b', text: 'b', author: 'peer', turnId: 'turn-a' });
  await chat.appendMessage('nereus', { id: 'follow', text: 'following', author: 'mine' });
  const previous = await allMessages('nereus');
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'messages') throw new DOMException('full', 'QuotaExceededError'); return originalPut.apply(this, args); };
  await assert.rejects(chat.replaceReplyTurn('nereus', 'turn-a', [{ id: 'replacement', author: 'peer', turnId: 'turn-a', text: 'new' }]));
  assert.deepEqual(await allMessages('nereus'), previous); IDBObjectStore.prototype.put = originalPut;
  await chat.replaceReplyTurn('nereus', 'turn-a', [{ id: 'replacement', author: 'peer', turnId: 'turn-a', text: 'new' }]);
  const next = await allMessages('nereus'); assert.equal(next.at(-2).text, 'new'); assert.equal(next.at(-1).text, 'following');
});

test('backup exports current IDB state with inline images, excludes secrets and restores in one business transaction', async () => {
  settings.updateSettings(s => { s.models.text.apiKey = 'test-secret'; s.models.text.baseUrl = 'https://example.test/v1'; });
  await profile.updateProfile({ nickname: 'Backup', avatarData: image }); await chat.setDraft('nereus', 'draft');
  const backup = await persistence.createBackup(); assert.equal(JSON.stringify(backup).includes('test-secret'), false);
  assert.equal(JSON.parse(backup.data['echo-profile-v1']).avatarData, image);
  await profile.updateProfile({ nickname: 'Changed' }); await persistence.restoreBackup(backup);
  assert.equal(profile.loadProfile().nickname, 'Backup'); assert.equal(profile.loadProfile().avatarData, image);
  assert.equal(chat.loadChatState().drafts.nereus, 'draft');
  await assert.rejects(persistence.restoreBackup({ format: 'echo-backup', version: 1, data: { unrelated: 'value' } }));
});

test('restore business failure rolls back records/messages and settings', async () => {
  await profile.updateProfile({ nickname: 'Original' });
  const backup = await persistence.createBackup();
  backup.data['echo-profile-v1'] = JSON.stringify({ nickname: 'Wrong' }); backup.data['echo-settings-v1'] = JSON.stringify({ models: {} });
  storage.setItem('echo-settings-v1', JSON.stringify({ models: { text: { name: 'keep' } } }));
  let writes = 0;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'records' && args[1] === 'echo-profile-v1' && ++writes === 2) throw new DOMException('full', 'QuotaExceededError'); return originalPut.apply(this, args); };
  await assert.rejects(persistence.restoreBackup(backup));
  assert.equal(profile.loadProfile().nickname, 'Original'); assert.equal(settings.loadSettings().models.text.name, 'keep');
});

test('memory deduplication, concurrent saves and explicit empty posts are stable', async () => {
  let events = 0; const off = memory.subscribeToMemories(() => events++);
  await memory.saveMemory({ content: 'likes tea', charId: 'a' }); await memory.saveMemory({ content: 'likes tea', charId: 'a' });
  await memory.saveMemory({ content: 'likes tea', charId: 'b' }); assert.equal(events, 2); off();
  await Promise.all(Array.from({ length: 10 }, (_, i) => memory.saveMemory({ content: 'parallel-' + i, charId: 'a' })));
  assert.equal(memory.loadMemories().length, 12);
  await moments.savePosts([]); assert.deepEqual(moments.loadPosts(), []);
});
test('parameter normalization keeps Top P and context within supported bounds', () => {
  settings.updateSettings(s => { s.parameters.topP.value = 1.25; s.parameters.context.value = 68; });
  assert.equal(settings.loadSettings().parameters.topP.value, 1);
  assert.equal(settings.loadSettings().parameters.context.value, 64);
});

test('prompt includes archives and only the current speaker memories, and preserves group identity', () => {
  const messages = api.buildMessages({ id: 'a', name: 'A', persona: 'persona', archive: { hobbies: 'role-archive' } }, [
    { author: 'mine', text: 'hello' }, { author: 'peer', replyCharId: 'b', replyCharName: 'B', text: 'B says hi' },
  ], settings.loadSettings(), { nickname: 'User', archive: { hobbies: 'user-archive' } }, [{ charId: 'a', content: 'a-memory' }, { charId: 'b', content: 'b-memory' }]);
  assert.match(messages[0].content, /role-archive/); assert.match(messages[0].content, /user-archive/);
  assert.match(messages[0].content, /a-memory/); assert.doesNotMatch(messages[0].content, /b-memory/);
  assert.match(messages[1].content, /B：B says hi/);
});

test('reply parsing hides split, unfinished, and thought-only blocks', () => {
  for (const raw of ['<', '<t', '<th', '<thi', '<thin', '<think>', '<think>private']) assert.equal(api.parseReply(raw, true).text, '');
  assert.deepEqual(api.parseReply('<think>feeling</think>hello'), { text: 'hello', think: 'feeling' });
  assert.equal(api.parseReply('<think>only</think>').text, '');
});

function streamResponse(text, step = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.slice(i, i + step));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE handles every UTF-8 byte boundary, CRLF and DONE without waiting for close', async () => {
  const event = ': keepalive\r\n\r\ndata:{"choices":[{"delta":{"content":"你好🌊"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const step of [1, 2, 7, 1000]) assert.equal(await api.readEventStream(streamResponse(event, step)), '你好🌊');
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event)); }, cancel() { cancelled = true; } }));
  assert.equal(await api.readEventStream(response), '你好🌊'); assert.equal(cancelled, true);
});

test('SSE rejects truncation, server errors, empty output and callback failures', async () => {
  await assert.rejects(api.readEventStream(streamResponse('data: {"choices":[{"delta":{"content":"partial"}}]}')), /中断/);
  await assert.rejects(api.readEventStream(streamResponse('data: {"error":{"message":"server error"}}\n\n')), /server error/);
  await assert.rejects(api.readEventStream(streamResponse('data: [DONE]\n\n')), /空回复/);
  await assert.rejects(api.readEventStream(streamResponse('data: {"choices":[{"delta":{"content":"text"}}]}\n\n'), () => { throw new Error('callback failed'); }), /callback failed/);
});

test('completion sends configured parameters, handles JSON fallback and supports cancellation', async () => {
  settings.updateSettings(s => { s.models.text = { name: 'test', baseUrl: 'https://example.test/v1', apiKey: 'fake' }; s.parameters.topP.value = .5; });
  const original = globalThis.fetch;
  let body;
  globalThis.fetch = async (url, options) => {
    options.signal.throwIfAborted(); body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'reply' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(await api.requestCompletion({ messages: [{ role: 'user', content: 'hi' }], stream: true }), 'reply');
    assert.equal(body.top_p, .5); assert.equal(body.frequency_penalty, .3); assert.equal(body.presence_penalty, .2);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.requestCompletion({ messages: [], signal: controller.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});

test('API URLs reject remote plaintext, credentials, and query strings', () => {
  assert.equal(api.apiEndpoint('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1/chat/completions');
  for (const url of ['http://example.com', 'https://user:key@example.com', 'https://example.com?key=secret', 'javascript:alert(1)']) assert.throws(() => api.apiEndpoint(url));
});

test('UI CSS, HTML layout structure, and the theme controller retain the audited baseline', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const root = new URL('../', import.meta.url);
  const baseline = JSON.parse(readFileSync(new URL('ui-baseline.json', import.meta.url), 'utf8'));
  const hash = text => createHash('sha256').update(text).digest('hex');
  for (const file of readdirSync(root).filter(name => name.endsWith('.html'))) {
    const text = readFileSync(new URL(file, root), 'utf8');
    const css = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
    const body = text.replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const tags = body.match(/<\/?[A-Za-z][\w-]*/g);
    assert.equal(hash(css), baseline[file].css, file + ' CSS changed');
    assert.equal(hash(tags.join('\n')), baseline[file].tags, file + ' layout changed');
  }
  const main = readFileSync(new URL('js/chat-app.js', root), 'utf8');
  assert.equal(hash(main.slice(main.indexOf('function initThemePage()'), main.indexOf('function initArchivePage()'))), baseline.themeController);
});


test('the current npm start server serves the actual entry and blocks hidden/project tooling paths', async () => {
  const { createServer } = await import('../../scripts/serve.cjs');
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const root = await fetch(base + '/'); assert.equal(root.status, 200);
    const html = await root.text(); assert.match(html, /%E5%B0%8F%E6%89%8B%E6%9C%BA\/lock-screen.html/);
    assert.equal((await fetch(base + '/%E5%B0%8F%E6%89%8B%E6%9C%BA/lock-screen.html')).status, 200);
    assert.equal((await fetch(base + '/.git/config')).status, 404);
    assert.equal((await fetch(base + '/%E5%B0%8F%E6%89%8B%E6%9C%BA/node_modules/eslint/package.json')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('migration checks content, not only row counts, before marking completion', async () => {
  dbState.closeStorage(); storage.clear(); name = 'test-' + crypto.randomUUID();
  const old = chat.defaultChatState(); storage.setItem(chat.STORAGE_KEY, JSON.stringify(old));
  IDBObjectStore.prototype.put = function (value, ...args) { return originalPut.call(this, this.name === 'messages' ? { ...value, text: 'tampered' } : value, ...args); };
  await assert.rejects(persistence.initializeStorage({ name }), /内容校验失败/);
  assert.equal(storage.getItem(chat.STORAGE_KEY), JSON.stringify(old));
  IDBObjectStore.prototype.put = originalPut; await persistence.initializeStorage({ name });
  assert.equal((await allMessages('nereus'))[0].text, old.messagesByConversation.nereus[0].text);
});

test('legacy settings backups without a URL or local credentials restore safely', async () => {
  await persistence.restoreBackup({ format: 'echo-backup', version: 1, data: { 'echo-settings-v1': JSON.stringify({ models: { text: { name: 'legacy' } } }) } });
  assert.equal(settings.loadSettings().models.text.name, 'legacy');
  assert.equal(settings.loadSettings().models.text.apiKey, '');
  storage.setItem('echo-settings-v1', 'null');
  const backup = await persistence.createBackup(); assert.equal(backup.data['echo-settings-v1'], undefined); assert.equal(backup.warnings.length, 1);
});

test('deleting a replying group member fences its late result and cleans up the pending message', async () => {
  const group = await chat.createConversation({ name: 'Group', avatar: 'group', members: ['nereus', 'momo'] });
  await chat.withReplyTask(group.id, {}, async session => {
    await chat.appendMessage(group.id, { id: 'pending', text: '…', status: 'pending', author: 'peer', turnId: 'late-turn', replyCharId: 'momo' }, { owner: session.owner });
    await chat.deleteConversation('momo');
    await assert.rejects(chat.replaceReplyTurn(group.id, 'late-turn', [{ id: 'ghost', text: 'late result', author: 'peer', replyCharId: 'momo' }], null, { owner: session.owner }), /角色已被删除/);
  });
  const rows = await allMessages(group.id);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'interrupted');
});
