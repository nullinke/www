export const page = window.location.pathname.split('/').pop() || 'home.html';

const UI_STYLE = `
  #echo-ui-root {
    position: fixed;
    inset: 0;
    z-index: 9999;
    pointer-events: none;
    font-family: var(--font-zh, "MiSans", "PingFang SC", sans-serif);
    color: var(--brand-ink, #4E6B80);
  }
  #echo-ui-root *, #echo-ui-root *::before, #echo-ui-root *::after { box-sizing: border-box; }
  .echo-ui-toasts {
    position: absolute;
    top: max(20px, env(safe-area-inset-top));
    left: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .echo-ui-toast {
    width: min(100%, 360px);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 15px;
    border: 1px solid var(--glass-border, rgba(255, 255, 255, .9));
    border-radius: 18px;
    background: rgba(253, 254, 255, .82);
    box-shadow: var(--shadow-glass-lg, 0 12px 28px rgba(143, 186, 217, .25));
    backdrop-filter: var(--glass-blur, blur(12px) saturate(1.4));
    -webkit-backdrop-filter: var(--glass-blur, blur(12px) saturate(1.4));
    font-size: 13px;
    line-height: 1.45;
    opacity: 0;
    transform: translateY(-10px) scale(.98);
    transition: opacity .22s ease, transform .22s ease;
    pointer-events: auto;
  }
  .echo-ui-toast.is-visible { opacity: 1; transform: translateY(0) scale(1); }
  .echo-ui-toast__icon {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    border-radius: 50%;
    background: rgba(156, 196, 228, .25);
    color: var(--brand-blue-deep, #7FA8CC);
    font-size: 14px;
    font-weight: 700;
  }
  .echo-ui-toast--error .echo-ui-toast__icon {
    background: rgba(224, 157, 164, .18);
    color: #B56D79;
  }
  .echo-ui-toast__message { min-width: 0; flex: 1; }
  .echo-ui-dialog {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px 16px max(20px, env(safe-area-inset-bottom));
    background: rgba(65, 95, 116, .18);
    backdrop-filter: blur(7px);
    -webkit-backdrop-filter: blur(7px);
    opacity: 0;
    transition: opacity .22s ease;
    pointer-events: auto;
  }
  .echo-ui-dialog.is-open { opacity: 1; }
  .echo-ui-card {
    width: min(100%, 370px);
    max-height: min(78dvh, 620px);
    overflow: auto;
    padding: 22px 20px 18px;
    border: 1px solid var(--glass-border, rgba(255, 255, 255, .9));
    border-radius: 26px;
    background: linear-gradient(145deg, rgba(253, 254, 255, .95), rgba(240, 247, 252, .9));
    box-shadow: var(--shadow-glass-lg, 0 12px 28px rgba(143, 186, 217, .25));
    transform: scale(.96) translateY(8px);
    transition: transform .28s cubic-bezier(.32, .72, 0, 1);
  }
  .echo-ui-dialog.is-open .echo-ui-card { transform: scale(1) translateY(0); }
  .echo-ui-card__handle {
    width: 36px;
    height: 4px;
    margin: -8px auto 18px;
    border-radius: 999px;
    background: var(--brand-muted, #9DB4C4);
    opacity: .6;
  }
  .echo-ui-dialog[data-kind="notice"] .echo-ui-card__handle { display: none; }
  .echo-ui-card__eyebrow {
    margin-bottom: 5px;
    color: var(--brand-blue-deep, #7FA8CC);
    font-family: var(--font-en, "Liter", sans-serif);
    font-size: 11px;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  .echo-ui-card__title {
    margin: 0;
    color: var(--brand-deep, #5E7B90);
    font-size: 18px;
    font-weight: 600;
    line-height: 1.35;
  }
  .echo-ui-card__message {
    margin: 10px 0 0;
    color: var(--brand-ink, #4E6B80);
    font-size: 14px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .echo-ui-card__field {
    width: 100%;
    min-height: 44px;
    margin-top: 16px;
    padding: 11px 13px;
    border: 1px solid rgba(156, 196, 228, .58);
    border-radius: 16px;
    outline: 0;
    resize: vertical;
    background: rgba(255, 255, 255, .68);
    color: var(--brand-ink, #4E6B80);
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
    box-shadow: inset 0 1px 2px rgba(127, 168, 204, .08);
  }
  .echo-ui-card__field:focus { border-color: var(--brand-blue-deep, #7FA8CC); box-shadow: 0 0 0 3px rgba(156, 196, 228, .2); }
  .echo-ui-card__field::placeholder { color: var(--brand-muted, #9DB4C4); }
  .echo-ui-card__actions {
    display: flex;
    gap: 10px;
    margin-top: 20px;
  }
  .echo-ui-card__button {
    min-height: 42px;
    flex: 1;
    padding: 9px 14px;
    border: 1px solid rgba(156, 196, 228, .55);
    border-radius: 16px;
    background: rgba(255, 255, 255, .6);
    color: var(--brand-deep, #5E7B90);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    transition: transform .16s ease, opacity .16s ease, background .16s ease;
  }
  .echo-ui-card__button:active { transform: scale(.98); }
  .echo-ui-card__button:hover { background: rgba(255, 255, 255, .9); }
  .echo-ui-card__button--primary { border-color: transparent; background: linear-gradient(135deg, #9CC4E4, #7FA8CC); color: #fff; box-shadow: 0 6px 14px rgba(127, 168, 204, .28); }
  .echo-ui-card__button--danger { border-color: transparent; background: linear-gradient(135deg, #D89AA4, #B97581); color: #fff; box-shadow: 0 6px 14px rgba(185, 117, 129, .22); }
  @media (prefers-reduced-motion: reduce) {
    .echo-ui-toast, .echo-ui-dialog, .echo-ui-card { transition: none; }
  }
`;

let feedbackRoot;
let activeDialog;

function ensureFeedbackRoot() {
  if (feedbackRoot?.isConnected) return feedbackRoot;
  if (!document.body) return null;
  if (!document.getElementById('__echo_ui_style__')) {
    const style = document.createElement('style');
    style.id = '__echo_ui_style__';
    style.textContent = UI_STYLE;
    document.head.appendChild(style);
  }
  feedbackRoot = document.createElement('div');
  feedbackRoot.id = 'echo-ui-root';
  feedbackRoot.innerHTML = '<div class="echo-ui-toasts" aria-live="polite"></div><div class="echo-ui-dialogs"></div>';
  document.body.appendChild(feedbackRoot);
  return feedbackRoot;
}

function restoreBodyOverflow(previous) {
  document.body.style.overflow = previous;
}

export function showToast(message, { tone = 'success', duration = 2600 } = {}) {
  const root = ensureFeedbackRoot();
  if (!root) return Promise.resolve();
  const toast = document.createElement('div');
  toast.className = `echo-ui-toast echo-ui-toast--${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'echo-ui-toast__icon';
  icon.textContent = tone === 'error' ? '!' : '✓';
  const text = document.createElement('span');
  text.className = 'echo-ui-toast__message';
  text.textContent = String(message ?? '');
  toast.append(icon, text);
  root.querySelector('.echo-ui-toasts').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  return new Promise(resolve => {
    const close = () => {
      toast.classList.remove('is-visible');
      setTimeout(() => { toast.remove(); resolve(); }, 220);
    };
    setTimeout(close, Math.max(800, duration));
  });
}

function openDialog({ kind, title, message, value = '', placeholder = '', confirmText = '确定', cancelText = '取消', tone = 'info', inputType = 'text', inputMode = 'text', multiline = false, maxLength = 1000 }) {
  const root = ensureFeedbackRoot();
  if (!root) return Promise.resolve(null);
  activeDialog?.close(null);
  root.querySelectorAll('.echo-ui-dialog:not(.is-open)').forEach(node => node.remove());
  const previousOverflow = document.body.style.overflow;
  const mask = document.createElement('div');
  mask.className = 'echo-ui-dialog';
  mask.dataset.kind = kind;
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  const card = document.createElement('section');
  card.className = 'echo-ui-card';
  const handle = document.createElement('div');
  handle.className = 'echo-ui-card__handle';
  handle.setAttribute('aria-hidden', 'true');
  const eyebrow = document.createElement('div');
  eyebrow.className = 'echo-ui-card__eyebrow';
  eyebrow.textContent = kind === 'prompt' ? 'Echo Input' : kind === 'confirm' ? 'Echo Check' : 'Echo Notice';
  const heading = document.createElement('h2');
  heading.className = 'echo-ui-card__title';
  heading.textContent = title;
  card.append(handle, eyebrow, heading);
  if (message) {
    const body = document.createElement('p');
    body.className = 'echo-ui-card__message';
    body.textContent = message;
    card.appendChild(body);
  }
  let field;
  if (kind === 'prompt') {
    field = document.createElement(multiline ? 'textarea' : 'input');
    field.className = 'echo-ui-card__field';
    field.value = value;
    field.placeholder = placeholder;
    field.maxLength = maxLength;
    if (!multiline) {
      field.type = inputType;
      field.inputMode = inputMode;
    }
    field.setAttribute('aria-label', title);
    card.appendChild(field);
  }
  const actions = document.createElement('div');
  actions.className = 'echo-ui-card__actions';
  const cancel = document.createElement('button');
  cancel.className = 'echo-ui-card__button';
  cancel.type = 'button';
  cancel.textContent = cancelText;
  const confirm = document.createElement('button');
  confirm.className = `echo-ui-card__button echo-ui-card__button--${tone === 'danger' ? 'danger' : 'primary'}`;
  confirm.type = 'button';
  confirm.textContent = confirmText;
  if (kind !== 'notice') actions.append(cancel);
  actions.append(confirm);
  card.appendChild(actions);
  mask.appendChild(card);
  root.querySelector('.echo-ui-dialogs').appendChild(mask);
  document.body.style.overflow = 'hidden';

  let settled = false;
  let resolveDialog;
  const result = new Promise(resolve => { resolveDialog = resolve; });
  const close = valueToResolve => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeyDown);
    activeDialog = null;
    mask.classList.remove('is-open');
    restoreBodyOverflow(previousOverflow);
    setTimeout(() => mask.remove(), 280);
    resolveDialog(valueToResolve);
  };
  const onKeyDown = event => {
    if (!mask.contains(event.target)) return;
    if (event.key === 'Escape') { event.preventDefault(); close(kind === 'notice' ? true : null); }
    if (kind === 'prompt' && event.key === 'Enter' && (event.metaKey || event.ctrlKey || !multiline)) {
      event.preventDefault(); confirm.click();
    }
  };
  activeDialog = { close };
  cancel.addEventListener('click', () => close(null));
  confirm.addEventListener('click', () => close(kind === 'prompt' ? field.value : kind === 'confirm' ? true : true));
  mask.addEventListener('click', event => { if (event.target === mask) close(kind === 'notice' ? true : null); });
  document.addEventListener('keydown', onKeyDown);
  requestAnimationFrame(() => {
    mask.classList.add('is-open');
    (field || confirm).focus();
  });
  return result;
}

export function showNotice(message, options = {}) {
  return openDialog({ kind: 'notice', title: options.title || '提示', message, confirmText: options.confirmText || '知道了', tone: options.tone || 'info' });
}

export function showConfirm(message, options = {}) {
  return openDialog({ kind: 'confirm', title: options.title || '请确认', message, confirmText: options.confirmText || '确定', cancelText: options.cancelText || '取消', tone: options.tone || 'info' }).then(Boolean);
}

export function showPrompt(message, options = {}) {
  return openDialog({ kind: 'prompt', title: options.title || '输入内容', message, value: options.value || '', placeholder: options.placeholder || '', confirmText: options.confirmText || '完成', cancelText: options.cancelText || '取消', inputType: options.inputType || 'text', inputMode: options.inputMode || (options.inputType === 'number' ? 'numeric' : 'text'), multiline: Boolean(options.multiline), maxLength: options.maxLength || 1000 });
}

export function reportError(error) {
  console.error('[Echo]', error);
  void showToast(error?.message || '操作未完成，请重试。', { tone: 'error', duration: 3600 });
}

export function setText(selector, value, root = document) {
  const node = root.querySelector(selector);
  if (node) node.textContent = value;
}


export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}


export function resizeImage(file, maxSize, quality = 0.82) {
  if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 15 * 1024 * 1024) {
    reportError(new Error('请选择不超过 15MB 的 JPG、PNG、WebP 或 GIF 图片。'));
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    const timer = setTimeout(() => resolve(null), 15000);
    const finish = value => { clearTimeout(timer); resolve(value); };
    reader.onerror = () => finish(null);
    reader.onload = event => {
      const image = new Image();
      image.onerror = () => finish(null);
      image.onload = () => {
        try {
          if (!image.width || !image.height || image.width * image.height > 40000000) throw new Error('图片分辨率过大。');
          const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * ratio));
          canvas.height = Math.max(1, Math.round(image.height * ratio));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', quality));
        } catch (error) { reportError(error); finish(null); }
      };
      image.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
}
