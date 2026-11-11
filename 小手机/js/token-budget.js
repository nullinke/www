/** Text-only Chat Completions accounting. Provider-added tokens are covered by a margin, not claimed exact. */
const encoders = new Map();
const bytes = new TextEncoder();
export const fallbackCounter = {
  name: 'utf8-upper-estimate', exactText: false,
  countText: value => bytes.encode(String(value)).length,
  countMessages(messages) { return 3 + messages.reduce((sum, message) => sum + 6 + this.countText(message.role) + this.countText(message.content), 0); },
};
export function modelSpec(name = '') {
  const id = String(name).toLowerCase();
  if (/^(?:gpt-4o(?:-|$)|chatgpt-4o(?:-|$)|gpt-4\.1(?:-|$))/.test(id)) return { encoding: 'o200k_base', context: id.startsWith('gpt-4.1') ? 1047576 : 128000, outputField: 'max_tokens', sampling: true };
  if (/^gpt-3\.5-turbo(?:-|$)/.test(id)) return { encoding: 'cl100k_base', context: 16385, outputField: 'max_tokens', sampling: true };
  if (/^gpt-4(?:-|$)/.test(id)) return { encoding: 'cl100k_base', context: /turbo|preview|1106|0125/.test(id) ? 128000 : id.includes('32k') ? 32768 : 8192, outputField: 'max_tokens', sampling: true };
  if (/^(?:o[134](?:-|$)|gpt-5(?:-|$))/.test(id)) return { encoding: null, context: Infinity, outputField: 'max_completion_tokens', sampling: false };
  return { encoding: null, context: Infinity, outputField: 'max_tokens', sampling: true };
}
export async function tokenCounter(model) {
  const { encoding } = modelSpec(model);
  if (!encoding) return fallbackCounter;
  if (!encoders.has(encoding)) encoders.set(encoding, (async () => {
    const [{ Tiktoken }, rank] = await Promise.all([
      import('./vendor/tokenizer/engine.js'),
      encoding === 'o200k_base' ? import('./vendor/tokenizer/o200k_base.js') : import('./vendor/tokenizer/cl100k_base.js'),
    ]);
    const tokenizer = new Tiktoken(rank.default);
    return {
      name: encoding, exactText: true,
      countText: value => tokenizer.encode(String(value), [], []).length,
      countMessages(messages) { return 3 + messages.reduce((sum, message) => sum + 3 + this.countText(message.role) + this.countText(message.content), 0); },
    };
  })().catch(() => fallbackCounter));
  return encoders.get(encoding);
}
export function requestBudget(settings, outputLimit) {
  const value = Number(settings.parameters?.context?.value || 32) * 1000;
  const configured = Number.isFinite(value) ? Math.min(64000, Math.max(8000, value)) : 32000;
  const context = Math.min(configured, modelSpec(settings.models?.text?.name).context);
  const output = Math.min(Math.max(1, Number(outputLimit) || 2048), Math.floor(context / 4));
  const margin = 256;
  return { context, output, margin, input: context - output - margin };
}
export function assertRequestBudget(messages, settings, counter, outputLimit) {
  const budget = requestBudget(settings, outputLimit);
  const inputTokens = counter.countMessages(messages);
  if (inputTokens > budget.input) throw new Error('当前消息或角色设定超出上下文预算，请缩短内容或增加上下文长度。');
  return { ...budget, inputTokens, counter: counter.name };
}
