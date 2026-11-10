const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serve(directory) {
  const server = http.createServer((request, response) => {
    const file = path.resolve(directory, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
    if (!file.startsWith(directory + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}
(async () => {
  const { server, base } = await serve(root);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  let passed = 0;
  async function check(name, run) {
    if (process.env.TEST_FILTER && !name.includes(process.env.TEST_FILTER)) return;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    page.setDefaultTimeout(8000);
    const go = async file => { await page.goto(base + file, { waitUntil: 'load' }); if (!['lock-screen.html'].includes(file.split('?')[0])) { await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady); } };
    await go('home.html');
    try { await run({ page, context, go, errors, dialogs }); assert.deepEqual(errors, []); if (!/quota|backup and restore|memory deletion/.test(name)) assert.deepEqual(dialogs, []); console.log('PASS', name); passed++; }
    finally { await context.close(); }
  }
  const configure = page => page.evaluate(async () => {
    const settings = await import('./js/settings-state.js');
    settings.updateSettings(s => { s.models.text = { name: 'test-model', baseUrl: 'https://mock.test/v1', apiKey: 'fake-test-key' }; s.mcpEnabled = false; });
  });
  async function mockChat(page, replies) {
    await page.route('https://mock.test/v1/chat/completions', async route => {
      const body = route.request().postDataJSON();
      if (!body.stream) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '[]' } }] }) });
      const reply = replies.shift();
      if (reply?.status) return route.fulfill({ status: reply.status, contentType: 'application/json', body: '{"error":{"message":"mock failure"}}' });
      await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: reply || '默认回复' } }] })}\n\ndata: [DONE]\n\n` });
    });
  }
  async function eventually(predicate, timeout = 8000) {
    const end = Date.now() + timeout;
    do { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < end);
    throw new Error('Timed out waiting for committed state');
  }
  const settle = page => page.waitForFunction(() => !document.querySelector('#input-message').disabled);
  try {
    await check('all application pages initialize without exceptions', async ({ go }) => {
      for (const name of fs.readdirSync(root).filter(name => name.endsWith('.html'))) await go(name);
    });
    await check('first creation survives reload and hostile names/previews remain text', async ({ page, go }) => {
      const payload = '<img src=x onerror="window.__xss=1">';
      await go('chat-create.html'); await page.locator('#input-name').fill(payload); await page.locator('#btn-create-submit').click();
      await page.waitForURL('**/chat-room.html?**'); await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
      await page.evaluate(async text => { const chat = await import('./js/chat-state.js'); await chat.appendMessage(chat.loadChatState().activeConversationId, { author: 'mine', text }); }, payload);
      await go('chat-list.html');
      assert.equal(await page.locator('.chat-item__name').last().textContent(), payload);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.locator('.chat-item__body img').count(), 0);
    });
    await check('profile patch preserves archives and images through the real sheet', async ({ page, go }) => {
      await page.evaluate(async () => { const p = await import('./js/profile-state.js'); await p.updateProfile({ archive: { hobbies: 'reading' }, bio: 'old bio' }); });
      await go('chat-list.html'); await page.locator('#btn-my-profile').click(); await page.locator('#sheet-input-nickname').fill('NewName'); await page.locator('#sheet-save-btn').click();
      await eventually(() => page.evaluate(async () => (await import('./js/profile-state.js')).loadProfile().nickname === 'NewName'));
      assert.equal(await page.evaluate(async () => (await import('./js/profile-state.js')).loadProfile().archive.hobbies), 'reading');
    });
    await check('mode switch restores single-character submit', async ({ page, go }) => {
      await go('chat-create.html'); await page.locator('#seg-group').click(); await page.locator('#seg-single').click();
      assert.equal(await page.locator('#btn-create-submit').isEnabled(), true);
    });
    await check('editing a message commits and updates preview', async ({ page, go }) => {
      await go('chat-room.html');
      const bubble = page.locator('.msg--mine .msg__bubble').first();
      await bubble.dispatchEvent('contextmenu', { clientX: 100, clientY: 100 }); await page.locator('#ctx-edit').click();
      await page.locator('[contenteditable=true]').fill('edited message'); await page.locator('[contenteditable=true]').press('Enter');
      assert.equal(await page.locator('.msg--mine .msg__bubble').first().textContent(), 'edited message');
    });
    await check('single reply and full-turn regeneration share parsing and persistence', async ({ page, go }) => {
      await configure(page); await mockChat(page, ['<think>角色心声</think>第一段\n第二段', '<think>新心声</think>替换一\n替换二']);
      await go('chat-room.html'); await page.locator('#input-message').fill('你好'); await page.locator('#input-message').press('Enter'); await settle(page);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), '第二段');
      assert.equal(await page.locator('.msg-think__body').last().textContent(), '角色心声');
      await page.locator('.msg--peer .msg__bubble').last().dispatchEvent('contextmenu', { clientX: 100, clientY: 100 });
      await page.locator('#ctx-regen').click(); await settle(page);
      const text = await page.locator('#room-msgs').textContent();
      assert.equal(text.includes('第一段'), false); assert.equal(text.includes('第二段'), false); assert.equal(text.includes('<think>'), false);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), '替换二');
      const turns = await page.evaluate(async () => (await import('./js/chat-state.js')).getMessages('nereus').filter(m => m.text.startsWith('替换')));
      assert.equal(turns.length, 2); assert.equal(turns[0].turnId, turns[1].turnId);
    });
    await check('API failures unlock input and a subsequent reply succeeds', async ({ page, go }) => {
      await configure(page); await mockChat(page, [{ status: 500 }, 'recovered']); await go('chat-room.html');
      await page.locator('#input-message').fill('first'); await page.locator('#input-message').press('Enter'); await settle(page);
      assert.match(await page.locator('.msg__bubble').last().textContent(), /mock failure/);
      await page.locator('#input-message').fill('second'); await page.locator('#input-message').press('Enter'); await settle(page);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), 'recovered');
    });
    await check('group replies continue after one member fails and regenerate the actual speaker', async ({ page, go }) => {
      await configure(page); await mockChat(page, [{ status: 500 }, '<think>B</think>群回复一\n群回复二', '群重生成']);
      const id = await page.evaluate(async () => (await (await import('./js/chat-state.js')).createConversation({ name: 'Group', avatar: 'group', members: ['nereus', 'momo'] })).id);
      await go('chat-room.html?conversationId=' + encodeURIComponent(id));
      await page.locator('#input-message').fill('大家好'); await page.locator('#input-message').press('Enter'); await settle(page);
      const messages = await page.evaluate(async id => (await import('./js/chat-state.js')).getMessages(id), id);
      assert.equal(messages.filter(m => m.status === 'failed').length, 1);
      assert.equal(messages.at(-1).replyCharId, 'momo');
      await page.locator('.msg--peer .msg__bubble').last().dispatchEvent('contextmenu', { clientX: 100, clientY: 100 }); await page.locator('#ctx-regen').click(); await settle(page);
      const last = await page.evaluate(async id => (await import('./js/chat-state.js')).getMessages(id).at(-1), id);
      assert.equal(last.replyCharId, 'momo'); assert.equal(last.text, '群重生成');
    });
    await check('empty collections stay empty and invalid routes do not open other people', async ({ page, go }) => {
      await page.evaluate(async () => { const chat = await import('./js/chat-state.js'); for (const c of chat.loadChatState().conversations) await chat.deleteConversation(c.id); });
      await go('chat-list.html'); assert.equal(await page.locator('.chat-item').count(), 0);
      await go('chat-room.html?conversationId=missing'); await page.waitForURL('**/chat-list.html?**');
    });
    await check('IDB quota failure retains old messages and reports failure', async ({ page, go, dialogs }) => {
      await go('chat-room.html');
      const previous = await page.evaluate(async () => JSON.stringify([...(await (await import('./js/database-state.js')).exportBusiness())]));
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) { if (this.name === 'records') throw new DOMException('full', 'QuotaExceededError'); return original.apply(this, args); };
      });
      await page.locator('#input-message').fill('unsaved'); await page.locator('#input-message').press('Enter');
      await page.waitForFunction(() => document.querySelector('#input-message').disabled === false);
      assert.equal(await page.evaluate(async () => JSON.stringify([...(await (await import('./js/database-state.js')).exportBusiness())])), previous);
      assert.equal(await page.locator('#input-message').inputValue(), 'unsaved'); assert.ok(dialogs.some(value => value.includes('事务')));
    });
    await check('model probe distinguishes authentication failure and reruns after save', async ({ page, go }) => {
      await configure(page); await page.evaluate(async () => (await import('./js/settings-state.js')).updateSettings(s => { s.mcpEnabled = true; }));
      let count = 0; await page.route('https://mock.test/v1/models', route => { count++; return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); });
      await go('settings.html'); await page.waitForFunction(() => document.querySelector('#mcp-status-label').textContent.includes('认证失败'));
      await page.locator('#row-text-model').click(); await page.locator('#model-input-name').fill('changed'); await page.locator('#model-sheet-save').click();
      await page.waitForFunction(() => document.querySelector('#mcp-status-label').textContent.includes('认证失败'));
      assert.equal(count, 2);
    });
    await check('memory changes propagate between tabs', async ({ page, context, go }) => {
      await go('memory.html'); const other = await context.newPage(); await other.goto(base + 'home.html'); await other.waitForFunction(() => window.echoReady); await other.evaluate(() => window.echoReady);
      await other.evaluate(async () => await (await import('./js/memory-state.js')).saveMemory({ content: 'cross-tab-memory', charId: 'nereus' }));
      await page.waitForFunction(() => document.querySelector('#memory-main').textContent.includes('cross-tab-memory'));
    });
    await check('full reply is durable before all segments are displayed', async ({ page, go }) => {
      await configure(page); await mockChat(page, ['一\n二\n三\n四\n五']); await go('chat-room.html');
      await page.locator('#input-message').fill('test refresh'); await page.locator('#input-message').press('Enter');
      await eventually(() => page.evaluate(async () => (await (await import('./js/database-state.js')).exportBusiness()).get('echo-chat-state-v1').messagesByConversation.nereus.some(m => m.text === '五')));
      await page.reload(); await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), '五'); assert.equal(await page.locator('#input-message').isEnabled(), true);
    });
    await check('backup and restore work through the existing world buttons without exporting API keys', async ({ page, go }) => {
      await configure(page);
      await page.evaluate(async () => await (await import('./js/profile-state.js')).updateProfile({ nickname: 'BackupName', archive: { hobbies: 'keep-me' } }));
      await go('world.html');
      const downloadEvent = page.waitForEvent('download'); await page.locator('#btn-backup').click();
      const download = await downloadEvent;
      const file = fs.readFileSync(await download.path());
      const backup = JSON.parse(file.toString()); assert.equal(file.toString().includes('fake-test-key'), false);
      await page.evaluate(async () => await (await import('./js/profile-state.js')).updateProfile({ nickname: 'Changed' }));
      const chooserEvent = page.waitForEvent('filechooser'); await page.locator('#btn-restore').click();
      const chooser = await chooserEvent;
      const reloaded = page.waitForEvent('load');
      await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
      await reloaded; await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
      assert.equal(await page.evaluate(async () => (await import('./js/profile-state.js')).loadProfile().archive.hobbies), 'keep-me');
    });
    await check('leaving an in-flight reply aborts the request and reload recovers the input', async ({ page, go }) => {
      await configure(page);
      let started; const requestStarted = new Promise(resolve => { started = resolve; });
      await page.route('https://mock.test/v1/chat/completions', async route => { started(); try { await new Promise(resolve => setTimeout(resolve, 500)); await route.abort(); } catch { /* navigation cancelled */ } });
      await go('chat-room.html'); await page.locator('#input-message').fill('cancel me'); await page.locator('#input-message').press('Enter');
      await requestStarted; await go('home.html'); await go('chat-room.html');
      assert.equal(await page.locator('#input-message').isEnabled(), true);
      const last = await page.evaluate(async () => (await import('./js/chat-state.js')).getMessages('nereus').at(-1));
      assert.ok(['cancelled', 'interrupted'].includes(last.status));
    });
    await check('changing the model API origin, including the default origin, clears the old key', async ({ page, go }) => {
      await configure(page); await go('settings.html'); await page.locator('#row-text-model').click();
      assert.equal(await page.locator('#model-input-key').inputValue(), 'fake-test-key');
      await page.locator('#model-input-url').fill(''); await page.locator('#model-input-name').focus();
      assert.equal(await page.locator('#model-input-key').inputValue(), '');
    });
    await check('memory deletion renders one empty state', async ({ page, go }) => {
      await page.evaluate(async () => await (await import('./js/memory-state.js')).saveMemory({ content: 'delete-me' }));
      await go('memory.html'); await page.locator('[data-action=delete]').click();
      await eventually(async () => (await page.locator('.mem-card').count()) === 0);
      assert.equal(await page.locator('.mem-card').count(), 0); assert.equal(await page.locator('#memory-empty').count(), 1);
    });
    await check('parallel writes in two tabs preserve messages and independent profile fields', async ({ page, context }) => {
      const other = await context.newPage(); await other.goto(base + 'home.html'); await other.waitForFunction(() => window.echoReady); await other.evaluate(() => window.echoReady);
      await Promise.all([page.evaluate(async () => { const chat = await import('./js/chat-state.js'); await Promise.all(Array.from({ length: 10 }, (_, i) => chat.appendMessage('nereus', { author: 'mine', text: 'tab-a-' + i }))); }), other.evaluate(async () => { const chat = await import('./js/chat-state.js'); await Promise.all(Array.from({ length: 10 }, (_, i) => chat.appendMessage('nereus', { author: 'mine', text: 'tab-b-' + i }))); })]);
      const texts = await page.evaluate(async () => (await (await import('./js/database-state.js')).exportBusiness()).get('echo-chat-state-v1').messagesByConversation.nereus.map(m => m.text));
      assert.equal(texts.filter(text => text.startsWith('tab-')).length, 20);
      await Promise.all([page.evaluate(async () => (await import('./js/profile-state.js')).updateProfile({ nickname: 'BothTabs' })), other.evaluate(async () => (await import('./js/profile-state.js')).updateProfile({ archive: { hobbies: 'both-hobbies' } }))]);
      await eventually(() => page.evaluate(async () => { const p = (await import('./js/profile-state.js')).loadProfile(); return p.nickname === 'BothTabs' && p.archive.hobbies === 'both-hobbies'; }));
    });
    await check('a second tab does not interrupt an active reply and becomes usable after completion', async ({ page, context, go }) => {
      await configure(page);
      let start, release; let calls = 0;
      const started = new Promise(resolve => { start = resolve; }); const held = new Promise(resolve => { release = resolve; });
      await page.route('https://mock.test/v1/chat/completions', async route => {
        if (!route.request().postDataJSON().stream) return route.fulfill({ contentType: 'application/json', body: '{"choices":[{"message":{"content":"[]"}}]}' });
        calls++; start(); await held;
        await route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"owner reply"}}]}\n\ndata: [DONE]\n\n' });
      });
      await go('chat-room.html'); await page.locator('#input-message').fill('owner request'); await page.locator('#input-message').press('Enter'); await started;
      const other = await context.newPage(); await other.goto(base + 'chat-room.html'); await other.waitForFunction(() => window.echoReady); await other.evaluate(() => window.echoReady);
      assert.equal(await other.locator('#input-message').isDisabled(), true);
      assert.match(await other.locator('#input-message').getAttribute('placeholder'), /另一个标签/);
      assert.equal(await other.evaluate(async () => (await import('./js/chat-state.js')).getMessages('nereus').at(-1).status), 'pending');
      release(); await settle(page);
      await eventually(() => other.locator('#input-message').isEnabled()); assert.equal(calls, 1);
      await eventually(() => other.locator('.msg__bubble').last().textContent().then(text => text === 'owner reply'));
    });
    await check('closing the owner tab recovers its abandoned reply without waiting for lease expiry', async ({ page, context, go }) => {
      await configure(page);
      let start; const started = new Promise(resolve => { start = resolve; });
      await page.route('https://mock.test/v1/chat/completions', async route => { start(); await new Promise(resolve => setTimeout(resolve, 1000)); try { await route.abort(); } catch { /* closed tab */ } });
      await go('chat-room.html'); await page.locator('#input-message').fill('owner disappears'); await page.locator('#input-message').press('Enter'); await started;
      const other = await context.newPage(); await other.goto(base + 'chat-room.html'); await other.waitForFunction(() => window.echoReady); await other.evaluate(() => window.echoReady);
      await page.close(); await eventually(() => other.locator('#input-message').isEnabled());
      const last = await other.evaluate(async () => (await import('./js/chat-state.js')).getMessages('nereus').at(-1));
      assert.ok(['cancelled', 'interrupted'].includes(last.status));
    });
    await check('long chat opens with 100 messages and prepends older messages without moving the reading anchor', async ({ page, go }) => {
      await page.evaluate(async () => {
        const chat = await import('./js/chat-state.js'); const state = chat.defaultChatState();
        state.messagesByConversation.nereus = Array.from({ length: 10000 }, (_, i) => ({ id: 'history-' + i, author: 'mine', text: 'history-' + i, time: '12:00' }));
        await (await import('./js/storage-state.js')).restoreBackup({ format: 'echo-backup', version: 1, data: { 'echo-chat-state-v1': JSON.stringify(state) } });
      });
      await go('chat-room.html'); await page.waitForTimeout(100);
      assert.equal(await page.locator('.msg').count(), 100);
      const top = await page.evaluate(() => { window.scrollTo(0, 0); return document.querySelector('[data-msg-id="history-9900"]').getBoundingClientRect().top; });
      await eventually(async () => (await page.locator('.msg').count()) >= 200);
      assert.equal(await page.locator('.msg').count(), 200);
      const after = await page.locator('[data-msg-id="history-9900"]').evaluate(node => node.getBoundingClientRect().top);
      assert.ok(Math.abs(after - top) < 2);
      assert.equal(await page.locator('.msg__bubble').first().textContent(), 'history-9800');
    });
    await check('long streaming replies follow the bottom of the chat', async ({ page, go }) => {
      await configure(page); await mockChat(page, ['长回复'.repeat(800)]); await go('chat-room.html');
      await page.locator('#input-message').fill('long response'); await page.locator('#input-message').press('Enter'); await settle(page);
      await page.waitForTimeout(80);
      const position = await page.locator('.msg__bubble').last().evaluate(node => ({ bottom: node.getBoundingClientRect().bottom, viewport: window.innerHeight, scroll: document.scrollingElement.scrollTop }));
      assert.ok(position.scroll > 0); assert.ok(position.bottom <= position.viewport + 2);
    });
    await check('known models load only the required local tokenizer on first request', async ({ page, go }) => {
      const assets = []; let body;
      page.on('request', request => { if (request.url().includes('/vendor/tokenizer/')) assets.push(request.url()); });
      await configure(page);
      await page.evaluate(async () => (await import('./js/settings-state.js')).updateSettings(s => { s.models.text.name = 'gpt-4o'; s.parameters.context.value = 8; }));
      await page.route('https://mock.test/v1/chat/completions', route => {
        const payload = route.request().postDataJSON();
        if (!payload.stream) return route.fulfill({ contentType: 'application/json', body: '{"choices":[{"message":{"content":"[]"}}]}' });
        body = payload;
        return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"choices":[{"delta":{"content":"local tokenizer ready"}}]}\n\ndata: [DONE]\n\n' });
      });
      await go('chat-room.html'); assert.equal(assets.length, 0);
      await page.locator('#input-message').fill('你好，世界 <|endoftext|>'); await page.locator('#input-message').press('Enter'); await settle(page);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), 'local tokenizer ready');
      assert.ok(assets.some(url => url.endsWith('/engine.js'))); assert.ok(assets.some(url => url.endsWith('/o200k_base.js')));
      assert.equal(assets.some(url => url.endsWith('/cl100k_base.js')), false); assert.ok(assets.every(url => url.startsWith(base)));
      assert.equal(body.max_tokens, 2000);
      const tokens = await page.evaluate(async messages => (await (await import('./js/token-budget.js')).tokenCounter('gpt-4o')).countMessages(messages), body.messages);
      assert.ok(tokens + body.max_tokens + 256 <= 8000);
    });
    await check('oversized input stays intact and unlocks the page without making an API request', async ({ page, go }) => {
      await configure(page); await page.evaluate(async () => (await import('./js/settings-state.js')).updateSettings(s => { s.parameters.context.value = 8; }));
      let calls = 0; await page.route('https://mock.test/v1/chat/completions', route => { calls++; return route.abort(); });
      await go('chat-room.html');
      const text = 'x'.repeat(9000); await page.locator('#input-message').fill(text); await page.locator('#input-message').press('Enter'); await settle(page);
      assert.match(await page.locator('.msg__bubble').last().textContent(), /超出上下文预算/); assert.equal(calls, 0);
      const stored = await page.evaluate(async () => (await import('./js/chat-state.js')).getMessages('nereus').filter(message => message.author === 'mine').at(-1));
      assert.equal(stored.text, text); assert.equal(await page.locator('#input-message').isEnabled(), true);
      await page.reload(); await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
      assert.equal(await page.locator('.msg--mine .msg__bubble').last().textContent(), text);
    });
    await check('a delayed memory response cannot reattach facts from a regenerated reply', async ({ page, go }) => {
      await configure(page); let oldExtraction, resolveOld; let replies = 0, extractions = 0;
      const extractionStarted = new Promise(resolve => { resolveOld = resolve; });
      await page.route('https://mock.test/v1/chat/completions', async route => {
        if (route.request().postDataJSON().stream) {
          replies++;
          return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: replies === 1 ? 'old promise' : 'new promise' } }] })}\n\ndata: [DONE]\n\n` });
        }
        if (++extractions === 1) { oldExtraction = route; resolveOld(); return; }
        return route.abort();
      });
      await go('chat-room.html'); await page.locator('#input-message').fill('make a promise'); await page.locator('#input-message').press('Enter'); await settle(page); await extractionStarted;
      await page.locator('.msg--peer .msg__bubble').last().dispatchEvent('contextmenu', { clientX: 100, clientY: 100 }); await page.locator('#ctx-regen').click(); await settle(page);
      const applied = page.waitForFunction(() => window.__lateMemoryApplied);
      await page.evaluate(async () => {
        const original = IDBObjectStore.prototype.index;
        IDBObjectStore.prototype.index = function (...args) { if (this.name === 'messages' && args[0] === 'byTurn') window.__lateMemoryApplied = true; return original.apply(this, args); };
      });
      await oldExtraction.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '[{"content":"stale promise","tags":["约定"]}]' } }] }) });
      await applied;
      // Wait until the IDB guard has completed, rather than just for the network response.
      const memories = await page.evaluate(async () => {
        const db = await import('./js/database-state.js');
        return db.transactionOn(db.database(), ['records', 'messages'], 'readwrite', tx => db.requestResult(tx.objectStore('records').get('echo-memory-v1')));
      });
      assert.equal((memories || []).some(item => item.content === 'stale promise'), false);
      assert.equal(await page.locator('.msg__bubble').last().textContent(), 'new promise');
    });
    console.log(`Browser checks passed: ${passed}`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
