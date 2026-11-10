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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage(); const errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    page.setDefaultTimeout(8000);
    const go = file => page.goto(base + file, { waitUntil: 'load' });
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
  const settle = page => page.waitForFunction(() => !document.querySelector('#input-message').disabled);
  try {
    await check('all 16 pages initialize without exceptions', async ({ go }) => {
      for (const name of fs.readdirSync(root).filter(name => name.endsWith('.html'))) await go(name);
    });
    await check('first creation survives reload and hostile names/previews remain text', async ({ page, go }) => {
      const payload = '<img src=x onerror="window.__xss=1">';
      await go('chat-create.html'); await page.locator('#input-name').fill(payload); await page.locator('#btn-create-submit').click();
      await page.waitForURL('**/chat-room.html?**');
      await page.evaluate(async text => { const chat = await import('./js/chat-state.js'); chat.appendMessage(chat.loadChatState().activeConversationId, { author: 'mine', text }); }, payload);
      await go('chat-list.html');
      assert.equal(await page.locator('.chat-item__name').last().textContent(), payload);
      assert.equal(await page.evaluate(() => window.__xss), undefined);
      assert.equal(await page.locator('.chat-item__body img').count(), 0);
    });
    await check('profile patch preserves archives and images through the real sheet', async ({ page, go }) => {
      await page.evaluate(async () => { const p = await import('./js/profile-state.js'); p.updateProfile({ archive: { hobbies: 'reading' }, bio: 'old bio' }); });
      await go('chat-list.html'); await page.locator('#btn-my-profile').click(); await page.locator('#sheet-input-nickname').fill('NewName'); await page.locator('#sheet-save-btn').click();
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
      const id = await page.evaluate(async () => (await import('./js/chat-state.js')).createConversation({ name: 'Group', avatar: 'group', members: ['nereus', 'momo'] }).id);
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
      await page.evaluate(async () => { const chat = await import('./js/chat-state.js'); for (const c of chat.loadChatState().conversations) chat.deleteConversation(c.id); });
      await go('chat-list.html'); assert.equal(await page.locator('.chat-item').count(), 0);
      await go('chat-room.html?conversationId=missing'); await page.waitForURL('**/chat-list.html?**');
    });
    await check('quota failure retains all old state and reports failure', async ({ page, go, dialogs }) => {
      await go('chat-room.html');
      const previous = await page.evaluate(() => localStorage.getItem('echo-chat-state-v1'));
      await page.evaluate(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
      await page.locator('#input-message').fill('unsaved'); await page.locator('#input-message').press('Enter');
      await page.waitForFunction(() => document.querySelector('#input-message').value === 'unsaved');
      assert.equal(await page.evaluate(() => localStorage.getItem('echo-chat-state-v1')), previous);
      assert.equal(await page.locator('#input-message').isEnabled(), true); assert.ok(dialogs.some(value => value.includes('保存失败')));
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
      await go('memory.html'); const other = await context.newPage(); await other.goto(base + 'home.html');
      await other.evaluate(async () => (await import('./js/memory-state.js')).saveMemory({ content: 'cross-tab-memory', charId: 'nereus' }));
      await page.waitForFunction(() => document.querySelector('#memory-main').textContent.includes('cross-tab-memory'));
    });
    await check('full reply is durable before all segments are displayed', async ({ page, go }) => {
      await configure(page); await mockChat(page, ['一\n二\n三\n四\n五']); await go('chat-room.html');
      await page.locator('#input-message').fill('test refresh'); await page.locator('#input-message').press('Enter');
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('echo-chat-state-v1')).messagesByConversation.nereus.some(m => m.text === '五'));
      await page.reload();
      assert.equal(await page.locator('.msg__bubble').last().textContent(), '五'); assert.equal(await page.locator('#input-message').isEnabled(), true);
    });
    await check('backup and restore work through the existing world buttons without exporting API keys', async ({ page, go }) => {
      await configure(page);
      await page.evaluate(async () => (await import('./js/profile-state.js')).updateProfile({ nickname: 'BackupName', archive: { hobbies: 'keep-me' } }));
      await go('world.html');
      const downloadEvent = page.waitForEvent('download'); await page.locator('#btn-backup').click();
      const download = await downloadEvent;
      const file = fs.readFileSync(await download.path());
      const backup = JSON.parse(file.toString()); assert.equal(file.toString().includes('fake-test-key'), false);
      await page.evaluate(async () => (await import('./js/profile-state.js')).updateProfile({ nickname: 'Changed' }));
      const chooserEvent = page.waitForEvent('filechooser'); await page.locator('#btn-restore').click();
      const chooser = await chooserEvent;
      await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('echo-profile-v1')).nickname === 'BackupName');
      await page.waitForLoadState('load');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('echo-profile-v1')).archive.hobbies), 'keep-me');
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
      await page.evaluate(async () => (await import('./js/memory-state.js')).saveMemory({ content: 'delete-me' }));
      await go('memory.html'); await page.locator('[data-action=delete]').click();
      assert.equal(await page.locator('.mem-card').count(), 0); assert.equal(await page.locator('#memory-empty').count(), 1);
    });
    console.log(`Browser checks passed: ${passed}`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
