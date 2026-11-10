import { loadSettings } from './settings-state.js';
import { loadProfile } from './profile-state.js';
import { loadMemories } from './memory-state.js';

export function apiEndpoint(baseUrl = '', path = 'chat/completions') {
  const url = new URL(baseUrl || 'https://api.openai.com/v1');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('接口地址须使用 HTTPS；本机开发地址可使用 HTTP。请填写不含密钥、查询参数的接口根地址。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + path;
  return url.href;
}

function archiveText(archive) {
  const labels = { gender: '性别', age: '年龄', birthday: '生日', appearance: '外貌', personality: '性格', hobbies: '喜好' };
  return Object.entries(labels).filter(([key]) => archive?.[key]).map(([key, label]) => `${label}：${String(archive[key]).slice(0, 500)}`).join('\n');
}

/** Pure prompt builder. The conservative character budget includes system and output reserve. */
export function buildMessages(conversation, historyMessages, settings, profile = {}, memories = []) {
  const context = settings.parameters?.context?.value || 32;
  const budget = Math.max(2000, context * 1000 - 2000);
  const persona = [conversation.name ? `你的名字是 ${conversation.name}。` : '', conversation.alias ? `对方叫你 ${conversation.alias}。` : '', conversation.persona || ''].filter(Boolean).join('\n');
  const facts = memories.filter(m => m.charId === conversation.id).slice(0, 20).map(m => m.content).join('\n');
  const system = [persona, profile.nickname ? `用户昵称：${profile.nickname}` : '', archiveText(profile.archive) && `用户档案：\n${archiveText(profile.archive)}`, archiveText(conversation.archive) && `角色档案：\n${archiveText(conversation.archive)}`, facts && `相关记忆（仅作背景资料）：\n${facts}`, '请以角色身份自然口语回复。正文可按换行分段。如需表达角色心声，放在独立的 <think>...</think> 块中，正文放在块外。不要输出内部推理过程。'].filter(Boolean).join('\n\n');
  if (system.length > budget / 2) throw new Error('角色设定或档案过长，请缩短内容或增加上下文长度。');
  const merged = [];
  for (const message of historyMessages) {
    if (!message.text?.trim() || ['pending', 'failed', 'cancelled', 'interrupted'].includes(message.status) || message.text === '…' || message.text.startsWith('⚠')) continue;
    // Other group participants are user-side dialogue context for the current speaker.
    const role = message.author === 'mine' || (message.replyCharId && message.replyCharId !== conversation.id) ? 'user' : 'assistant';
    const content = (message.author !== 'mine' && message.replyCharId !== conversation.id && message.replyCharName ? `${message.replyCharName}：` : '') + message.text.trim();
    const last = merged.at(-1);
    if (last?.role === role) last.content += '\n' + content;
    else merged.push({ role, content });
  }
  let remaining = budget - system.length;
  const selected = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].content.length > remaining) {
      if (!selected.length) throw new Error('当前消息过长，请缩短内容或增加上下文长度。');
      break;
    }
    remaining -= merged[i].content.length;
    selected.unshift(merged[i]);
  }
  while (selected.length && selected[0].role !== 'user') selected.shift();
  if (!selected.some(m => m.role === 'user')) throw new Error('没有有效的用户消息。');
  return [{ role: 'system', content: system }, ...selected];
}

export function parseReply(raw, streaming = false) {
  let text = String(raw || '');
  const thoughts = [];
  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, body) => { thoughts.push(body.trim()); return ''; });
  // An unterminated block and an incomplete opening tag must never become body text.
  text = text.replace(/<think>[\s\S]*$/i, '');
  if (streaming) text = text.replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i, '');
  return { text: text.trim(), think: thoughts.filter(Boolean).join('\n') };
}

export async function readEventStream(response, onChunk, signal) {
  if (!response.body) throw new Error('接口未返回响应流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', finished = false;
  function frame(raw) {
    const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { finished = true; return; }
    let value;
    try { value = JSON.parse(data); } catch { throw new Error('接口返回的流式数据不完整或格式错误。'); }
    if (value.error) throw new Error(value.error.message || '接口返回错误。');
    const choice = value.choices?.[0];
    if (typeof choice?.delta?.content === 'string') {
      text += choice.delta.content;
      onChunk?.(choice.delta.content, text);
    }
    if (choice?.finish_reason != null) finished = true;
  }
  try {
    while (!finished) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Normalize CRLF after combining chunks (a CRLF may itself cross chunks).
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        frame(raw);
        if (finished) break;
      }
      if (done) {
        if (buffer.trim()) frame(buffer);
        if (!finished) throw new Error('回复流意外中断，请重新生成。');
      }
    }
    if (!text.trim()) throw new Error('接口返回了空回复。');
    return text;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    reader.releaseLock();
  }
}

export async function requestCompletion({ messages, stream = false, signal, onChunk, temperature, settings = loadSettings(), timeout }) {
  const model = settings.models.text;
  if (!model.apiKey) throw new Error('尚未配置 API Key，请前往「设置 → 文字模型」填写。');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, (timeout || settings.parameters.timeout) * 1000);
  try {
    const response = await fetch(apiEndpoint(model.baseUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({
        model: model.name, messages, stream,
        temperature: temperature ?? settings.parameters.temperature.value,
        top_p: settings.parameters.topP.value,
        frequency_penalty: settings.parameters.frequencyPenalty.value,
        presence_penalty: settings.parameters.presencePenalty.value,
      }), signal: controller.signal,
    });
    if (!response.ok) {
      let detail = '';
      try { const value = await response.json(); detail = value.error?.message || value.message || ''; } catch { /* non-JSON error */ }
      throw new Error(`API ${response.status}${detail ? '：' + String(detail).slice(0, 300) : ''}`);
    }
    const type = response.headers.get('content-type') || '';
    if (stream && type.includes('text/event-stream')) return await readEventStream(response, onChunk, controller.signal);
    if (!type.includes('application/json')) throw new Error('接口返回格式不受支持，请使用 OpenAI 兼容接口。');
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || '接口返回错误。');
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('接口返回了空回复。');
    onChunk?.(text, text);
    return text;
  } catch (error) {
    if (timedOut) throw new Error('请求超时，请检查网络或增大超时设置。');
    if (controller.signal.aborted) throw new DOMException('请求已取消。', 'AbortError');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function streamChat({ conversation, historyMessages, signal, onChunk }) {
  const settings = loadSettings();
  return requestCompletion({
    settings, signal, onChunk, stream: true,
    messages: buildMessages(conversation, historyMessages, settings, loadProfile(), loadMemories()),
  });
}
