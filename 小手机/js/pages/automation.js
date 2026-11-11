import { page, reportError, showToast } from '../ui-helpers.js';
import { loadCouple, updateCoupleSettings } from '../couple-state.js';
import { startAutomation } from '../automation-state.js';

function initAutomationPage() {
  if (page !== 'chat-automation.html') return;
  const form = document.querySelector('#automation-form'); if (!form) return;
  const settings = loadCouple();
  for (const [id, key] of [['auto-messages', 'autoMessages'], ['auto-moments', 'autoMoments'], ['include-images', 'includeImages'], ['show-thoughts', 'showThoughts']]) document.getElementById(id).checked = settings[key];
  document.getElementById('interval-minutes').value = settings.intervalMinutes; document.getElementById('summary-rounds').value = settings.summarizeRounds;
  const runner = startAutomation({ onError: reportError });
  form.addEventListener('submit', async event => { event.preventDefault(); try { await updateCoupleSettings({ autoMessages: document.getElementById('auto-messages').checked, autoMoments: document.getElementById('auto-moments').checked, includeImages: document.getElementById('include-images').checked, showThoughts: document.getElementById('show-thoughts').checked, intervalMinutes: document.getElementById('interval-minutes').value, summarizeRounds: document.getElementById('summary-rounds').value }); runner.reset(); void showToast('聊天设置已保存'); } catch (error) { reportError(error); } });
  document.getElementById('run-now')?.addEventListener('click', () => runner.run());
  window.addEventListener('pagehide', () => runner.stop(), { once: true });
}
export async function initPage() { initAutomationPage(); }
