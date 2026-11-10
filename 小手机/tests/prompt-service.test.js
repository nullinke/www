import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const values = new Map();
const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
Object.assign(globalThis, { indexedDB, IDBKeyRange, localStorage: storage, window: new EventTarget() }); window.localStorage = storage;
const db = await import('../js/database-state.js');
const chat = await import('../js/chat-state.js');
const settings = await import('../js/settings-state.js');
const profile = await import('../js/profile-state.js');
const memory = await import('../js/memory-state.js');
const { createReplyRunner } = await import('../js/reply-service.js');
const { buildPrompt } = await import('../js/prompt-builder.js');
const { tokenCounter, fallbackCounter, requestBudget } = await import('../js/token-budget.js');
const { requestCompletion } = await import('../js/api.js');
const originalFetch = globalThis.fetch, originalPut = IDBObjectStore.prototype.put, originalGetAll = IDBObjectStore.prototype.getAll;
const image = 'data:image/png;base64,AAAA';
const snapshot = () => db.exportBusiness();
const messages = async id => (await snapshot()).get(chat.STORAGE_KEY).messagesByConversation[id] || [];
beforeEach(async () => { values.clear(); db.closeStorage(); await db.initializeStorage({ name: 'test-' + crypto.randomUUID(), defaults: { [chat.STORAGE_KEY]: chat.defaultChatState() } }); });
afterEach(() => { globalThis.fetch = originalFetch; IDBObjectStore.prototype.put = originalPut; IDBObjectStore.prototype.getAll = originalGetAll; db.closeStorage(); });

test('known model text counts use the local encoder, including CJK and literal special token strings', async () => {
  const o = await tokenCounter('gpt-4o'), cl = await tokenCounter('gpt-4');
  assert.equal(o.name, 'o200k_base'); assert.equal(cl.name, 'cl100k_base');
  assert.equal(o.countText('hello world'), 2); assert.equal(cl.countText('hello world'), 2);
  assert.equal(o.countText('你好，世界'), 3); assert.equal(cl.countText('你好，世界'), 6);
  assert.equal(o.countText('<|endoftext|>'), 7); assert.equal(cl.countText('<|endoftext|>'), 7);
  assert.equal((await tokenCounter('my-custom-model')).exactText, false); assert.equal(fallbackCounter.countText('你好'), 6);
});

test('prompt selection preserves the latest user across oversized consecutive user messages and does not mutate history', async () => {
  const counter = await tokenCounter('gpt-4o');
  settings.updateSettings(s => { s.models.text.name = 'gpt-4o'; s.parameters.context.value = 8; });
  const history = [{ author: 'mine', text: '旧记录 '.repeat(5000) }, { author: 'mine', text: '最新的问题' }];
  const before = JSON.stringify(history);
  const result = buildPrompt({ id: 'nereus', name: 'Nereus' }, history, settings.loadSettings(), {}, [], counter);
  assert.ok(result.messages.some(message => message.content.includes('最新的问题')));
  assert.ok(result.budget.inputTokens + result.budget.output + result.budget.margin <= result.budget.context);
  assert.equal(JSON.stringify(history), before);
});

test('oversized group responses cannot evict the actual user question', async () => {
  settings.updateSettings(s => { s.parameters.context.value = 8; });
  const result = buildPrompt({ id: 'a', name: 'A' }, [
    { author: 'mine', text: 'the real question' },
    { author: 'peer', replyCharId: 'b', replyCharName: 'B', text: 'x'.repeat(10000) },
    { author: 'peer', replyCharId: 'c', replyCharName: 'C', text: 'short context' },
  ], settings.loadSettings());
  assert.match(result.messages[1].content, /the real question/); assert.match(result.messages[1].content, /C：short context/);
  assert.doesNotMatch(result.messages[1].content, /x{100}/);
});

test('optional prompt sections yield to the latest message and mandatory overflow is explicit', () => {
  settings.updateSettings(s => { s.parameters.context.value = 8; });
  const result = buildPrompt({ id: 'a', name: 'A' }, [{ author: 'mine', text: 'x'.repeat(5000) }], settings.loadSettings(), { archive: { appearance: '外貌'.repeat(500), personality: '性格'.repeat(500) } });
  assert.ok(result.omittedSections > 0); assert.ok(result.messages.some(message => message.content.includes('x'.repeat(5000))));
  assert.throws(() => buildPrompt({ id: 'a', persona: 'x'.repeat(8000) }, [{ author: 'mine', text: 'hello' }], settings.loadSettings()), /超出/);
  assert.equal(requestBudget(settings.loadSettings()).output, 2000);
});

test('requests enforce input and output budgets before calling the network', async () => {
  settings.updateSettings(s => { s.models.text = { name: 'custom', baseUrl: 'https://mock.test/v1', apiKey: 'fake' }; s.parameters.context.value = 8; });
  let calls = 0, body;
  globalThis.fetch = async (_url, options) => { calls++; body = JSON.parse(options.body); return new Response('{"choices":[{"message":{"content":"ok"}}]}', { headers: { 'Content-Type': 'application/json' } }); };
  await assert.rejects(requestCompletion({ messages: [{ role: 'user', content: 'x'.repeat(9000) }] }), /超出/); assert.equal(calls, 0);
  await requestCompletion({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 512 });
  assert.equal(body.max_tokens, 512); assert.equal(calls, 1);
});

test('known reasoning protocol omits unsupported sampling fields and uses the correct output field', async () => {
  settings.updateSettings(s => { s.models.text = { name: 'o3-mini', baseUrl: 'https://mock.test/v1', apiKey: 'fake' }; });
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response('{"choices":[{"message":{"content":"ok"}}]}', { headers: { 'Content-Type': 'application/json' } }); };
  await requestCompletion({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.max_completion_tokens, 2048); assert.equal(body.temperature, undefined); assert.equal(body.top_p, undefined); assert.equal(body.max_tokens, undefined);
});

test('reply service runs without a DOM and keeps every segment plus thought content', async () => {
  await chat.setDraft('nereus', 'hello');
  const chunks = [], staged = [], revealed = [], states = [];
  const runner = createReplyRunner({ conversationId: 'nereus', onChunk: event => chunks.push(event.text), onStaging: entries => staged.push(...entries), onReveal: id => revealed.push(id), onState: value => states.push(value) }, {
    chat: async options => { options.onChunk('', '<think>角色心声</think>一\n二'); return '<think>角色心声</think>一\n二'; }, pause: async () => {},
  });
  await runner.run({ userText: 'hello' });
  const rows = await messages('nereus');
  assert.equal(rows.at(-2).text, '一'); assert.equal(rows.at(-2).think, '角色心声'); assert.equal(rows.at(-1).text, '二');
  assert.equal(staged.length, 2); assert.deepEqual(revealed, [staged[1].id]); assert.equal(chunks[0].includes('<think>'), false);
  assert.equal(chat.loadChatState().drafts.nereus, undefined);
  assert.equal(states.at(-1).running, false); assert.equal(runner.running, false); runner.dispose();
});

test('reply service prevents duplicate work and cancels cleanly without relying on the view cache', async () => {
  let start; const started = new Promise(resolve => { start = resolve; }); let calls = 0;
  const runner = createReplyRunner({ conversationId: 'nereus' }, { chat: async ({ signal }) => { calls++; start(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })); } });
  const first = runner.run({ userText: 'hello' }); await started;
  assert.equal(await runner.run({ userText: 'duplicate' }), false); runner.cancel();
  await assert.rejects(first, { name: 'AbortError' }); assert.equal(calls, 1);
  assert.equal((await messages('nereus')).at(-1).status, 'cancelled'); assert.equal(runner.running, false); runner.dispose();
});

test('a reply with excessive line breaks preserves every line while bounding presentation work', async () => {
  const body = Array.from({ length: 200 }, (_, index) => 'line-' + index).join('\n'); let pauses = 0;
  const runner = createReplyRunner({ conversationId: 'nereus' }, { chat: async () => body, pause: async () => { pauses++; } });
  await runner.run({ userText: 'many lines' });
  const rows = await messages('nereus'); const turn = rows.at(-1).turnId;
  assert.equal(rows.filter(row => row.turnId === turn).map(row => row.text).join('\n'), body);
  assert.ok(pauses < 128); runner.dispose();
});

test('group service continues after a member API error without needing mounted messages', async () => {
  const group = await chat.createConversation({ name: 'G', avatar: 'group', members: ['nereus', 'momo'] });
  const runner = createReplyRunner({ conversationId: group.id }, { chat: async ({ conversation }) => { if (conversation.id === 'nereus') throw new Error('first failed'); return 'second succeeded'; }, pause: async () => {} });
  await runner.run({ userText: 'group question' }); const rows = await messages(group.id);
  assert.equal(rows.filter(row => row.status === 'failed').length, 1); assert.equal(rows.at(-1).replyCharId, 'momo'); runner.dispose();
});

test('sending a message and clearing its draft roll back together on failure', async () => {
  await chat.setDraft('nereus', 'keep draft'); const before = await messages('nereus'); let calls = 0, blocked = false;
  const runner = createReplyRunner({ conversationId: 'nereus' }, { chat: async () => { calls++; return 'reply'; } });
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'records' && args[1] === 'echo-chat-drafts-v2') { blocked = true; throw new DOMException('full', 'QuotaExceededError'); } return originalPut.apply(this, args); };
  await assert.rejects(runner.run({ userText: 'keep draft' }));
  assert.equal(blocked, true); assert.deepEqual(await messages('nereus'), before); assert.equal(chat.loadChatState().drafts.nereus, 'keep draft'); assert.equal(calls, 0); runner.dispose();
});

test('regeneration removes derived facts but preserves manual memories and rejects late extraction', async () => {
  await chat.appendMessage('nereus', { id: 'old', author: 'peer', text: 'old reply', status: 'complete', turnId: 'turn', replyCharId: 'nereus' });
  await memory.saveExtractedMemories({ conversationId: 'nereus', charId: 'nereus', turnId: 'turn', sourceMessageIds: ['old'], items: [{ content: 'old fact', tags: ['约定'] }] });
  await memory.saveMemory({ source: 'user', content: 'manual fact', conversationId: 'nereus', charId: 'nereus', turnId: 'turn' });
  assert.equal(memory.loadMemories().length, 2);
  await chat.replaceReplyTurn('nereus', 'turn', [{ id: 'new', author: 'peer', text: 'new reply', status: 'complete', turnId: 'turn', replyCharId: 'nereus' }]);
  assert.deepEqual(memory.loadMemories().map(item => item.content), ['manual fact']);
  await memory.saveExtractedMemories({ conversationId: 'nereus', charId: 'nereus', turnId: 'turn', sourceMessageIds: ['old'], items: [{ content: 'late old fact' }] });
  assert.deepEqual(memory.loadMemories().map(item => item.content), ['manual fact']);
  await memory.saveExtractedMemories({ conversationId: 'nereus', charId: 'nereus', turnId: 'turn', sourceMessageIds: ['new'], items: [{ content: 'new fact' }] });
  assert.equal(memory.loadMemories().length, 2); assert.ok(memory.loadMemories().some(item => item.sourceMessageIds.includes('new')));
});

test('resource collection streams message cursors, preserves live assets, and rolls back cancellation', async () => {
  await profile.updateProfile({ avatarData: image });
  await db.transact(['assets'], tx => { for (let i = 0; i < 3; i++) tx.objectStore('assets').put(image, 'orphan-' + i); });
  IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'messages') throw new Error('bulk history read'); return originalGetAll.apply(this, args); };
  const controller = new AbortController();
  await assert.rejects(db.collectUnusedAssets({ signal: controller.signal, onProgress: value => { if (value.phase === 'assets' && value.removed === 1) controller.abort(); } }));
  const count = () => db.transactionOn(db.database(), ['assets'], 'readonly', tx => db.requestResult(tx.objectStore('assets').count()));
  assert.equal(await count(), 4); assert.equal(await db.collectUnusedAssets(), 3); assert.equal(await count(), 1); assert.equal(profile.loadProfile().avatarData, image);
});

test('vendored tokenizer files match the pinned provenance manifest and include licenses', () => {
  const root = new URL('../js/vendor/tokenizer/', import.meta.url); const manifest = JSON.parse(readFileSync(new URL('manifest.json', root)));
  assert.equal(manifest.version, '1.0.21');
  for (const [file, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(new URL(file, root)); assert.equal(bytes.length, expected.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
  assert.match(readFileSync(new URL('NOTICES.txt', root), 'utf8'), /MIT License/);
});
