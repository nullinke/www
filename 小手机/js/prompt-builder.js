import { fallbackCounter, requestBudget } from './token-budget.js';

function archiveText(archive) {
  const labels = { gender: '性别', age: '年龄', birthday: '生日', appearance: '外貌', personality: '性格', hobbies: '喜好' };
  return Object.entries(labels).filter(([key]) => archive?.[key]).map(([key, label]) => `${label}：${String(archive[key]).slice(0, 500)}`).join('\n');
}
function merge(messages) {
  const merged = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) previous.content += '\n' + message.content;
    else merged.push({ role: message.role, content: message.content });
  }
  return merged;
}
/** Trim stored context for the request only. The latest real user message is never silently truncated. */
export function buildPrompt(conversation, history, settings, profile = {}, memories = [], counter = fallbackCounter) {
  const budget = requestBudget(settings);
  const valid = history.filter(message => typeof message.text === 'string' && message.text.trim() && !['pending', 'failed', 'cancelled', 'interrupted'].includes(message.status) && message.text !== '…' && !message.text.startsWith('⚠'));
  const anchor = valid.findLastIndex(message => message.author === 'mine');
  if (anchor < 0) throw new Error('没有有效的用户消息。');
  const rows = valid.map((message, index) => ({
    index,
    role: message.author === 'mine' || (message.replyCharId && message.replyCharId !== conversation.id) ? 'user' : 'assistant',
    content: (message.author !== 'mine' && message.replyCharId !== conversation.id && message.replyCharName ? `${message.replyCharName}：` : '') + message.text.trim(),
  }));
  let system = [conversation.name ? `你的名字是 ${conversation.name}。` : '', conversation.alias ? `对方叫你 ${conversation.alias}。` : '', conversation.persona || '', '请以角色身份自然口语回复。正文可按换行分段。如需表达角色心声，放在独立的 <think>...</think> 块中，正文放在块外。不要输出内部推理过程。'].filter(Boolean).join('\n');
  const systemMessage = () => ({ role: 'system', content: system });
  if (counter.countMessages([systemMessage(), rows[anchor]]) > budget.input) throw new Error('当前消息或角色设定超出上下文预算，请缩短内容或增加上下文长度。');
  const sections = [
    profile.nickname ? `用户昵称：${profile.nickname}` : '',
    archiveText(profile.archive) && `用户档案：\n${archiveText(profile.archive)}`,
    archiveText(conversation.archive) && `角色档案：\n${archiveText(conversation.archive)}`,
    ...memories.filter(item => item.charId === conversation.id).slice(0, 20).map(item => `相关记忆（仅作背景资料）：${String(item.content).slice(0, 200)}`),
  ].filter(Boolean);
  let omittedSections = 0;
  for (const section of sections) {
    const candidate = { role: 'system', content: system + '\n\n' + section };
    if (counter.countMessages([candidate, rows[anchor]]) <= budget.input) system = candidate.content;
    else omittedSections++;
  }
  const selected = [rows[anchor]];
  let remaining = budget.input - counter.countMessages([systemMessage(), rows[anchor]]);
  const add = row => {
    // Separate-message cost is deliberately conservative; final merged messages are counted again.
    const cost = counter.countMessages([row]);
    if (cost > remaining) return false;
    remaining -= cost; selected.push(row); return true;
  };
  for (let index = rows.length - 1; index > anchor; index--) add(rows[index]);
  for (let index = anchor - 1; index >= 0; index--) if (!add(rows[index])) break;
  selected.sort((a, b) => a.index - b.index);
  while (selected[0].role !== 'user') selected.shift();
  let messages = [systemMessage(), ...merge(selected)];
  while (counter.countMessages(messages) > budget.input && selected.length > 1) {
    const removable = selected.findIndex(row => row.index !== anchor);
    selected.splice(removable, 1);
    while (selected[0].role !== 'user') selected.shift();
    messages = [systemMessage(), ...merge(selected)];
  }
  const inputTokens = counter.countMessages(messages);
  if (inputTokens > budget.input) throw new Error('当前请求超出上下文预算。');
  return { messages, budget: { ...budget, inputTokens, counter: counter.name, exactText: counter.exactText }, omittedSections, retainedMessages: selected.length };
}
export function buildMessages(...args) { return buildPrompt(...args).messages; }
