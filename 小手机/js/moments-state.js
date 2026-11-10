import { mutateRecord } from './database-state.js';
import { loadProfile } from './profile-state.js';
import { readJson, hydrateImages, uniqueId, subscribe } from './storage-state.js';
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
    authorAvatarRef: p.authorAvatarRef,
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
  const value = hydrateImages(readJson(STORAGE_KEY, null));
  if (value !== null && !Array.isArray(value)) throw new Error('动态数据无效，请先备份。');
  return value;
}

export function loadPosts() {
  const raw = loadRaw();
  return raw === null ? cloneDefaults() : raw.map(normalizePost).filter(Boolean);
}

export function savePosts(posts) {
  return mutateRecord(STORAGE_KEY, cloneDefaults, () => posts);
}

export async function toggleLike(id) {
  let result;
  await mutateRecord(STORAGE_KEY, cloneDefaults, raw => {
    const posts = raw.map(normalizePost).filter(Boolean);
    const post = posts.find(p => p.id === id);
    if (post) { post.liked = !post.liked; post.likeCount = Math.max(0, post.likeCount + (post.liked ? 1 : -1)); result = post; }
    return posts;
  });
  return result;
}

export async function addPost(text, images = []) {
  const now   = new Date();
  const time  = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);

  const profile = loadProfile();
  const nickname = profile.nickname;
  const avatarData = profile.avatarData;

  const post = {
    id: uniqueId('post-mine-'),
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
  await mutateRecord(STORAGE_KEY, cloneDefaults, raw => [post, ...raw.map(normalizePost).filter(Boolean)]);
  return post;
}

export function subscribeToPosts(handler) {
  return subscribe(STORAGE_KEY, 'echo-moments-change', handler, loadPosts);
}
export { STORAGE_KEY };
