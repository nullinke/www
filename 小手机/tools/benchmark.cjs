const { chromium } = require('playwright');
const { createServer } = require('../../scripts/serve.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/%E5%B0%8F%E6%89%8B%E6%9C%BA/`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const results = [];
  try {
    for (const size of [100, 1000, 10000]) {
      const samples = [];
      for (let run = 0; run < 3; run++) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(base + 'home.html'); await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
        const restoreMs = await page.evaluate(async count => {
          const chat = await import('./js/chat-state.js'), storage = await import('./js/storage-state.js');
          const state = chat.defaultChatState();
          state.messagesByConversation.nereus = Array.from({ length: count }, (_, i) => ({ id: 'perf-' + i, author: i % 2 ? 'mine' : 'peer', text: '历史样本 ' + i + ' ' + 'text '.repeat(16), time: '12:00' }));
          const start = performance.now();
          await storage.restoreBackup({ format: 'echo-backup', version: 1, data: { 'echo-chat-state-v1': JSON.stringify(state) } });
          return performance.now() - start;
        }, size);
        const start = performance.now(); await page.goto(base + 'chat-room.html'); await page.waitForFunction(() => window.echoReady); await page.evaluate(() => window.echoReady);
        const openMs = performance.now() - start;
        assert.equal(await page.locator('.msg').count(), 100);
        const writes = await page.evaluate(async () => {
          const chat = await import('./js/chat-state.js');
          const original = IDBObjectStore.prototype.getAll; const scans = { messages: 0, records: 0 };
          IDBObjectStore.prototype.getAll = function (...args) { if (Object.hasOwn(scans, this.name)) scans[this.name]++; return original.apply(this, args); };
          const retained = [...document.querySelectorAll('.msg')].at(-1);
          try {
            let start = performance.now();
            for (let i = 0; i < 10; i++) await chat.setDraft('nereus', 'typing-' + i);
            const draftMs = (performance.now() - start) / 10;
            start = performance.now();
            for (let i = 0; i < 10; i++) await chat.appendMessage('nereus', { author: 'mine', text: 'append-' + i });
            const appendMs = (performance.now() - start) / 10;
            return { draftMs, appendMs, scans, retainedNode: retained.isConnected, visibleRows: document.querySelectorAll('.msg').length };
          } finally { IDBObjectStore.prototype.getAll = original; }
        });
        assert.deepEqual(writes.scans, { messages: 0, records: 0 }); assert.equal(writes.retainedNode, true); assert.equal(writes.visibleRows, 100);
        samples.push({ restoreMs, openMs, ...writes }); await context.close();
      }
      const median = name => +samples.map(sample => sample[name]).sort((a, b) => a - b)[1].toFixed(2);
      results.push({ messages: size, median: { restoreMs: median('restoreMs'), openMs: median('openMs'), draftMs: median('draftMs'), appendMs: median('appendMs') }, samples });
    }
    const report = { measuredAt: new Date().toISOString(), node: process.version, chromium: browser.version(), viewport: '390x844', repeats: 3, externalRequests: 'blocked', note: 'Isolated desktop Chromium; these timings are observations, not mobile-device targets.', results };
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
