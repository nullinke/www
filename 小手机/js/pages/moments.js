import { page, escapeHtml, showConfirm, showPrompt } from '../ui-helpers.js';
import { safeImage } from '../storage-state.js';
import { loadProfile, subscribeToProfile } from '../profile-state.js';
import { loadChatState } from '../chat-state.js';
import { toggleLike, loadPosts, subscribeToPosts, addPost, addComment, deletePost } from '../moments-state.js';

function initMomentsPage() {
  if (page !== 'moments.html') return;

  const coverImg  = document.getElementById('cover-img');
  const myAvatar  = document.getElementById('moments-my-avatar');
  const myInitial = document.getElementById('moments-my-initial');
  const postList  = document.getElementById('post-list');
  const composer  = document.getElementById('btn-composer');

  // ── Profile 同步 ──────────────────────────────────────────────────────────
  function applyCover(p) {
    if (coverImg && p.coverImage) {
      coverImg.src = safeImage(p.coverImage);
      coverImg.classList.add('is-loaded');
    } else if (coverImg) {
      coverImg.classList.remove('is-loaded');
    }
  }

  function applyMyAvatar(p) {
    if (!myAvatar) return;
    if (p.avatarData) {
      myAvatar.innerHTML = `<img src="${safeImage(p.avatarData)}" alt="${escapeHtml(p.nickname)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      if (myInitial) myInitial.textContent = (p.nickname || '我').charAt(0);
    }
  }

  function refreshProfile() {
    const p = loadProfile();
    applyCover(p);
    applyMyAvatar(p);
  }

  refreshProfile();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshProfile();
  });
  subscribeToProfile(refreshProfile);

  // ── 帖子渲染 ──────────────────────────────────────────────────────────────
  function buildAvatar(post) {
    const div = document.createElement('div');
    div.className = `avatar avatar--${post.authorType}`;

    // 「我」的帖子：优先用 profile 的最新头像和昵称首字
    if (post.authorType === 'mine') {
      const myProfile = loadProfile();
      if (myProfile.avatarData) {
        div.innerHTML = `<img src="${safeImage(myProfile.avatarData)}" alt="${escapeHtml(myProfile.nickname)}"
          style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
      } else {
        const sp = document.createElement('span');
        sp.className = 'avatar__initial';
        sp.textContent = (myProfile.nickname || post.authorName || '我').charAt(0);
        div.appendChild(sp);
      }
      return div;
    }

    // 角色帖子：从 chat-state 查最新头像
    const chatAvatarData = (() => {
      try {
        const st = loadChatState();
        const conv = (st.conversations || []).find((c) => c.id === post.authorId || c.name === post.authorName);
        return conv?.avatarData || '';
      } catch { return ''; }
    })();

    const avatarSrc = post.authorAvatar || chatAvatarData;
    if (avatarSrc) {
      div.innerHTML = `<img src="${safeImage(avatarSrc)}" alt="${escapeHtml(post.authorName)}"
        style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
    } else {
      const sp = document.createElement('span');
      sp.className = 'avatar__initial';
      sp.textContent = post.authorInitial;
      div.appendChild(sp);
    }
    return div;
  }

  function buildPostEl(post) {
    const article = document.createElement('article');
    article.className = 'post glass';
    article.dataset.postId = post.id;

    const avatar = buildAvatar(post);
    const body   = document.createElement('div');
    body.className = 'post__body';

    const head = document.createElement('div');
    head.className = 'post__head';
    // 「我」的帖子用 profile 的最新昵称；角色帖子用 chat-state 里的最新名字
    let displayName = post.authorName;
    if (post.authorType === 'mine') {
      displayName = loadProfile().nickname || post.authorName || '我';
    } else {
      try {
        const st = loadChatState();
        const conv = (st.conversations || []).find((c) => c.id === post.authorId || c.name === post.authorName);
        if (conv) displayName = conv.name;
      } catch { /* ignore */ }
    }
    head.innerHTML = `<span class="post__name">${escapeHtml(displayName)}</span>
      <span class="post__time">${escapeHtml(post.time)}</span>`;

    const text = document.createElement('p');
    text.className = 'post__text';
    text.textContent = post.text;

    body.append(head, text);
    if (post.comments.length) {
      const comments = document.createElement('div'); comments.className = 'post__comments'; comments.style.cssText = 'margin:8px 0;padding:8px 10px;border-radius:10px;background:rgba(156,196,228,.10);font-size:12px;line-height:1.6;white-space:pre-line';
      comments.textContent = post.comments.map(comment => `${comment.authorName}：${comment.text}`).join('\n'); body.appendChild(comments);
    }

    // 图片网格（有内容时渲染）
    if (post.images.length) {
      const grid = document.createElement('div');
      grid.className = 'post__images';
      grid.setAttribute('aria-hidden', 'true');
      post.images.forEach((src) => {
        const img = document.createElement('div');
        img.className = 'post__img';
        if (safeImage(src)) img.style.backgroundImage = `url(${safeImage(src)})`;
        grid.appendChild(img);
      });
      body.appendChild(grid);
    }

    // 操作栏
    const foot = document.createElement('div');
    foot.className = 'post__foot';

    const likeBtn = document.createElement('button');
    likeBtn.className = `post__action${post.liked ? ' post__action--liked' : ''}`;
    likeBtn.setAttribute('aria-label', '喜欢');
    likeBtn.innerHTML = `<i class="fa-${post.liked ? 'solid' : 'regular'} fa-heart" aria-hidden="true"></i>`;
    if (post.likeCount > 0) {
      const count = document.createElement('span');
      count.style.cssText = 'font-size:11px;margin-left:3px;';
      count.textContent = post.likeCount;
      likeBtn.appendChild(count);
    }
    likeBtn.addEventListener('click', async () => {
      const updated = await toggleLike(post.id);
      if (!updated) return;
      likeBtn.className = `post__action${updated.liked ? ' post__action--liked' : ''}`;
      const icon = likeBtn.querySelector('i');
      if (icon) icon.className = `fa-${updated.liked ? 'solid' : 'regular'} fa-heart`;
      const countEl = likeBtn.querySelector('span');
      if (updated.likeCount > 0) {
        if (countEl) { countEl.textContent = updated.likeCount; }
        else {
          const c = document.createElement('span');
          c.style.cssText = 'font-size:11px;margin-left:3px;';
          c.textContent = updated.likeCount;
          likeBtn.appendChild(c);
        }
      } else if (countEl) {
        countEl.remove();
      }
    });

    const commentBtn = document.createElement('button');
    commentBtn.className = 'post__action';
    commentBtn.setAttribute('aria-label', '评论');
    commentBtn.innerHTML = '<i class="fa-regular fa-comment" aria-hidden="true"></i>';
    commentBtn.addEventListener('click', async () => { const value = await showPrompt('写下你的回复，和朋友分享这一刻。', { title: '回复这条动态', placeholder: '输入评论…', confirmText: '发送', multiline: true, maxLength: 240 }); if (value?.trim()) await addComment(post.id, value.trim()); });
    if (post.authorType === 'mine') article.addEventListener('contextmenu', async event => { event.preventDefault(); if (await showConfirm('删除后无法恢复这条动态。', { title: '删除动态', confirmText: '删除', tone: 'danger' })) await deletePost(post.id); });

    foot.append(likeBtn, commentBtn);
    body.appendChild(foot);
    article.append(avatar, body);
    return article;
  }

  function renderPosts(posts) {
    if (!postList) return;
    postList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    posts.forEach((post, i) => {
      fragment.appendChild(buildPostEl(post));
      if (i < posts.length - 1) {
        const gap = document.createElement('div');
        gap.style.height = '16px';
        fragment.appendChild(gap);
      }
    });
    postList.appendChild(fragment);
  }

  renderPosts(loadPosts());
  subscribeToPosts(renderPosts);

  // ── 发布弹层 ──────────────────────────────────────────────────────────────
  const composeMask    = document.getElementById('compose-mask');
  const composeClose   = document.getElementById('compose-close');
  const composeTA      = document.getElementById('compose-textarea');
  const composeSubmit  = document.getElementById('compose-submit');
  const composeImage = document.getElementById('compose-emoji'); let pendingImages = [];
  composeImage?.addEventListener('click', () => { const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png,image/webp,image/gif'; picker.multiple = true; picker.addEventListener('change', async () => { pendingImages = []; for (const file of [...picker.files].slice(0, 9)) { const data = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => resolve(''); reader.readAsDataURL(file); }); if (safeImage(data)) pendingImages.push(data); } }); picker.click(); });

  function openCompose() {
    if (!composeMask) return;
    if (composeTA) composeTA.value = '';
    pendingImages = [];
    composeMask.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    // 稍延迟聚焦，等动画完成
    setTimeout(() => composeTA?.focus(), 350);
  }
  function closeCompose() {
    if (!composeMask) return;
    composeMask.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  composer?.addEventListener('click', openCompose);
  composeClose?.addEventListener('click', closeCompose);
  composeMask?.addEventListener('click', (e) => {
    if (e.target === composeMask) closeCompose();
  });

  composeSubmit?.addEventListener('click', async () => {
    const text = composeTA?.value.trim();
    if (!text) return;
    await addPost(text, pendingImages);
    closeCompose();
    // subscribeToPosts 会自动触发 renderPosts
  });

  // 快捷键：Cmd/Ctrl+Enter 发布
  composeTA?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      composeSubmit?.click();
    }
  });
}

export async function initPage() { initMomentsPage(); }
