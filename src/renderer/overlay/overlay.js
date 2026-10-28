'use strict';

const shot = document.getElementById('shot');
const selEl = document.getElementById('sel');
const sizeEl = document.getElementById('size');
const hintEl = document.getElementById('hint');
const crossH = document.getElementById('cross-h');
const crossV = document.getElementById('cross-v');
const dimEl = document.getElementById('dim');

let data = null;
let scale = 1;
let drag = null;
let submitting = false;
let readySent = false;

function norm(d) {
  const x = Math.min(d.x0, d.x1);
  const y = Math.min(d.y0, d.y1);
  const w = Math.abs(d.x1 - d.x0);
  const h = Math.abs(d.y1 - d.y0);
  return { x, y, w, h };
}

function renderSel() {
  if (!drag) { selEl.classList.remove('on'); sizeEl.classList.remove('on'); return; }
  const r = norm(drag);
  selEl.classList.add('on');
  selEl.style.left = r.x + 'px';
  selEl.style.top = r.y + 'px';
  selEl.style.width = r.w + 'px';
  selEl.style.height = r.h + 'px';

  if (r.w > 3 && r.h > 3) {
    sizeEl.classList.add('on');
    sizeEl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    const below = r.y + r.h + 8;
    let top = below;
    if (top + 26 > window.innerHeight) top = Math.max(6, r.y - 28);
    let left = r.x + r.w - Math.min(120, r.w);
    left = Math.max(6, Math.min(left, window.innerWidth - 130));
    sizeEl.style.top = top + 'px';
    sizeEl.style.left = left + 'px';
  } else {
    sizeEl.classList.remove('on');
  }
}

function reset() {
  drag = null;
  selEl.classList.remove('on');
  sizeEl.classList.remove('on');
  hintEl.classList.remove('hide');
  dimEl.classList.remove('off');
}

function applyData(d) {
  if (!d) return;
  data = d;
  scale = d.scale || 1;
  if (shot.getAttribute('src') !== d.imageDataUrl) {
    shot.onload = () => onImageReady();
    shot.onerror = () => onImageReady();
    shot.src = d.imageDataUrl;
    if (shot.complete && shot.naturalWidth > 0) onImageReady();
  } else if (shot.complete && shot.naturalWidth > 0) {
    onImageReady();
  }
}

function onImageReady() {
  if (readySent) return;
  readySent = true;
  try { window.etOverlay.ready(); } catch { }
}

/** 从整屏截图里裁一块出来 */
function cropDataUrl(x, y, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(shot, x, y, w, h, 0, 0, w, h);
  return c.toDataURL('image/png');
}

async function submit(r) {
  if (submitting || !data) return;
  submitting = true;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(0, Math.min(r.x, vw - 2));
  const y = Math.max(0, Math.min(r.y, vh - 2));
  const w = Math.max(2, Math.min(r.w, vw - x));
  const h = Math.max(2, Math.min(r.h, vh - y));

  // 关键：X / Y 分开换算。即使窗口被系统压扁或拉伸，也不会算错裁剪区域
  const natW = shot.naturalWidth || data.pxW || vw;
  const natH = shot.naturalHeight || data.pxH || vh;
  const sx = natW / vw;
  const sy = natH / vh;

  const pxX = Math.max(0, Math.round(x * sx));
  const pxY = Math.max(0, Math.round(y * sy));
  const pxW = Math.max(2, Math.min(Math.round(w * sx), natW - pxX));
  const pxH = Math.max(2, Math.min(Math.round(h * sy), natH - pxY));

  // 给 OCR 多留一圈上下文：贴着选区边缘的文字，OCR 需要周围像素才认得出
  const padX = Math.round(12 * sx);
  const padY = Math.round(12 * sy);
  const ex0 = Math.max(0, pxX - padX);
  const ey0 = Math.max(0, pxY - padY);
  const ex1 = Math.min(natW, pxX + pxW + padX);
  const ey1 = Math.min(natH, pxY + pxH + padY);

  const imageDataUrl = cropDataUrl(pxX, pxY, pxW, pxH);
  const ocrImageDataUrl = cropDataUrl(ex0, ey0, ex1 - ex0, ey1 - ey0);

  selEl.style.borderColor = 'rgba(96,165,250,1)';
  hintEl.classList.add('hide');

  try {
    await window.etOverlay.select({
      scale: sx,
      px: { x: pxX, y: pxY, w: pxW, h: pxH },
      winX: window.screenX,
      winY: window.screenY,
      displayX: data.displayX,
      displayY: data.displayY,
      pxW: natW,
      pxH: natH,
      imageDataUrl,
      ocrImageDataUrl,
      ocrPad: { x: pxX - ex0, y: pxY - ey0 }
    });
  } catch { }
}

window.addEventListener('mousemove', (e) => {
  if (!data || submitting) return;
  if (!drag) {
    crossH.style.top = e.clientY + 'px';
    crossV.style.left = e.clientX + 'px';
    crossH.classList.add('on');
    crossV.classList.add('on');
  } else {
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    renderSel();
  }
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !data || submitting) return;
  e.preventDefault();
  drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
  crossH.classList.remove('on');
  crossV.classList.remove('on');
  hintEl.classList.add('hide');
  dimEl.classList.add('off');
  renderSel();
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || !drag || submitting) return;
  drag.x1 = e.clientX;
  drag.y1 = e.clientY;
  const r = norm(drag);
  drag = null;
  selEl.classList.remove('on');
  sizeEl.classList.remove('on');
  if (r.w < 6 || r.h < 6) { reset(); return; }
  submit(r);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!submitting) window.etOverlay.cancel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (!submitting) window.etOverlay.cancel();
  }
});

window.addEventListener('mouseout', () => {
  crossH.classList.remove('on');
  crossV.classList.remove('on');
});

window.etOverlay.init().then(applyData).catch(() => { });
window.etOverlay.onData(applyData);
window.focus();

// 兜底 1：无论图片是否解码成功，1 秒内都要让窗口显示出来
setTimeout(onImageReady, 1000);

// 兜底 2：拿不到截图数据就主动退出，别留一个透明空窗口把主界面藏了
setTimeout(() => {
  if (!data && !submitting) {
    try { window.etOverlay.cancel(); } catch { }
  }
}, 2500);
