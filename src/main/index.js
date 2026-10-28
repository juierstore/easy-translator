'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, protocol, net, shell, dialog, screen
} = require('electron');

const { Settings } = require('./settings');
const { History } = require('./history');
const { OcrWorker } = require('./ocr');
const { Translator } = require('./translate');
const { CaptureController } = require('./capture');
const wins = require('./wins');
const { LANGS } = require('./lang');

const isDev = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');

protocol.registerSchemesAsPrivileged([{
  scheme: 'etimg',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true }
}]);

let settings, history, ocrWorker, translator, capture;
let mainWindow = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showMain(); });
}

// ---------------- 主窗口 ----------------
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = wins.createMainWindow();
    attachMainWindowEvents();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function attachMainWindowEvents() {
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.webContents.once('did-finish-load', () => {
    if (!settings.getApiKey()) {
      mainWindow.webContents.send('app:toast', {
        message: '还没有配置 DeepSeek API Key：请到「设置」填写，或在设置里切换到免密通道'
      });
    }
  });
  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------- 托盘 ----------------
function buildTray() {
  const iconPath = wins.ICON;
  let img;
  try {
    img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }) : nativeImage.createEmpty();
  } catch { img = nativeImage.createEmpty(); }

  tray = new Tray(img);
  tray.setToolTip('EasyTranslator · 截图取词翻译');
  refreshTrayMenu();
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
}

function refreshTrayMenu() {
  if (!tray) return;
  const hk = settings.data.hotkey;
  const menu = Menu.buildFromTemplate([
    { label: `截图取词翻译  ${hk}`, click: () => capture.trigger() },
    { type: 'separator' },
    { label: '打开主窗口', click: () => showMain() },
    { label: '文字翻译', click: () => { showMain(); mainWindow?.webContents.send('app:navigate', 'text'); } },
    { label: '设置', click: () => { showMain(); mainWindow?.webContents.send('app:navigate', 'settings'); } },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---------------- 快捷键 ----------------
function tryRegister(accel) {
  try {
    globalShortcut.unregisterAll();
    const ok = globalShortcut.register(accel, () => capture.trigger());
    if (!ok) return { ok: false, error: '快捷键被其他程序占用' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerHotkey(accel) {
  if (!accel) { globalShortcut.unregisterAll(); return { ok: false, error: '未设置快捷键' }; }
  return tryRegister(accel);
}

// ---------------- 应用启动 ----------------
app.whenReady().then(async () => {
  app.setAppUserModelId('com.easytranslator.desktop');
  settings = new Settings();
  history = new History();
  ocrWorker = new OcrWorker(path.join(ROOT, 'scripts', 'ocr-worker.ps1'));
  translator = new Translator(settings);
  capture = new CaptureController({ settings, ocr: ocrWorker, translator, history });
  capture.attachMainWindow(() => mainWindow);

  protocol.handle('etimg', async (req) => {
    try {
      const u = new URL(req.url);
      const kind = u.hostname;
      const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
      let file = null;
      if (kind === 'history') file = history.imagePath(name);
      if (!file) return new Response('Not Found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch (e) {
      return new Response('Error', { status: 500 });
    }
  });

  registerIpc();
  buildTray();

  mainWindow = wins.createMainWindow();
  attachMainWindowEvents();

  const r = registerHotkey(settings.data.hotkey);
  console.log('[app] hotkey', settings.data.hotkey, r.ok ? 'registered' : 'FAILED: ' + r.error);
  if (!r.ok && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('app:toast', { type: 'warn', message: `快捷键 ${settings.data.hotkey} 注册失败：${r.error}` });
    });
  }

  // 预热 OCR 引擎，第一次截图就不用等
  ocrWorker.start().catch((e) => console.warn('[ocr] warmup failed', e.message));

  app.on('activate', () => showMain());

  // 开发自检钩子：命令行参数（源码运行）或环境变量（打包后运行）均可
  const hasFlag = (n) => process.argv.includes('--' + n) || process.env['ET_' + n.toUpperCase()] === '1';
  if (hasFlag('snap')) runSnapshotHarness();
  if (hasFlag('autocap')) {
    setTimeout(() => { try { capture.trigger(); } catch (e) { console.error(e); } }, 1800);
  }
  const demoArg = process.argv.find((a) => a === '--demo' || a.startsWith('--demo='))
    || (process.env.ET_DEMO ? '--demo=' + process.env.ET_DEMO : null);
  if (demoArg) runDemo(demoArg.includes('=') ? demoArg.split('=')[1] : null);
  if (hasFlag('democap')) runDemoCapture();
});

/** 开发用：真实走一遍 desktopCapturer → 裁剪 → OCR → 翻译 → 渲染，但不显示任何窗口 */
async function runDemoCapture() {
  const { desktopCapturer } = require('electron');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(800);
    try { mainWindow.webContents.send('app:navigate', 'settings'); } catch { }
    await sleep(700);
    const display = screen.getPrimaryDisplay();
    const maxW = Math.round(display.bounds.width * display.scaleFactor);
    const maxH = Math.round(display.bounds.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
    const src = sources[0];
    const size = src.thumbnail.getSize();
    const scale = size.width / display.bounds.width;
    console.log('[democap] source', size.width + 'x' + size.height, 'bounds', display.bounds.width + 'x' + display.bounds.height, 'scale', scale);

    const dip = { x: 120, y: 140, w: 1240, h: 500 };
    const px = {
      x: Math.round(dip.x * scale), y: Math.round(dip.y * scale),
      w: Math.round(dip.w * scale), h: Math.round(dip.h * scale)
    };
    const cropped = src.thumbnail.crop({ x: px.x, y: px.y, width: px.w, height: px.h });
    const pngBuffer = cropped.toPNG();
    const imageDataUrl = 'data:image/png;base64,' + pngBuffer.toString('base64');
    fs.writeFileSync(path.join(ROOT, '.tmp', 'democap-crop.png'), pngBuffer);
    console.log('[democap] crop', JSON.stringify(px), '->', cropped.getSize());

    await capture.onSelection({
      scale, px,
      winX: display.bounds.x, winY: display.bounds.y,
      displayX: display.bounds.x, displayY: display.bounds.y,
      imageDataUrl, pxW: px.w, pxH: px.h
    }, { silent: true });

    for (let i = 0; i < 240; i++) {
      await sleep(200);
      const s = capture.session;
      if (!s) break;
      if (['ready', 'error', 'empty'].includes(s.status)) break;
    }
    await sleep(600);
    const s = capture.session;
    console.log('[democap] status=' + s.status, 'blocks=' + s.blocks.length, 'ms=' + s.ms, 'err=' + s.error);
    const dir = path.join(ROOT, '.tmp');
    if (capture.resultWin && !capture.resultWin.isDestroyed()) {
      const im = await capture.resultWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'democap-result.png'), im.toPNG());
    }
    if (capture.toolbarWin && !capture.toolbarWin.isDestroyed()) {
      const im = await capture.toolbarWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'democap-toolbar.png'), im.toPNG());
    }
  } catch (e) {
    console.error('[democap] failed', e);
  }
  quitting = true;
  app.quit();
}

/**
 * 开发用：不截屏、不弹窗，直接把一张图片当作选区内图片跑完整流程，
 * 然后把结果层/工具条自身截图存盘，用于离线校验渲染效果。
 */
async function runDemo(imgPath) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const p = imgPath || path.join(ROOT, '.tmp', 'ocr-test.png');
  try {
    const pngBuffer = fs.readFileSync(p);
    const img = nativeImage.createFromBuffer(pngBuffer);
    const size = img.getSize();
    const imageDataUrl = 'data:image/png;base64,' + pngBuffer.toString('base64');
    const display = screen.getPrimaryDisplay();
    const rect = { x: 0, y: 0, width: size.width, height: size.height };

    await capture.startSession({
      rect, display, scale: 1, pxW: size.width, pxH: size.height,
      imageDataUrl, pngBuffer, silent: true,
      targetLang: process.env.ET_DEMO_TGT || undefined
    });

    for (let i = 0; i < 240; i++) {
      await sleep(200);
      const s = capture.session;
      if (!s) break;
      if (i % 10 === 0) console.log('[demo] wait', i, s.status);
      if (['ready', 'error', 'empty'].includes(s.status)) break;
    }
    await sleep(600);

    const s = capture.session;
    console.log('[demo] status=' + s.status, 'blocks=' + s.blocks.length,
      'ms=' + s.ms, 'src=' + s.srcLang, 'tgt=' + s.targetLang, 'err=' + s.error);
    console.log('[demo] blocks:', JSON.stringify(s.blocks.map((b) => ({ t: b.text.slice(0, 18), d: (b.dst || '').slice(0, 22) }))));

    const dir = path.join(ROOT, '.tmp');
    fs.mkdirSync(dir, { recursive: true });
    const shot = async (win, name) => {
      if (!win || win.isDestroyed()) return;
      const im = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name), im.toPNG());
    };

    await shot(capture.resultWin, 'demo-result.png');
    await shot(capture.toolbarWin, 'demo-toolbar.png');

    // 打开目标语言下拉，验证菜单与窗口动态增高
    try {
      await capture.toolbarWin.webContents.executeJavaScript("document.getElementById('tgtBtn').click(); true;");
      await sleep(600);
      await shot(capture.toolbarWin, 'demo-toolbar-menu.png');
      await capture.toolbarWin.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true;");
      await sleep(300);
    } catch (e) { console.error('[demo] menu shot failed', e.message); }

    await capture.action('toggleCompare');
    await sleep(450);
    await shot(capture.resultWin, 'demo-compare.png');
    await capture.action('toggleCompare');

    await capture.action('toggleOriginal');
    await sleep(350);
    await shot(capture.resultWin, 'demo-original.png');
    await capture.action('toggleOriginal');

    console.log('[demo] done');
  } catch (e) {
    console.error('[demo] failed', e);
  }
  quitting = true;
  app.quit();
}

/** 开发用：把主窗口各页面截图存盘（不受其它窗口遮挡） */
async function runSnapshotHarness() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(1500);
    const dir = path.join(ROOT, '.tmp');
    fs.mkdirSync(dir, { recursive: true });
    for (const page of ['history', 'text', 'settings']) {
      mainWindow.webContents.send('app:navigate', page);
      await sleep(800);
      const img = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `snap-${page}.png`), img.toPNG());
      console.log('[snap]', page, img.getSize());
    }
  } catch (e) {
    console.error('[snap] failed', e);
  }
  quitting = true;
  app.quit();
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { ocrWorker && ocrWorker.dispose(); } catch { }
});

app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });

// ---------------- IPC ----------------
function registerIpc() {
  // --- 框选层 ---
  ipcMain.handle('overlay:init', (ev) => {
    const data = capture.overlayPayloads.get(ev.sender.id) || null;
    return data;
  });

  ipcMain.handle('overlay:select', async (ev, payload) => {
    // 以窗口真实位置为准换算屏幕坐标，避免窗口被系统挪动时结果层错位
    let winX = payload && payload.winX;
    let winY = payload && payload.winY;
    try {
      const entry = capture.overlays.get(ev.sender.id);
      if (entry && entry.win && !entry.win.isDestroyed()) {
        const b = entry.win.getBounds();
        winX = b.x;
        winY = b.y;
      }
    } catch { }
    await capture.onSelection({ ...payload, winX, winY });
    return { ok: true };
  });

  ipcMain.handle('overlay:cancel', () => {
    capture.cancelSelection();
    return { ok: true };
  });

  ipcMain.on('overlay:ready', (ev) => {
    capture.showOverlay(ev.sender.id);
  });

  // --- 结果层 ---
  ipcMain.handle('result:init', () => capture.publicSession());
  ipcMain.handle('result:action', async (ev, { name, arg }) => capture.action(name, arg));

  // --- 工具条 ---
  ipcMain.handle('toolbar:init', () => ({
    session: capture.toolbarPayload(),
    langs: LANGS
  }));
  ipcMain.handle('toolbar:action', async (ev, { name, arg }) => capture.action(name, arg));

  // --- 通用 ---
  ipcMain.handle('meta:langs', () => LANGS);
  ipcMain.handle('meta:app', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    ocr: ocrWorker.readyInfo
  }));

  // --- 主窗口：设置 ---
  ipcMain.handle('settings:get', () => settings.publicView());
  ipcMain.handle('settings:patch', (ev, patch) => {
    const prev = settings.data.hotkey;
    if (patch && patch.hotkey && patch.hotkey !== prev) {
      const r = tryRegister(patch.hotkey);
      if (!r.ok) {
        tryRegister(prev);   // 恢复原快捷键，避免两个都用不了
        return { ...settings.publicView(), hotkeyError: r.error };
      }
    }
    const view = settings.patch(patch);
    if (patch && patch.hotkey) refreshTrayMenu();
    if (patch && patch.historyLimit) history.trimTo(patch.historyLimit);
    return view;
  });
  ipcMain.handle('settings:setKey', (ev, key) => settings.setApiKey(key));
  ipcMain.handle('settings:testKey', async () => {
    try {
      const r = await translator.testConnection();
      return { ok: true, sample: r.text };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // --- 主窗口：历史 ---
  ipcMain.handle('history:list', (ev, q) => history.list(q || {}));
  ipcMain.handle('history:get', (ev, id) => history.get(id));
  ipcMain.handle('history:remove', (ev, id) => history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());
  ipcMain.handle('history:reveal', (ev, id) => {
    const e = history.get(id);
    if (!e) return false;
    const p = history.imagePath(e.image);
    if (p) shell.showItemInFolder(p);
    return !!p;
  });

  // --- 主窗口：文字翻译 ---
  ipcMain.handle('translate:text', async (ev, { text, srcLang, targetLang, id }) => {
    try {
      const r = await translator.translateText(text, {
        srcLang, targetLang,
        onDelta: (delta, full) => {
          try { ev.sender.send('translate:delta', { id, delta, full }); } catch { }
        }
      });
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // --- 主窗口：窗口控制 ---
  ipcMain.handle('win:minimize', (ev) => { BrowserWindow.fromWebContents(ev.sender)?.minimize(); });
  ipcMain.handle('win:maximize', (ev) => {
    const w = BrowserWindow.fromWebContents(ev.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('win:close', (ev) => { BrowserWindow.fromWebContents(ev.sender)?.hide(); });
  ipcMain.handle('win:isMax', (ev) => BrowserWindow.fromWebContents(ev.sender)?.isMaximized() || false);

  // --- 主窗口：其他 ---
  ipcMain.handle('capture:start', async () => { await capture.trigger(); return true; });
  ipcMain.handle('app:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openExternal', (ev, url) => shell.openExternal(url));
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
}
