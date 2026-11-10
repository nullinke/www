export default [{
  files: ['js/**/*.js', 'tests/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    globals: Object.fromEntries(['window', 'indexedDB', 'IDBKeyRange', 'BroadcastChannel', 'navigator', 'structuredClone', 'setInterval', 'clearInterval', 'document', 'localStorage', 'location', 'history', 'alert', 'confirm', 'console', 'URL', 'URLSearchParams', 'CustomEvent', 'Event', 'EventTarget', 'StorageEvent', 'AbortController', 'AbortSignal', 'DOMException', 'TextDecoder', 'TextEncoder', 'Response', 'ReadableStream', 'Blob', 'FileReader', 'Image', 'ResizeObserver', 'CSS', 'crypto', 'fetch', 'setTimeout', 'clearTimeout', 'requestAnimationFrame'].map(name => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error' },
}];
