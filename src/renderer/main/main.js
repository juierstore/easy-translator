'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let LANGS = [];
let settings = {};
let info = {};
let histItems = [];
let activeId = null;
let trReqId = 0;
let recording = false;

/* ---------------- 小工具 ---------------- */
function toast(msg, kind = '', ms = 2400) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function langName(code) {
  const l = LANGS.find((x) => x.code === code);
  return l ? l.name : code;
}
function langShort(code) {
  if (code === 'auto') return '自动';
  const l = LANGS.find((x) => x.code === code);
  return l ? (l.short || l.name) : code;
}

/* ---------------- 导航 ---------------- */
function goto(page) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === page));
  $$('.page').forEach((p) => { p.hidden = p.id !== 'page-' + page; });
  document.body.dataset.page = page;
  if (page === 'history') refreshHistoryList();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => goto(b.dataset.nav)));

/* ---------------- 窗口控制 ---------------- */
$('#btnMin').addEventListener('click', () => et.win.minimize());
$('#btnMax').addEventListener('click', () => et.win.maximize());
$('#btnClose').addEventListener('click', () => et.win.close());
$('#btnCapture').addEventListener('click', () => et.capture.start());

/* ---------------- 历史 ---------------- */
async function refreshHistoryList() {
  const q = $('#histSearch').value.trim();
  const r = await et.history.list({ query: q, limit: 500 });
  histItems = r.items;
  if (activeId && !histItems.some((i) => i.id === activeId)) activeId = null;
  renderList();
  if (!histItems.length) {
    $('#histDetail').innerHTML = emptyDetailHtml();
    return;
  }
  if (!activeId) await selectEntry(histItems[0].id);
}

function emptyDetailHtml() {
  return `<div class="empty" id="histEmpty">
    <svg class="empty-svg" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="9" width="36" height="30" rx="5" stroke="currentColor" stroke-width="1.6" opacity=".5"/>
      <path d="M7 15h34" stroke="currentColor" stroke-width="1.6" opacity=".35"/>
      <circle cx="11.5" cy="12" r="1.3" fill="currentColor" opacity=".5"/>
      <circle cx="15.5" cy="12" r="1.3" fill="currentColor" opacity=".35"/>
      <path d="M15 25h12M15 30h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".4"/>
      <path d="M30 21l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".7"/>
    </svg>
    <p>还没有记录</p>
    <span>按 <kbd>Alt+Shift+S</kbd> 框选屏幕上的文字试试</span>
  </div>`;
}

function renderList() {
  const list = $('#histList');
  const wrap = document.querySelector('.hist-wrap');
  list.innerHTML = '';

  if (!histItems.length) {
    wrap.classList.add('is-empty');
    return;
  }
  wrap.classList.remove('is-empty');

  for (const it of histItems) {
    const el = document.createElement('div');
    el.className = 'hist-item' + (it.id === activeId ? ' active' : '');
    el.dataset.id = it.id;

    const img = document.createElement('img');
    img.src = `etimg://history/${it.thumb}`;
    img.loading = 'lazy';
    img.alt = '';

    const meta = document.createElement('div');
    meta.className = 'meta';

    const l1 = document.createElement('div');
    l1.className = 'line1';
    l1.textContent = (it.translation || it.text || '（无内容）').replace(/\s+/g, ' ').slice(0, 60);

    const l2 = document.createElement('div');
    l2.className = 'line2';
    const pair = document.createElement('span');
    pair.className = 'langpair';
    pair.textContent = `${langShort(it.srcLang)} → ${langShort(it.targetLang)}`;
    const t = document.createElement('span');
    t.textContent = fmtTime(it.ts);
    l2.append(pair, t);

    meta.append(l1, l2);
    el.append(img, meta);
    el.addEventListener('click', () => selectEntry(it.id));
    list.appendChild(el);
  }
}

async function selectEntry(id) {
  activeId = id;
  $$('.hist-item').forEach((e) => e.classList.toggle('active', e.dataset.id === id));
  const e = await et.history.get(id);
  const box = $('#histDetail');
  box.innerHTML = '';
  if (!e) { activeId = null; return; }

  const imgWrap = document.createElement('div');
  imgWrap.className = 'img-wrap';
  const img = document.createElement('img');
  img.src = `etimg://history/${e.image}`;
  imgWrap.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const chips = [
    ['acc', `${langName(e.srcLang)} → ${langName(e.targetLang)}`],
    ['', fmtTime(e.ts)],
    ['', `${Math.round(e.w * (e.w ? 1 : 1)) }×${e.h}`],
    ['', e.model || e.provider || ''],
    ['', e.ms ? `${e.ms}ms` : '']
  ];
  for (const [cls, text] of chips) {
    if (!text) continue;
    const c = document.createElement('span');
    c.className = 'tagchip ' + cls;
    c.textContent = text;
    meta.appendChild(c);
  }

  const blkSrc = document.createElement('div');
  blkSrc.className = 'blk';
  blkSrc.innerHTML = '<div class="blk-title">原文</div>';
  const b1 = document.createElement('div');
  b1.className = 'blk-body muted';
  b1.textContent = e.text || '（无）';
  blkSrc.appendChild(b1);

  const blkDst = document.createElement('div');
  blkDst.className = 'blk';
  blkDst.innerHTML = '<div class="blk-title">译文</div>';
  const b2 = document.createElement('div');
  b2.className = 'blk-body';
  b2.textContent = e.translation || '（无）';
  blkDst.appendChild(b2);

  const actions = document.createElement('div');
  actions.className = 'detail-actions';

  const mk = (label, fn, cls = 'ghost sm') => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };

  actions.append(
    mk('复制译文', async () => {
      await navigator.clipboard.writeText(e.translation || '');
      toast('已复制译文', 'ok');
    }),
    mk('复制原文', async () => {
      await navigator.clipboard.writeText(e.text || '');
      toast('已复制原文', 'ok');
    }),
    mk('在文件夹中显示', () => et.history.reveal(e.id)),
    mk('删除', async (ev) => {
      ev.stopPropagation();
      await et.history.remove(e.id);
      activeId = null;
      box.innerHTML = '';
      toast('已删除');
      refreshHistoryList();
    }, 'ghost sm danger')
  );

  box.append(imgWrap, meta, blkSrc, blkDst, actions);
}

let searchTimer = null;
$('#histSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refreshHistoryList(), 220);
});

$('#btnClearHist').addEventListener('click', async () => {
  if (!histItems.length) return;
  if (!confirm('确定清空全部历史记录？该操作不可撤销。')) return;
  await et.history.clear();
  activeId = null;
  $('#histDetail').innerHTML = emptyDetailHtml();
  await refreshHistoryList();
  toast('已清空');
});

/* ---------------- 文字翻译 ---------------- */
function fillLangSelects() {
  const build = (sel, { withAuto, value }) => {
    sel.innerHTML = '';
    for (const l of LANGS) {
      if (!withAuto && l.code === 'auto') continue;
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      sel.appendChild(o);
    }
    sel.value = value;
  };
  build($('#trSrc'), { withAuto: true, value: 'auto' });
  build($('#trTgt'), { withAuto: false, value: settings.targetLang || 'zh-CN' });
  build($('#targetLang'), { withAuto: false, value: settings.targetLang || 'zh-CN' });
  build($('#srcLang'), { withAuto: true, value: settings.srcLang || 'en' });
}

et.translate.onDelta(({ id, full }) => {
  if (id !== trReqId) return;
  $('#trOutput').textContent = full;
  const el = $('#trOutput');
  el.scrollTop = el.scrollHeight;
});

async function doTranslate() {
  const text = $('#trInput').value.trim();
  if (!text) { toast('先输入要翻译的内容', 'err'); return; }
  if (settings.provider === 'deepseek' && !settings.hasApiKey) {
    toast('还没有配置 DeepSeek API Key，可在设置里填写', 'err', 3200);
    goto('settings');
    return;
  }
  trReqId++;
  const id = trReqId;
  const btn = $('#btnTranslate');
  btn.disabled = true;
  btn.textContent = '翻译中…';
  $('#trOutput').textContent = '';
  $('#trMeta').textContent = '';
  const t0 = performance.now();

  const r = await et.translate.text({
    text,
    srcLang: $('#trSrc').value,
    targetLang: $('#trTgt').value,
    id
  });

  btn.disabled = false;
  btn.textContent = '翻译';
  if (r && r.ok) {
    $('#trOutput').textContent = r.text || '（空）';
    const ms = Math.round(performance.now() - t0);
    $('#trMeta').textContent = `${ms}ms · ${r.provider || ''}`;
  } else {
    $('#trOutput').textContent = '翻译失败：' + (r ? r.error : '未知错误');
    $('#trMeta').textContent = '';
  }
}

$('#btnTranslate').addEventListener('click', doTranslate);
$('#btnCopyOut').addEventListener('click', async () => {
  const t = $('#trOutput').textContent || '';
  if (!t) return;
  await navigator.clipboard.writeText(t);
  toast('已复制译文', 'ok');
});
$('#btnClearText').addEventListener('click', () => {
  $('#trInput').value = '';
  $('#trOutput').textContent = '';
  $('#trMeta').textContent = '';
  updateSrcCount();
});
$('#btnPaste').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    $('#trInput').value = t;
    updateSrcCount();
  } catch { toast('无法读取剪贴板', 'err'); }
});
$('#btnSwap').addEventListener('click', () => {
  const src = $('#trSrc');
  const tgt = $('#trTgt');
  const oldSrc = src.value;
  const oldTgt = tgt.value;
  if (oldSrc === 'auto') {
    src.value = oldTgt === 'zh-CN' ? 'en' : 'zh-CN';
    tgt.value = oldTgt;
    if (src.value === tgt.value) tgt.value = 'zh-CN';
  } else {
    src.value = oldTgt;
    tgt.value = oldSrc;
  }
});

function updateSrcCount() {
  const n = $('#trInput').value.length;
  $('#srcCount').textContent = `${n} 字`;
}
$('#trInput').addEventListener('input', updateSrcCount);
$('#trInput').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); doTranslate(); }
});

/* ---------------- 设置 ---------------- */
async function loadSettingsUI() {
  settings = await et.settings.get();
  $('#baseUrl').value = settings.baseUrl || '';
  $('#model').value = settings.model || 'deepseek-chat';
  $('#hotkey').value = settings.hotkey || '';
  $('#hkHint').textContent = settings.hotkey || '';
  $('#targetLang').value = settings.targetLang || 'zh-CN';
  $('#srcLang').value = settings.srcLang || 'en';
  $('#ocrUpscale').value = String(settings.ocrUpscale || 2);
  $('#historyLimit').value = String(settings.historyLimit || 300);
  $('#closeOnBlur').checked = !!settings.closeOnBlur;
  $('#keepHistory').checked = !!settings.keepHistory;
  $('#modelTag').textContent = settings.provider === 'free' ? '免密通道' : (settings.model || 'deepseek-chat');

  $$('#segProvider button').forEach((b) => b.classList.toggle('on', b.dataset.v === (settings.provider || 'deepseek')));

  const st = $('#keyStatus');
  if (settings.hasApiKey) {
    st.textContent = '已保存：' + settings.apiKeyHint;
    st.className = 'kstatus ok';
  } else {
    st.textContent = '未配置 Key。也可以切换到「免密通道」临时使用';
    st.className = 'kstatus';
  }
  $('#apiKey').value = '';
  $('#apiKey').placeholder = settings.hasApiKey ? '已保存，如需更换请输入新的 Key' : 'sk-…';
}

async function patch(p) {
  settings = await et.settings.patch(p);
  if (settings.hotkeyError) {
    toast('快捷键注册失败：' + settings.hotkeyError, 'err', 3600);
    $('#hotkey').value = settings.hotkey || '';
  }
  $('#hkHint').textContent = settings.hotkey || '';
  $('#modelTag').textContent = settings.provider === 'free' ? '免密通道' : (settings.model || 'deepseek-chat');
  return settings;
}

$$('#segProvider button').forEach((b) => {
  b.addEventListener('click', async () => {
    await patch({ provider: b.dataset.v });
    $$('#segProvider button').forEach((x) => x.classList.toggle('on', x === b));
  });
});

$('#btnSaveKey').addEventListener('click', async () => {
  const v = $('#apiKey').value.trim();
  if (!v) { toast('请输入 Key', 'err'); return; }
  await et.settings.setKey(v);
  $('#apiKey').value = '';
  await loadSettingsUI();
  toast('API Key 已保存', 'ok');
});

$('#btnTestKey').addEventListener('click', async () => {
  const st = $('#keyStatus');
  st.textContent = '测试中…';
  st.className = 'kstatus';
  const r = await et.settings.testKey();
  if (r.ok) {
    st.textContent = '连接正常，返回示例：' + (r.sample || '');
    st.className = 'kstatus ok';
  } else {
    st.textContent = r.error || '测试失败';
    st.className = 'kstatus err';
  }
});

$('#baseUrl').addEventListener('change', () => patch({ baseUrl: $('#baseUrl').value.trim() }));
$('#model').addEventListener('change', () => patch({ model: $('#model').value.trim() }));
$('#targetLang').addEventListener('change', () => patch({ targetLang: $('#targetLang').value }));
$('#srcLang').addEventListener('change', () => patch({ srcLang: $('#srcLang').value }));
$('#ocrUpscale').addEventListener('change', () => patch({ ocrUpscale: Number($('#ocrUpscale').value) }));
$('#historyLimit').addEventListener('change', () => patch({ historyLimit: Number($('#historyLimit').value) }));
$('#closeOnBlur').addEventListener('change', () => patch({ closeOnBlur: $('#closeOnBlur').checked }));
$('#keepHistory').addEventListener('change', () => patch({ keepHistory: $('#keepHistory').checked }));

/* ---- 快捷键录制 ---- */
const hotkeyInput = $('#hotkey');
hotkeyInput.addEventListener('click', () => {
  recording = true;
  hotkeyInput.value = '按下组合键…（Esc 取消）';
});

function keyFromEvent(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const map = {
    Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Return', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
  };
  return map[c] || null;
}

document.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    recording = false;
    hotkeyInput.value = settings.hotkey || '';
    return;
  }
  const key = keyFromEvent(e);
  if (!key) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) { toast('请至少按住 Ctrl / Alt / Shift 中的一个', 'err'); return; }
  const accel = [...mods, key].join('+');
  recording = false;
  hotkeyInput.value = accel;
  const r = await patch({ hotkey: accel });
  if (!r.hotkeyError) toast('快捷键已更新为 ' + accel, 'ok');
}, true);

$('#btnHotkey').addEventListener('click', () => { recording = true; hotkeyInput.value = '按下组合键…（Esc 取消）'; });
$('#btnOpenData').addEventListener('click', () => et.meta.openDataFolder());
$('#btnClearAll').addEventListener('click', async () => {
  if (!confirm('确定清空全部历史记录与截图？')) return;
  await et.history.clear();
  await refreshHistoryList();
  $('#histDetail').innerHTML = '';
  toast('已清空', 'ok');
});

/* ---------------- 外部事件 ---------------- */
et.on.navigate((page) => goto(page));
et.on.toast((t) => toast(t.message, t.type === 'error' ? 'err' : ''));
et.on.historyAdded(() => {
  if (document.body.dataset.page === 'history') refreshHistoryList();
});

/* ---------------- 启动 ---------------- */
(async function init() {
  LANGS = await et.meta.langs();
  settings = await et.settings.get();
  info = await et.meta.info();

  fillLangSelects();
  await loadSettingsUI();
  await refreshHistoryList();

  if (info && info.ocr && Array.isArray(info.ocr.languages)) {
    $('#ocrInfo').textContent = info.ocr.languages.join(' / ');
  }
  $('#aboutVer').textContent = 'v' + (info.version || '1.0.0');
  $('#ver').textContent = 'v' + (info.version || '1.0.0');
  updateSrcCount();
})();
