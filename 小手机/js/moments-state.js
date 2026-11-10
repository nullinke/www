// echo-moments-v1 数据格式：
// Post { id, authorId, authorName, authorInitial, authorAvatar,
//        text, images[], time, liked, likeCount, comments[] }

const STORAGE_KEY = 'echo-moments-v1';

const DEFAULT_POSTS = [
  {
    id: 'post-nereus-1',
    authorId: 'nereus',
    authorName: 'Nereus',
    authorInitial: 'N',
    authorAvatar: '',
    authorType: 'peer',
    text: '今晚的灯塔亮得早一些，海面安静得像睡着了。',
    images: [],
    time: '21:32',
    liked: true,
    likeCount: 1,
    comments: [],
  },
  {
    id: 'post-momo-1',
    authorId: 'momo',
    authorName: 'Momo',
    authorInitial: 'M',
    authorAvatar: '',
    authorType: 'peer',
    text: '唱片行淘到三张宝，封面就先赢了。',
    images: ['', '', ''],   // 空字符串表示占位图
    time: '18:05',
    liked: false,
    likeCount: 0,
    comments: [],
  },
];

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_POSTS));
}

function normalizePost(p) {
  if (!p || typeof p !== 'object') return null;
  if (!p.id || !p.text) return null;
  return {
    id:            String(p.id),
    authorId:      String(p.authorId   || 'mine'),
    authorName:    String(p.authorName  || '我'),
    authorInitial: String(p.authorInitial || '我'),
    authorAvatar:  typeof p.authorAvatar === 'string' ? p.authorAvatar : '',
    authorType:    p.authorType === 'peer' ? 'peer' : 'mine',
    text:          String(p.text).trim(),
    images:        Array.isArray(p.images) ? p.images.map(String) : [],
    time:          String(p.time || ''),
    liked:         Boolean(p.liked),
    likeCount:     Math.max(0, Number(p.likeCount) || 0),
    comments:      Array.isArray(p.comments) ? p.comments : [],
  };
}

function loadRaw() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function loadPosts() {
  const raw = loadRaw();
  if (!raw) return cloneDefaults();
  const posts = raw.map(normalizePost).filter(Boolean);
  return posts.length ? posts : cloneDefaults();
}

export function savePosts(posts) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(posts));
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent('echo-moments-change'));
}

export function toggleLike(id) {
  const posts = loadPosts();
  const post  = posts.find((p) => p.id === id);
  if (!post) return;
  post.liked     = !post.liked;
  post.likeCount = Math.max(0, post.likeCount + (post.liked ? 1 : -1));
  savePosts(posts);
  return post;
}

export function addPost(text, images = []) {
  const posts = loadPosts();
  const now   = new Date();
  const time  = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);

  // 读取用户资料作为发布者
  let nickname = '我'; let avatarData = '';
  try {
    const p = JSON.parse(localStorage.getItem('echo-profile-v1') || '{}');
    if (p.nickname) nickname = p.nickname;
    if (p.avatarData) avatarData = p.avatarData;
  } catch { /* ignore */ }

  const post = {
    id: `post-mine-${Date.now()}`,
    authorId: 'mine',
    authorName: nickname,
    authorInitial: nickname.charAt(0),
    authorAvatar: avatarData,
    authorType: 'mine',
    text: text.trim(),
    images,
    time,
    liked: false,
    likeCount: 0,
    comments: [],
  };
  posts.unshift(post);
  savePosts(posts);
  return post;
}

export function subscribeToPosts(handler) {
  const onCustom  = () => handler(loadPosts());
  const onStorage = (e) => { if (e.key === STORAGE_KEY) handler(loadPosts()); };
  window.addEventListener('echo-moments-change', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('echo-moments-change', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export { STORAGE_KEY };