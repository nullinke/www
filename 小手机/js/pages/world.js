import { page, reportError } from '../ui-helpers.js';
import { createBackup, restoreBackup } from '../storage-state.js';
import { collectUnusedAssets } from '../database-state.js';

function initBackupActions() {
  if (page !== 'world.html') return;
  document.getElementById('btn-backup')?.addEventListener('click', async () => {
    try {
      const blob = new Blob([JSON.stringify(await createBackup(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `echo-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Explicit backup is a suitable maintenance point; chat startup never scans the whole database.
      void collectUnusedAssets().catch(error => console.warn('[Echo] 资源回收未完成：', error.message));
    } catch (error) { reportError(error); }
  });
  document.getElementById('btn-restore')?.addEventListener('click', () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      try {
        const file = input.files?.[0]; if (!file) return;
        if (file.size > 128 * 1024 * 1024) throw new Error('备份文件过大。');
        const backup = JSON.parse(await file.text());
        if (!confirm('将恢复备份中包含的数据。请确认已导出当前备份。API Key 不会从文件导入。')) return;
        await restoreBackup(backup); alert('恢复完成。'); window.location.reload();
      } catch (error) { reportError(error); }
    });
    input.click();
  });
}

export async function initPage() { initBackupActions(); }
