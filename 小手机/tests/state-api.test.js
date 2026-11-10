import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  values = new Map();
  failure = null;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.failure?.(key, value)) throw new DOMException('full', 'QuotaExceededError'); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  clear() { this.values.clear(); this.failure = null; }
}
const storage = new MemoryStorage();
globalThis.localStorage = storage;
globalThis.window = new EventTarget();
window.localStorage = storage;
const chat = await import('../js/chat-state.js');
const profile = await import('../js/profile-state.js');
const settings = await import('../js/settings-state.js');
const memory = await import('../js/memory-state.js');
const moments = await import('../js/moments-state.js');
const persistence = await import('../js/storage-state.js');
const api = await import('../js/api.js');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
beforeEach(() => storage.clear());

test('first character creation commits without a previous stored state', () => {
  const created = chat.createConversation({ name: 'First', avatar: 'peer' });
  assert.equal(chat.getConversation(created.id).name, 'First');
  assert.notEqual(chat.createConversation({ name: 'First' }).id, created.id);
});

test('empty conversation and post collections remain empty', () => {
  chat.saveChatState({ version: 1, conversations: [], messagesByConversation: {}, drafts: {} });
  assert.deepEqual(chat.loadChatState().conversations, []);
  assert.equal(chat.getConversation('missing'), null);
  moments.savePosts([]);
  assert.deepEqual(moments.loadPosts(), []);
});

test('quota failure preserves every old message and avatar and emits no success', () => {
  const state = chat.loadChatState();
  state.conversations[0].avatarData = image;
  state.messagesByConversation.nereus = Array.from({ length: 100 }, (_, id) => ({ id: String(id), text: 'old', author: 'mine' }));
  chat.saveChatState(state);
  const previous = new Map(storage.values);
  let success = 0;
  const off = chat.subscribeToChatState(() => success++);
  storage.failure = () => true;
  assert.throws(() => chat.appendMessage('nereus', { text: 'new' }), persistence.StorageError);
  assert.deepEqual(storage.values, previous);
  assert.equal(success, 0); off();
  assert.equal(chat.getMessages('nereus').length, 100);
  assert.equal(chat.getConversation('nereus').avatarData, image);
});

test('immutable assets are referenced, reused, and cleaned up on failed record commit', () => {
  const created = chat.createConversation({ name: 'Avatar', avatarData: image });
  const raw = JSON.parse(storage.getItem(chat.STORAGE_KEY));
  const entry = raw.conversations.find(c => c.id === created.id);
  assert.equal(entry.avatarData, undefined);
  assert.match(entry.avatarRef, /^echo-business-asset-v2\./);
  const before = storage.length;
  chat.updateConversation(created.id, { name: 'Updated' });
  assert.equal(storage.length, before);
  const prior = storage.getItem(chat.STORAGE_KEY);
  storage.failure = key => key === chat.STORAGE_KEY;
  assert.throws(() => chat.updateConversation(created.id, { avatarData: image.replace('png', 'jpeg') }));
  assert.equal(storage.length, before);
  assert.equal(storage.getItem(chat.STORAGE_KEY), prior);
});

test('corrupt and unknown-version chat state is preserved rather than replaced', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 99, conversations: [], messagesByConversation: {} })]) {
    storage.setItem(chat.STORAGE_KEY, raw);
    assert.throws(() => chat.createConversation({ name: 'New' }));
    assert.equal(storage.getItem(chat.STORAGE_KEY), raw);
  }
});

test('profile patch preserves archive, cover, and existing image references', () => {
  profile.saveProfile({ nickname: 'Old', archive: { hobbies: 'reading' }, coverImage: image, avatarData: image });
  profile.updateProfile({ nickname: 'New' });
  assert.equal(profile.loadProfile().archive.hobbies, 'reading');
  assert.equal(profile.loadProfile().coverImage, image);
  assert.equal(profile.loadProfile().avatarData, image);
  assert.equal(JSON.parse(storage.getItem(profile.STORAGE_KEY)).avatarData, undefined);
});

test('deletion removes group membership and refreshes active id without recreating defaults', () => {
  const a = chat.createConversation({ name: 'A' });
  const b = chat.createConversation({ name: 'B' });
  const group = chat.createConversation({ name: 'G', avatar: 'group', members: [a.id, b.id] });
  chat.deleteConversation(a.id);
  assert.deepEqual(chat.getConversation(group.id).members, [b.id]);
  for (const conversation of chat.loadChatState().conversations) chat.deleteConversation(conversation.id);
  assert.equal(chat.loadChatState().activeConversationId, null);
  assert.equal(chat.loadChatState().conversations.length, 0);
});

test('draft updates write a small key without rewriting conversation history', () => {
  chat.saveChatState(chat.loadChatState());
  const previous = storage.getItem(chat.STORAGE_KEY);
  chat.setDraft('nereus', 'typing');
  assert.equal(storage.getItem(chat.STORAGE_KEY), previous);
  assert.equal(chat.loadChatState().drafts.nereus, 'typing');
});

test('editing/deleting messages updates conversation previews', () => {
  chat.appendMessage('nereus', { id: 'new', text: 'before', author: 'mine' });
  chat.updateMessage('nereus', 'new', { text: 'after' });
  assert.equal(chat.getConversation('nereus').preview, 'after');
  chat.removeMessages('nereus', m => m.id === 'new');
  assert.notEqual(chat.getConversation('nereus').preview, 'after');
});

test('memory deduplication is scoped to speaker and notifications work in same tab', () => {
  let events = 0; const off = memory.subscribeToMemories(() => events++);
  memory.saveMemory({ content: 'likes tea', charId: 'a' });
  memory.saveMemory({ content: 'likes tea', charId: 'a' });
  memory.saveMemory({ id: Date.now() + 100, content: 'likes tea', charId: 'b' });
  assert.equal(memory.loadMemories().length, 2);
  assert.equal(events, 2); off();
});

test('backup excludes credentials and restores uploaded assets and drafts', () => {
  settings.updateSettings(s => { s.models.text.apiKey = 'test-secret'; s.models.text.baseUrl = 'https://example.test/v1'; });
  chat.createConversation({ name: 'Backup', avatarData: image });
  chat.setDraft('nereus', 'draft');
  const backup = persistence.createBackup();
  assert.equal(JSON.stringify(backup).includes('test-secret'), false);
  storage.clear(); persistence.restoreBackup(backup);
  assert.equal(chat.loadChatState().drafts.nereus, 'draft');
  assert.equal(chat.loadChatState().conversations.at(-1).avatarData, image);
});

test('restore rejects foreign keys and rolls back partial failures', () => {
  storage.setItem('echo-memory-v1', '[]');
  const original = new Map(storage.values);
  assert.throws(() => persistence.restoreBackup({ format: 'echo-backup', version: 1, data: { unrelated: 'value' } }));
  storage.failure = key => key === 'echo-profile-v1';
  assert.throws(() => persistence.restoreBackup({ format: 'echo-backup', version: 1, data: { 'echo-memory-v1': '[{"content":"new"}]', 'echo-profile-v1': '{}' } }));
  assert.deepEqual(storage.values, original);
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

test('full-turn replacement is a single commit and retains its original on quota failure', () => {
  chat.appendMessage('nereus', { id: 'segment-a', text: 'a', author: 'peer', turnId: 'turn-a' });
  chat.appendMessage('nereus', { id: 'segment-b', text: 'b', author: 'peer', turnId: 'turn-a' });
  const old = storage.getItem(chat.STORAGE_KEY);
  storage.failure = () => true;
  assert.throws(() => chat.replaceReplyTurn('nereus', 'turn-a', [{ id: 'replacement', author: 'peer', turnId: 'turn-a', text: 'new' }]));
  assert.equal(storage.getItem(chat.STORAGE_KEY), old);
  storage.failure = null;
  chat.replaceReplyTurn('nereus', 'turn-a', [{ id: 'replacement', author: 'peer', turnId: 'turn-a', text: 'new' }]);
  assert.equal(chat.getMessages('nereus').filter(m => m.turnId === 'turn-a').length, 1);
  assert.equal(chat.getConversation('nereus').preview, 'new');
});
