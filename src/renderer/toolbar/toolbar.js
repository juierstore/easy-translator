'use strict';

const srcBtn = document.getElementById('srcBtn');
const tgtBtn = document.getElementById('tgtBtn');
const srcLabel = document.getElementById('srcLabel');
const tgtLabel = document.getElementById('tgtLabel');
const copySrcBtn = document.getElementById('copySrcBtn');
const copyDstBtn = document.getElementById('copyDstBtn');
const shotBtn = document.getElementById('shotBtn');
const compareBtn = document.getElementById('compareBtn');
const origBtn = document.getElementById('origBtn');
const origLabel = document.getElementById('origLabel');
const closeBtn = document.getElementById('closeBtn');
const retryBtn = document.getElementById('retryBtn');
const bar = document.getElementById('bar');
const srcMenu = document.getElementById('srcMenu');
const tgtMenu = document.getElementById('tgtMenu');
const tipEl = document.getElementById('tip');

let langs = [];
let session = null;
let openMenuEl = null;
let tipTimer = null;

const BAR_H = 44;
const ITEM_H = 29;
const MENU_PAD = 8;

function langName(code) {
  const l = langs.find((x) => x.code === code);
  return l ? l.name : code || '—';
}
function langShort(code) {
  const l = langs.find((x) => x.code === code);
  if (!l) return code || '—';
  return code === 'auto' ? '自动' : l.name;
}

function render() {
  if (!session) return;
  srcLabel.textContent = langShort(session.srcLang);
  tgtLabel.textContent = langShort(session.targetLang);
  srcBtn.classList.toggle('active', session.srcLang === 'auto');
  compareBtn.classList.toggle('on', !!session.compare);
  origBtn.classList.toggle('on', !!session.showOriginal);
  origLabel.textContent = session.showOriginal ? '译文' : '原图';
  retryBtn.style.display = session.status === 'error' ? '' : 'none';
  bar.classList.toggle('busy', session.status === 'ocr' || session.status === 'translating');
}

function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.classList.remove('on');
  openMenuEl = null;
  window.etToolbar.resize(BAR_H);
}

function buildMenu(el, which) {
  el.innerHTML = '';
  for (const l of langs) {
    const d = document.createElement('div');
    d.className = 'item';
    const cur = which === 'source' ? session.srcLang : session.targetLang;
    if (l.code === cur) d.classList.add('sel');
    const name = document.createElement('span');
    name.textContent = l.name;
    d.appendChild(name);
    if (l.code !== 'auto') {
      const code = document.createElement('span');
      code.className = 'code';
      code.textContent = l.code;
      d.appendChild(code);
    }
    d.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      closeMenu();
      await window.etToolbar.action('setLang', { which, code: l.code });
    });
    el.appendChild(d);
  }
}

function openMenu(which, anchor) {
  closeMenu();
  const el = which === 'source' ? srcMenu : tgtMenu;
  buildMenu(el, which);
  const rect = anchor.getBoundingClientRect();
  el.style.left = Math.round(rect.left) + 'px';
  el.style.top = BAR_H + 2 + 'px';
  el.classList.add('on');
  openMenuEl = el;

  const h = Math.min(langs.length * ITEM_H + MENU_PAD, 268) + BAR_H + 6;
  window.etToolbar.resize(h);
}

function toast(text, ms = 1400) {
  tipEl.textContent = text;
  tipEl.style.top = (BAR_H + 4) + 'px';
  tipEl.style.bottom = 'auto';
  tipEl.classList.add('on');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => tipEl.classList.remove('on'), ms);
}

function flashButton(btn, text) {
  const label = btn.querySelector('span');
  if (!label) return;
  const old = label.textContent;
  label.textContent = text;
  btn.classList.add('on');
  setTimeout(() => { label.textContent = old; btn.classList.remove('on'); }, 1200);
}

srcBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (openMenuEl === srcMenu) closeMenu(); else openMenu('source', srcBtn);
});

tgtBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (openMenuEl === tgtMenu) closeMenu(); else openMenu('target', tgtBtn);
});

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !srcBtn.contains(e.target) && !tgtBtn.contains(e.target)) closeMenu();
});

copySrcBtn.addEventListener('click', async () => {
  const r = await window.etToolbar.action('copy', { which: 'src' });
  if (r && r.ok) flashButton(copySrcBtn, (r.text || '').length ? '已复制' : '无原文');
});

copyDstBtn.addEventListener('click', async () => {
  const r = await window.etToolbar.action('copy', { which: 'dst' });
  if (r && r.ok) flashButton(copyDstBtn, (r.text || '').length ? '已复制' : '无译文');
});

copySrcBtn.addEventListener('contextmenu', (e) => e.preventDefault());
copyDstBtn.addEventListener('contextmenu', (e) => e.preventDefault());

shotBtn.addEventListener('click', async () => {
  flashButton(shotBtn, '保存中');
  const r = await window.etToolbar.action('saveImage');
  if (r && r.ok) flashButton(shotBtn, '已保存');
  else if (!r || !r.cancelled) flashButton(shotBtn, '失败');
  else flashButton(shotBtn, '已取消');
});

compareBtn.addEventListener('click', async () => {
  const r = await window.etToolbar.action('toggleCompare');
  if (r && r.ok) { session.compare = r.compare; render(); }
});

origBtn.addEventListener('click', async () => {
  const r = await window.etToolbar.action('toggleOriginal');
  if (r && r.ok) { session.showOriginal = r.showOriginal; render(); }
});

retryBtn.addEventListener('click', async () => {
  flashButton(retryBtn, '重试中');
  await window.etToolbar.action('retry');
});

closeBtn.addEventListener('click', () => window.etToolbar.action('close'));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (openMenuEl) closeMenu();
    else window.etToolbar.action('close');
  }
  if (e.key === 'Enter') window.etToolbar.action('close');
});

window.addEventListener('blur', () => { closeMenu(); });

window.etToolbar.init().then((d) => {
  if (!d) return;
  langs = d.langs || [];
  session = d.session;
  render();
}).catch(() => { });

window.etToolbar.onData((s) => {
  if (!s) return;
  session = s;
  render();
});

render();
