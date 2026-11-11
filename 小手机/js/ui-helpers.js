export const page = window.location.pathname.split('/').pop() || 'home.html';

export function reportError(error) {
  console.error('[Echo]', error);
  alert(error?.message || '操作未完成，请重试。');
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
