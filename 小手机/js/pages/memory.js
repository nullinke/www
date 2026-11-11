import { formatMemoryDate, deleteMemory, filterMemories, subscribeToMemories } from '../memory-state.js';
import { escapeHtml, page, showConfirm } from '../ui-helpers.js';

function buildMemoryCard(mem) {
  const article = document.createElement('article');
  article.className = 'mem-card glass';
  article.dataset.memId = String(mem.id);

  // 来源标签：区分 source
  const sourceLabel = mem.source === 'system' ? 'Echo 记的' : '我记的';
  const tagsText = mem.tags.length ? mem.tags.map((t) => `#${t}`).join('  ') : '';
  const dateText = formatMemoryDate(mem.createdAt);

  article.innerHTML = `
    <p class="mem-card__meta">${sourceLabel} · ${dateText}</p>
    <p class="mem-card__text">${escapeHtml(mem.content)}</p>
    <div class="mem-card__foot">
      <div class="mem-card__tags">${tagsText ? escapeHtml(tagsText) : ''}</div>
      <button class="mem-card__more" data-action="delete" aria-label="删除记忆">
        删除<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
      </button>
    </div>
  `;

  article.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!await showConfirm('删除后无法恢复这条记忆。', { title: '删除记忆', confirmText: '删除', tone: 'danger' })) return;
    await deleteMemory(mem.id);

  });

  return article;
}


function renderMemoryEmpty(container) {
  const empty = document.createElement('p');
  empty.id = 'memory-empty';
  empty.style.cssText = 'text-align:center;color:var(--brand-muted);font-size:13px;padding:32px 0;';
  empty.textContent = '还没有记忆，对话中有意义的内容会自动提取，也可输入「记住：…」手动记录';
  container.appendChild(empty);
}


function initMemoryPage() {
  if (page !== 'memory.html') return;

  const container = document.getElementById('memory-main');
  const searchInput = document.getElementById('search-memory-input');
  const filterChips = document.querySelectorAll('#memory-filter .filter-chip');
  if (!container) return;

  // 移除静态 mock 卡片（保留搜索栏和筛选行）
  container.querySelectorAll('.mem-card').forEach((el) => el.remove());

  let activeTag = '';  // '' | 'promise' | 'event' | 'hobby'
  let activeQuery = '';

  function render() {
    // 清除上次动态卡片和空态
    container.querySelectorAll('.mem-card, #memory-empty').forEach((el) => el.remove());
    const list = filterMemories(activeQuery, activeTag);
    if (list.length === 0) {
      renderMemoryEmpty(container);
    } else {
      const fragment = document.createDocumentFragment();
      list.forEach((mem) => fragment.appendChild(buildMemoryCard(mem)));
      container.appendChild(fragment);
    }
  }

  // 搜索
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      activeQuery = searchInput.value;
      render();
    });
  }

  // chip 筛选
  const TAG_KEY_MAP = {
    'filter-all':     '',
    'filter-promise': 'promise',
    'filter-event':   'event',
    'filter-hobby':   'hobby',
  };
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('filter-chip--active'));
      chip.classList.add('filter-chip--active');
      activeTag = TAG_KEY_MAP[chip.id] ?? '';
      render();
    });
  });

  // 监听聊天室写入（同一标签页内通过 CustomEvent 通知）
  subscribeToMemories(render);

  render();
}

export async function initPage() { initMemoryPage(); }
