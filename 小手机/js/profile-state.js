import { readJson, writeImageRecord, hydrateImages, StorageError } from './storage-state.js';
// echo-profile-v1 数据格式：
// { nickname: string, id: string, bio: string, avatarData: string(base64|''), coverImage: string(base64|''),
//   archive: { gender, age, birthday, appearance, personality, hobbies } }

const STORAGE_KEY = 'echo-profile-v1';

const DEFAULT_PROFILE = {
  version: 1,
  nickname: '拾贝人',
  id: 'ECHO-0001',
  bio: '慢慢走，收集一路的浪声。',
  avatarData: '',
  coverImage: '',
  archive: {
    gender:      '',
    age:         '',
    birthday:    '',
    appearance:  '',
    personality: '',
    hobbies:     '',
  },
};

function normalizeProfile(value) {
  const fallback = { ...DEFAULT_PROFILE, archive: { ...DEFAULT_PROFILE.archive } };
  if (!value || typeof value !== 'object') return fallback;
  const arc = (value.archive && typeof value.archive === 'object') ? value.archive : {};
  return {
    version: 1,
    avatarRef: value.avatarRef, coverImageRef: value.coverImageRef,
    nickname:   safeStr(value.nickname,   fallback.nickname,   32),
    id:         safeStr(value.id,         fallback.id,         32),
    bio:        safeStr(value.bio,        fallback.bio,        200),
    avatarData:  typeof value.avatarData  === 'string' ? value.avatarData  : '',
    coverImage:  typeof value.coverImage  === 'string' ? value.coverImage  : '',
    archive: {
      gender:      safeStr(arc.gender,      '', 20),
      age:         safeStr(arc.age,         '', 10),
      birthday:    safeStr(arc.birthday,    '', 20),
      appearance:  safeStr(arc.appearance,  '', 500),
      personality: safeStr(arc.personality, '', 500),
      hobbies:     safeStr(arc.hobbies,     '', 500),
    },
  };
}

function safeStr(value, fallback, maxLen) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, maxLen);
  return trimmed || fallback;
}

export function loadProfile() {
  const value = hydrateImages(readJson(STORAGE_KEY, null));
  if (value !== null && (typeof value !== 'object' || Array.isArray(value) || (value.version !== undefined && value.version !== 1))) throw new StorageError('资料数据结构不受支持，已保留原始内容。');
  return normalizeProfile(value);
}

export function saveProfile(profile) {
  const normalized = normalizeProfile(profile);
  const result = writeImageRecord(STORAGE_KEY, normalized);
  window.dispatchEvent(new CustomEvent('echo-profile-change', { detail: result }));
  return result;
}

export function updateProfile(patch) {
  const current = loadProfile();
  return saveProfile({ ...current, ...patch, archive: { ...current.archive, ...(patch.archive || {}) } });
}

export function subscribeToProfile(handler) {
  const onCustom  = (e) => handler(normalizeProfile(e.detail));
  const onStorage = (e) => { if (e.key === STORAGE_KEY) handler(loadProfile()); };
  window.addEventListener('echo-profile-change', onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('echo-profile-change', onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export { STORAGE_KEY };