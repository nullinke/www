/**
 * api.js — AI 对话接口
 *
 * 支持 OpenAI 兼容格式（Chat Completions），流式 SSE 输出。
 * 从 settings-state 读取 baseUrl / apiKey / model。
 */

import { loadSettings } from './settings-state.js';

/**
 * 构建发送给 API 的消息数组
 *  - system: 角色设定 + 世界书摘要（如有）
 *  - 历史消息（裁剪至 contextLimit 条）
 */
function buildMessages(conversation, historyMessages, settings) {
  const msgs = [];

  // System prompt：角色设定
  const personaParts = [];
  if (conversation.name) {
    personaParts.push(`你的名字是 ${conversation.name}。`);
  }
  if (conversation.alias) {
    personaParts.push(`对方叫你 ${conversation.alias}。`);
  }
  if (conversation.persona) {
    personaParts.push(conversation.persona);
  }
  if (personaParts.length) {
    msgs.push({ role: 'system', content: personaParts.join('\n') });
  }

  // 上下文长度：取 parameters.context（单位 k → 条数近似，每条约 200 token）
  const ctxK = settings.parameters?.context?.value ?? 32;
  const maxTurns = Math.max(4, Math.floor(ctxK * 1000 / 200));

  // 裁剪历史，保留最近 maxTurns 条
  const trimmed = historyMessages.slice(-maxTurns);

  // 过滤空内容 + 错误提示消息，并合并相邻同角色（避免 user/user 连续）
  const valid = trimmed.filter((msg) =>
    typeof msg.text === 'string' &&
    msg.text.trim().length > 0 &&
    !msg.text.startsWith('⚠') &&
    msg.text !== '…'
  );

  const merged = [];
  for (const msg of valid) {
    const role = msg.author === 'mine' ? 'user' : 'assistant';
    const last = merged[merged.length - 1];
    if (last && last.role === role) {
      // 同角色合并为一条，换行分隔
      last.content += '\n' + msg.text.trim();
    } else {
      merged.push({ role, content: msg.text.trim() });
    }
  }

  // 确保第一条是 user（部分 API 要求）
  while (merged.length && merged[0].role !== 'user') {
    merged.shift();
  }

  msgs.push(...merged);
  return msgs;
}

/**
 * 流式调用 API，逐 token 回调 onChunk(text)，完成后回调 onDone(fullText)
 * 出错时回调 onError(err)
 *
 * @returns {Function} abort — 调用可中断请求
 */
export async function streamChat({
  conversation,
  historyMessages,
  onChunk,
  onDone,
  onError,
}) {
  const settings = loadSettings();
  const modelCfg = settings.models?.text ?? {};

  const baseUrl = (typeof modelCfg === 'object' ? modelCfg.baseUrl : '') || '';
  const apiKey  = (typeof modelCfg === 'object' ? modelCfg.apiKey  : '') || '';
  const model   = (typeof modelCfg === 'object' ? modelCfg.name    : String(modelCfg)) || 'gpt-4o';

  // 未配置 Key 时给友好提示
  if (!apiKey) {
    onError(new Error('尚未配置 API Key，请前往「设置 → 文字模型」填写。'));
    return () => {};
  }

  const endpoint = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
    : 'https://api.openai.com/v1/chat/completions';

  const temperature = settings.parameters?.temperature?.value ?? 0.8;
  const timeout     = settings.parameters?.timeout            ?? 60;

  const messages = buildMessages(conversation, historyMessages, settings);

  // messages 里必须有至少一条 user 消息，否则无意义
  if (!messages.some((m) => m.role === 'user')) {
    onError(new Error('没有有效的对话内容，请重新发送'));
    return () => {};
  }

  // 构造请求体
  const requestBody = JSON.stringify({ model, messages, temperature, stream: true });

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: requestBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let msg = `API ${response.status}`;
      try {
        const j = JSON.parse(errText);
        msg = j?.error?.message || j?.message || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText  = '';
    let buffer    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // 末尾可能是不完整行，留到下次

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json  = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onChunk(delta, fullText);
          }
        } catch { /* 解析失败直接跳过 */ }
      }
    }

    clearTimeout(tid);
    onDone(fullText);

  } catch (err) {
    clearTimeout(tid);
    if (err.name === 'AbortError') {
      onError(new Error('请求超时，请检查网络或增大超时设置'));
    } else {
      onError(err);
    }
  }

  return () => controller.abort();
}
