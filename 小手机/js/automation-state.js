import { loadCouple, updateCoupleSettings } from './couple-state.js';
import { loadSettings } from './settings-state.js';
import { getConversation, appendMessage, getMessages } from './chat-state.js';
import { addPost } from './moments-state.js';
import { apiEndpoint } from './api.js';

export async function generateImage(prompt) {
  const model = loadSettings().models.image;
  if (!model.apiKey || !model.baseUrl) throw new Error('请先在设置中配置生图模型地址和 Key。');
  const response = await fetch(apiEndpoint(model.baseUrl, 'images/generations'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model.apiKey}` }, body: JSON.stringify({ model: model.name, prompt, n: 1, size: '512x512' }) });
  if (!response.ok) throw new Error(`生图接口 ${response.status}`);
  const json = await response.json(); const item = json.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url && /^https:\/\//.test(item.url)) return item.url;
  throw new Error('生图接口没有返回图片。');
}

export async function runAutomationOnce({ signal } = {}) {
  const settings = loadCouple(), character = getConversation(settings.charId);
  if (!character) throw new Error('请先在情侣空间选择一个角色。');
  const textModel = loadSettings().models.text;
  if (!textModel.apiKey) throw new Error('请先配置文字模型 Key。');
  const recent = getMessages(character.id).slice(-settings.summarizeRounds).map(row => `${row.author === 'mine' ? '我' : character.name}：${row.text}`).join('\n');
  if (settings.autoMessages) {
    const response = await fetch(apiEndpoint(textModel.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${textModel.apiKey}` }, signal, body: JSON.stringify({ model: textModel.name, stream: false, messages: [{ role: 'system', content: `你是${character.name}，主动给用户发一条自然简短的消息。${settings.showThoughts ? '可在独立 <think> 块写心声。' : '不要输出心声。'}` }, { role: 'user', content: recent || '请主动开始一段对话。' }], max_tokens: 512 }) });
    if (!response.ok) throw new Error(`自动消息接口 ${response.status}`);
    const json = await response.json(); const text = json.choices?.[0]?.message?.content?.trim();
    if (text) await appendMessage(character.id, { author: 'peer', replyCharId: character.id, replyCharName: character.name, text, status: 'complete', turnId: `auto-${Date.now()}` });
  }
  if (settings.autoMoments) {
    const response = await fetch(apiEndpoint(textModel.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${textModel.apiKey}` }, signal, body: JSON.stringify({ model: textModel.name, stream: false, messages: [{ role: 'system', content: `为${character.name}写一条朋友圈动态，返回纯文本，不超过80字。` }, { role: 'user', content: recent || '写一条今天的动态。' }], max_tokens: 256 }) });
    if (!response.ok) throw new Error(`自动朋友圈接口 ${response.status}`);
    const json = await response.json(); const text = json.choices?.[0]?.message?.content?.trim();
    const images = settings.includeImages ? [await generateImage(text || '温柔的日常生活场景')] : [];
    if (text) await addPost(text, images, { authorId: character.id, authorName: character.name, authorType: 'peer' });
  }
}

export function startAutomation({ onError } = {}) {
  let timer = null, controller = null;
  const schedule = () => { const settings = loadCouple(); if (!settings.autoMessages && !settings.autoMoments) return; controller = new AbortController(); void runAutomationOnce({ signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') onError?.(error); }).finally(() => { controller = null; }); };
  const reset = () => { if (timer) clearInterval(timer); const minutes = loadCouple().intervalMinutes; timer = setInterval(schedule, minutes * 60 * 1000); };
  reset();
  return { run: schedule, reset, stop() { clearInterval(timer); controller?.abort(); }, update: updateCoupleSettings };
}
