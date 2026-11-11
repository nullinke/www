import test from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

test('lint file matching covers nested controllers, tests and tools while excluding generated vendor files', async () => {
  const eslint = new ESLint();
  for (const filePath of ['js/chat-app.js', 'js/pages/chat-room.js', 'tests/state-api.test.js', 'tools/vendor-tokenizer.mjs', 'tests/browser.cjs', 'tools/benchmark.cjs']) {
    const result = (await eslint.lintText('missingLintIdentifier();', { filePath }))[0];
    assert.ok(result.messages.some(message => message.ruleId === 'no-undef'), filePath + ' was not checked');
  }
  assert.equal(await eslint.isPathIgnored('js/vendor/tokenizer/engine.js'), true);
  assert.equal((await eslint.lintText('document.title = "ok";', { filePath: 'js/pages/probe.js' }))[0].errorCount, 0);
  assert.equal((await eslint.lintText('require("node:fs");', { filePath: 'tests/probe.cjs' }))[0].errorCount, 0);
});
