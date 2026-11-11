import { streamChat, parseReply, requestCompletion } from './api.js';
import { loadSettings, subscribeToSettings } from './settings-state.js';
import { StorageError, uniqueId } from './storage-state.js';
import { getConversation, findMessage, loadReplyHistory, appendMessage, replaceReplyTurn, updateMessage, withReplyTask } from './chat-state.js';
import { saveExtractedMemories } from './memory-state.js';

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
/** Business orchestration only. UI access is confined to callbacks supplied by the page. */
export function createReplyRunner({ conversationId, onState, onUserCommitted, onChunk, onStaging, onReveal, onFinish }, { chat = streamChat, completion = requestCompletion, pause = delay } = {}) {
  let active = null, owner = null, disposed = false;
  const memoryJobs = new Set();
  const unsubscribe = subscribeToSettings(settings => { if (!settings.memory.autoExtract) for (const job of memoryJobs) job.abort(); });
  const state = () => onState?.({ running: Boolean(active), owner });
  function extract(speaker, sourceUserMessage, reply, turnId, sourceMessages, settings) {
    if (!settings.models.text.apiKey || !settings.memory.autoExtract || !loadSettings().memory.autoExtract || disposed || memoryJobs.size >= 2) return;
    const controller = new AbortController(); memoryJobs.add(controller);
    void (async () => {
      try {
        const raw = await completion({
          settings, signal: controller.signal, temperature: 0.3, timeout: 20, maxOutputTokens: 512,
          messages: [
            { role: 'system', content: '提取对话中明确的约定、事件、喜好或羁绊。只返回 JSON 数组，每项为 {"content":"20字以内的事实","tags":["约定"或"事件"或"喜好"或"羁绊"]}。不记录普通寒暄或推测，最多3项，没有则返回 []。' },
            { role: 'user', content: `用户：${(sourceUserMessage?.text || '').slice(0, 4000)}\n${speaker.name}：${reply.slice(0, 4000)}` },
          ],
        });
        controller.signal.throwIfAborted();
        const items = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (Array.isArray(items)) await saveExtractedMemories({ conversationId, charId: speaker.id, turnId, sourceMessages, sourceUserMessage, items });
      } catch (error) { if (error.name !== 'AbortError') console.warn('[Echo] 记忆提取未完成：', error.message); }
      finally { memoryJobs.delete(controller); }
    })();
  }
  async function run({ regenerateMessage = null, userText = '' } = {}) {
    if (active || disposed) return false;
    const settings = loadSettings();
    active = new AbortController();
    try {
      state();
      await withReplyTask(conversationId, { signal: active.signal }, async session => {
        owner = session.owner; state();
        try {
          if (userText) {
            await appendMessage(conversationId, { author: 'mine', text: userText }, { owner, clearDraft: true });
            onUserCommitted?.();
          }
          const current = getConversation(conversationId);
          let speakers;
          if (regenerateMessage) {
            const speaker = getConversation(regenerateMessage.replyCharId || (current.avatar !== 'group' ? current.id : ''));
            if (!speaker) throw new StorageError('无法确定原回复角色，请发送新消息。');
            speakers = [speaker];
          } else speakers = current.avatar === 'group' ? (current.members || []).map(id => getConversation(id)).filter(Boolean) : [current];
          if (!speakers.length) throw new StorageError('群聊已没有可回复的成员。');
          for (const original of speakers) {
            if (current.avatar === 'group' && !regenerateMessage) await pause(600 + Math.floor(Math.random() * 800), session.signal);
            session.signal.throwIfAborted();
            const speaker = getConversation(original.id); if (!speaker) continue;
            const history = await loadReplyHistory(conversationId, { message: regenerateMessage, maxChars: settings.parameters.context.value * 8000 });
            const turnId = regenerateMessage?.turnId || uniqueId('turn-'), pendingId = uniqueId('message-');
            const identity = { author: 'peer', replyCharId: speaker.id, replyCharName: speaker.name, replyCharInitial: speaker.initial, turnId };
            await appendMessage(conversationId, { ...identity, id: pendingId, text: '…', status: 'pending' }, { owner });
            try {
              const raw = await chat({ conversation: speaker, historyMessages: history, signal: session.signal, settings, onChunk: (_, text) => onChunk?.({ messageId: pendingId, text: parseReply(text, true).text || '…' }) });
              session.signal.throwIfAborted();
              const reply = parseReply(raw); if (!reply.text) throw new Error('回复没有正文，请重新生成。');
              const paragraphs = reply.text.split('\n').map(text => text.trim()).filter(Boolean);
              // Bound presentation timers while preserving all body text.
              const parts = paragraphs.length > 128 ? [...paragraphs.slice(0, 127), paragraphs.slice(127).join('\n')] : paragraphs;
              const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
              const entries = parts.map((text, index) => ({ ...identity, id: uniqueId('message-'), text, time, status: 'complete', ...(index === 0 && reply.think ? { think: reply.think } : {}) }));
              onStaging?.(entries);
              await replaceReplyTurn(conversationId, turnId, entries, regenerateMessage && !regenerateMessage.turnId ? regenerateMessage.id : null, { owner });
              for (const entry of entries.slice(1)) { await pause(420, session.signal); onReveal?.(entry.id); }
              extract(speaker, history.filter(message => message.author === 'mine').at(-1), reply.text, turnId, entries.map(({ id, text }) => ({ id, text })), settings);
            } catch (error) {
              if (error instanceof StorageError) throw error;
              if ((await findMessage(conversationId, pendingId))?.status === 'pending') await updateMessage(conversationId, pendingId, { text: error.name === 'AbortError' ? '⚠ 回复已取消，可重新生成' : `⚠ ${error.message}`, status: error.name === 'AbortError' ? 'cancelled' : 'failed' }, { owner });
              if (error.name === 'AbortError') throw error;
            }
          }
        } finally { owner = null; }
      });
      return true;
    } finally { active = null; owner = null; try { state(); } finally { onFinish?.(); } }
  }
  return {
    run,
    cancel() { active?.abort(); },
    dispose() { disposed = true; unsubscribe(); active?.abort(); for (const job of memoryJobs) job.abort(); },
    get running() { return Boolean(active); },
    get owner() { return owner; },
  };
}
