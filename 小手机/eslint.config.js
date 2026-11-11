const browser = {
  files: ['js/**/*.js', 'tests/**/*.js', 'tools/**/*.mjs'],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    globals: Object.fromEntries(['performance', 'window', 'indexedDB', 'IDBKeyRange', 'IDBObjectStore', 'BroadcastChannel', 'navigator', 'structuredClone', 'setInterval', 'clearInterval', 'document', 'localStorage', 'location', 'history', 'alert', 'confirm', 'console', 'URL', 'URLSearchParams', 'CustomEvent', 'Event', 'EventTarget', 'StorageEvent', 'AbortController', 'AbortSignal', 'DOMException', 'TextDecoder', 'TextEncoder', 'Response', 'ReadableStream', 'Blob', 'FileReader', 'Image', 'ResizeObserver', 'CSS', 'crypto', 'fetch', 'setTimeout', 'clearTimeout', 'requestAnimationFrame'].map(name => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }] },
};
export default [{ ignores: ['js/vendor/**'] }, browser, {
  ...browser, files: ['tests/**/*.cjs', 'tools/**/*.cjs'],
  languageOptions: { ...browser.languageOptions, sourceType: 'commonjs', globals: { ...browser.languageOptions.globals, require: 'readonly', module: 'readonly', __dirname: 'readonly', process: 'readonly', Buffer: 'readonly' } },
}];
