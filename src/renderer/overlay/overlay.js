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

async function submit(r) {
  if (submitting || !data) return;
  submitting = true;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(0, Math.min(r.x, vw - 2));
  const y = Math.max(0, Math.min(r.y, vh - 2));
  const w = Math.max(2, Math.min(r.w, vw - x));
  const h = Math.max(2, Math.min(r.h, vh - y));

  const pxX = Math.round(x * scale);
  const pxY = Math.round(y * scale);
  const pxW = Math.max(2, Math.min(Math.round(w * scale), (data.pxW || vw) - pxX));
  const pxH = Math.max(2, Math.min(Math.round(h * scale), (data.pxH || vh) - pxY));

  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(shot, pxX, pxY, pxW, pxH, 0, 0, pxW, pxH);
  const imageDataUrl = canvas.toDataURL('image/png');

  selEl.style.borderColor = 'rgba(96,165,250,1)';
  hintEl.classList.add('hide');

  try {
    await window.etOverlay.select({
      scale,
      px: { x: pxX, y: pxY, w: pxW, h: pxH },
      displayX: data.displayX,
      displayY: data.displayY,
      displayW: data.displayW,
      displayH: data.displayH,
      pxW: data.pxW,
      pxH: data.pxH,
      imageDataUrl
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
