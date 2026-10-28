'use strict';
const fs = require('fs');
const path = require('path');
const { app, desktopCapturer, screen, dialog, clipboard, shell, ipcMain, nativeImage } = require('electron');
const wins = require('./wins');
const { groupLines } = require('./blocks');
const { normalizeOcrLang, autoSwapPair, getLang } = require('./lang');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch { }
}

class CaptureController {
  constructor({ settings, ocr, translator, history }) {
    this.settings = settings;
    this.ocr = ocr;
    this.translator = translator;
    this.history = history;

    this.active = false;
    this.busy = false;
    this.session = null;
    this.overlays = new Map();     // webContents.id -> {win, display, source}
    this.overlayPayloads = new Map();
    this.overlayShown = new Set();
    this.resultWin = null;
    this.toolbarWin = null;
    this.restoreMain = false;
    this.mainWindowGetter = null;
    this.toolbarSize = { width: 700, height: 46 };
  }

  attachMainWindow(getter) { this.mainWindowGetter = getter; }

  /** 快捷键 / 托盘触发入口 */
  async trigger() {
    if (this.active) { this.cancelSelection(); return; }
    if (this.session) { this.closeSession(); return; }
    if (this.busy) return;
    await this.startSelection();
  }

  /** 渲染进程画完首帧后显示，避免白闪 */
  showOverlay(webContentsId) {
    const entry = this.overlays.get(webContentsId);
    console.log('[capture] overlay ready ->', webContentsId, !!entry);
    if (!entry) return;
    const win = entry.win;
    try {
      if (win.isDestroyed()) return;
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
      win.focus();
    } catch { }
  }

  async startSelection() {
    if (this.busy) return;
    this.busy = true;
    try {
      const mw = this.mainWindowGetter && this.mainWindowGetter();
      this.restoreMain = !!(mw && mw.isVisible());
      if (this.restoreMain) { mw.hide(); await sleep(220); }

      const displays = screen.getAllDisplays();
      const maxW = Math.max(800, ...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
      const maxH = Math.max(600, ...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: maxW, height: maxH },
        fetchWindowIcons: false
      });

      console.log('[capture] displays=', displays.map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}`).join(' '));
      console.log('[capture] sources=', sources.length, sources.map((s) => `${s.display_id}:${s.thumbnail.getSize().width}x${s.thumbnail.getSize().height}`).join(' '));

      if (!sources.length) throw new Error('无法捕获屏幕');

      this.overlays.clear();
      this.overlayPayloads.clear();
      this.overlayShown.clear();

      for (const display of displays) {
        const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[display.index] || sources[0];
        if (!src || src.thumbnail.isEmpty()) continue;

        const size = src.thumbnail.getSize();
        const imageDataUrl = src.thumbnail.toDataURL();
        const win = wins.createOverlayWindow(display);
        const key = win.webContents.id;

        this.overlays.set(key, { win, display, source: src });
        this.overlayPayloads.set(key, {
          displayIndex: display.index,
          displayX: display.bounds.x,
          displayY: display.bounds.y,
          displayW: display.bounds.width,
          displayH: display.bounds.height,
          scale: size.width / display.bounds.width,
          pxW: size.width,
          pxH: size.height,
          imageDataUrl
        });

        win.webContents.once('did-finish-load', () => {
          send(win, 'overlay:data', this.overlayPayloads.get(key));
        });
        win.on('closed', () => {
          this.overlays.delete(key);
          this.overlayPayloads.delete(key);
        });
      }

      if (!this.overlays.size) throw new Error('无法创建选区窗口');
      this.active = true;
    } catch (e) {
      console.error('[capture] start failed', e);
      this.busy = false;
      this.active = false;
      wins.destroyOverlays();
      const mw = this.mainWindowGetter && this.mainWindowGetter();
      if (this.restoreMain && mw) mw.show();
      if (mw) send(mw, 'app:toast', { type: 'error', message: '截图失败：' + (e.message || e) });
      throw e;
    } finally {
      this.busy = false;
    }
  }

  cancelSelection() {
    this.active = false;
    wins.destroyOverlays();
    this.overlays.clear();
    this.overlayPayloads.clear();
    const mw = this.mainWindowGetter && this.mainWindowGetter();
    if (this.restoreMain && mw) mw.show();
    this.restoreMain = false;
    send(mw, 'capture:cancelled', {});
  }

  /** 选区完成 */
  async onSelection(payload, opts = {}) {
    if (this.session) return;
    try {
      wins.destroyOverlays();
      this.active = false;

      const { scale, px, displayX, displayY, imageDataUrl, pxW, pxH } = payload;
      if (!px || px.w < 2 || px.h < 2) { this.cancelSelection(); return; }

      const dipX = displayX + px.x / scale;
      const dipY = displayY + px.y / scale;
      const dipW = px.w / scale;
      const dipH = px.h / scale;

      const display = screen.getDisplayNearestPoint({ x: Math.round(dipX + 1), y: Math.round(dipY + 1) });
      const rect = {
        x: Math.round(dipX),
        y: Math.round(dipY),
        width: Math.max(4, Math.round(dipW)),
        height: Math.max(4, Math.round(dipH))
      };

      const base64 = String(imageDataUrl).replace(/^data:image\/png;base64,/, '');
      const pngBuffer = Buffer.from(base64, 'base64');

      await this.startSession({
        rect, display, scale,
        pxW: px.w, pxH: px.h,
        imageDataUrl, pngBuffer,
        silent: opts.silent
      });
    } catch (e) {
      console.error('[capture] selection failed', e);
      this.closeSession();
    }
  }

  /** 会话主体：建立结果层/工具条并跑识别翻译流程（截屏与 demo 共用） */
  async startSession({ rect, display, scale, pxW, pxH, imageDataUrl, pngBuffer, targetLang, silent }) {
    this.session = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
      rect,
      display,
      scale,
      pxW,
      pxH,
      imageDataUrl,
      pngBuffer,
      srcLang: this.settings.data.ocrLang === 'auto' ? 'auto' : normalizeOcrLang(this.settings.data.ocrLang),
      targetLang: targetLang || this.settings.data.targetLang || 'zh-CN',
      status: 'ocr',           // ocr | translating | ready | empty | error
      error: '',
      lines: [],
      blocks: [],
      showOriginal: false,
      compare: false,
      ms: 0
    };

    // 结果层
    const rw = wins.createResultWindow(rect, display);
    this.resultWin = rw;
    rw.webContents.once('did-finish-load', () => send(rw, 'result:data', this.publicSession()));
    rw.once('ready-to-show', () => { if (silent) return; try { rw.showInactive(); rw.setAlwaysOnTop(true, 'screen-saver'); } catch { } });
    rw.on('closed', () => { if (this.resultWin === rw) this.resultWin = null; });

    // 工具条
    const tw = wins.createToolbarWindow(this.toolbarSize.width, this.toolbarSize.height);
    this.toolbarWin = tw;
    const pos = wins.placeToolbar(rect, this.toolbarSize, display.workArea);
    tw.setPosition(pos.x, pos.y);
    tw.webContents.once('did-finish-load', () => send(tw, 'toolbar:data', this.toolbarPayload()));
    tw.once('ready-to-show', () => { if (silent) return; try { tw.show(); tw.focus(); } catch { } });
    tw.on('closed', () => {
      if (this.toolbarWin === tw) this.toolbarWin = null;
      if (this.session && !this._closingSession && !silent) this.closeSession();
    });
    tw.on('blur', () => {
      if (silent) return;
      setTimeout(() => {
        if (this.session && this.settings.data.closeOnBlur && !this._closingSession) {
          if (tw.isDestroyed() || !tw.isFocused()) this.closeSession();
        }
      }, 220);
    });

    this.runPipeline();
  }

  publicSession() {
    const s = this.session;
    if (!s) return null;
    return {
      id: s.id,
      ts: s.ts,
      imageDataUrl: s.imageDataUrl,
      pxW: s.pxW,
      pxH: s.pxH,
      rect: s.rect,
      srcLang: s.srcLang,
      targetLang: s.targetLang,
      status: s.status,
      error: s.error,
      lines: s.lines,
      blocks: s.blocks,
      showOriginal: s.showOriginal,
      compare: s.compare,
      ms: s.ms
    };
  }

  toolbarPayload() {
    const s = this.session;
    if (!s) return null;
    return {
      id: s.id,
      srcLang: s.srcLang,
      targetLang: s.targetLang,
      status: s.status,
      error: s.error,
      provider: this.settings.data.provider
    };
  }

  broadcast() {
    send(this.resultWin, 'result:data', this.publicSession());
    send(this.toolbarWin, 'toolbar:data', this.toolbarPayload());
  }

  setStatus(status, error = '') {
    if (!this.session) return;
    this.session.status = status;
    this.session.error = error;
    this.broadcast();
  }

  async runPipeline() {
    const s = this.session;
    if (!s) return;
    const started = Date.now();
    const tmpDir = path.join(app.getPath('temp'), 'easy-translator');
    const tmpFile = path.join(tmpDir, `cap-${s.id}.png`);
    let ocrResult = null;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(tmpFile, s.pngBuffer);

      this.setStatus('ocr');
      const wantedOcr = s.srcLang === 'auto' ? 'auto' : (this.settings.data.ocrLang === 'auto' ? 'auto' : s.srcLang);
      const ocrLang = s.srcLang === 'auto' ? 'auto' : (s.srcLang === 'zh-TW' ? 'zh-Hans-CN' : s.srcLang === 'zh-CN' ? 'zh-Hans-CN' : s.srcLang);

      ocrResult = await this.ocr.recognize(tmpFile, {
        lang: s.srcLang === 'auto' ? 'auto' : ocrLang,
        upscale: this.settings.data.ocrUpscale || 2
      });

      try { fs.unlinkSync(tmpFile); } catch { }

      const lines = (ocrResult.lines || []).map((l) => ({
        text: l.text,
        x: l.x, y: l.y, w: l.w, h: l.h
      }));
      s.lines = lines;

      const detected = normalizeOcrLang(ocrResult.lang);
      if (s.srcLang === 'auto') s.srcLang = detected !== 'auto' ? detected : 'auto';

      const rawBlocks = groupLines(lines);
      if (!rawBlocks.length) {
        s.blocks = [];
        this.setStatus('empty');
        this.saveHistory('');
        return;
      }

      // 目标语言与源语言相同时自动对调
      const pair = autoSwapPair(s.srcLang, s.targetLang);
      if (pair.tgt !== s.targetLang) s.targetLang = pair.tgt;

      s.blocks = rawBlocks.map((b) => ({
        text: b.text, x: b.x, y: b.y, w: b.w, h: b.h,
        nLines: (b.lines && b.lines.length) || 1, dst: ''
      }));
      this.setStatus('translating');

      let translations = [];
      try {
        translations = await this.translator.translateBlocks(rawBlocks.map((b) => b.text), {
          srcLang: s.srcLang, targetLang: s.targetLang
        });
      } catch (e) {
        s.ms = Date.now() - started;
        this.setStatus('error', e.message || String(e));
        return;
      }

      s.blocks = rawBlocks.map((b, i) => ({
        text: b.text, x: b.x, y: b.y, w: b.w, h: b.h,
        nLines: (b.lines && b.lines.length) || 1,
        dst: (translations[i] || '').trim()
      }));
      s.ms = Date.now() - started;
      this.setStatus('ready');
      this.saveHistory(s.blocks.map((b) => b.dst).join('\n'));
    } catch (e) {
      console.error('[capture] pipeline failed', e);
      try { fs.unlinkSync(tmpFile); } catch { }
      this.setStatus('error', e.message || String(e));
    }
  }

  saveHistory(translation) {
    if (!this.session) return;
    if (!this.settings.data.keepHistory) return;
    if (!this.session.blocks || !this.session.blocks.length) return;
    try {
      const entry = this.history.add({
        ts: this.session.ts,
        srcLang: this.session.srcLang,
        targetLang: this.session.targetLang,
        text: this.session.blocks.map((b) => b.text).join('\n'),
        translation,
        provider: this.settings.data.provider,
        model: this.settings.data.provider === 'deepseek' ? this.settings.data.model : 'mymemory',
        ms: this.session.ms || 0,
        image: this.session.pngBuffer,
        lines: this.session.lines,
        blocks: this.session.blocks
      });
      this.session.historyId = entry.id;
      const mw = this.mainWindowGetter && this.mainWindowGetter();
      send(mw, 'history:added', { id: entry.id });
    } catch (e) {
      console.error('[capture] save history failed', e);
    }
  }

  /** 让结果层把它当前画布导出成 PNG dataURL */
  exportPng(timeout = 4000) {
    return new Promise((resolve, reject) => {
      const wc = this.resultWin && !this.resultWin.isDestroyed() ? this.resultWin.webContents : null;
      if (!wc) { reject(new Error('结果窗口不存在')); return; }

      const channel = 'result:export-reply';
      const cleanup = () => {
        clearTimeout(timer);
        ipcMain.removeListener(channel, onReply);
      };
      const onReply = (ev, dataUrl) => {
        if (ev.sender.id !== wc.id) return;
        cleanup();
        if (!dataUrl) reject(new Error('导出为空'));
        else resolve(dataUrl);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('导出超时')); }, timeout);

      ipcMain.on(channel, onReply);
      try { wc.send('result:export'); } catch (e) { cleanup(); reject(e); }
    });
  }

  /** 工具条 / 结果层发来的动作 */
  async action(name, arg) {
    const s = this.session;
    if (!s) return { ok: false };

    switch (name) {
      case 'close':
        this.closeSession();
        return { ok: true };

      case 'copy': {
        const which = (arg && arg.which) === 'src' ? 'src' : 'dst';
        const text = (s.blocks || [])
          .map((b) => (which === 'src' ? b.text : b.dst))
          .filter(Boolean)
          .join('\n');
        clipboard.writeText(text || '');
        return { ok: true, text, which };
      }

      case 'setLang': {
        const { which, code } = arg || {};
        if (which === 'target' && code && code !== s.targetLang) {
          s.targetLang = code;
          this.settings.patch({ targetLang: code });
          this.broadcast();
          await this.retranslate();
          return { ok: true };
        }
        if (which === 'source' && code && code !== s.srcLang) {
          s.srcLang = code;
          this.broadcast();
          await this.retranslate({ reOcr: true });
          return { ok: true };
        }
        return { ok: true };
      }

      case 'toggleCompare':
        s.compare = !s.compare;
        this.broadcast();
        return { ok: true, compare: s.compare };

      case 'toggleOriginal':
        s.showOriginal = !s.showOriginal;
        this.broadcast();
        return { ok: true, showOriginal: s.showOriginal };

      case 'retry':
        await this.retranslate({ reOcr: s.status === 'empty' });
        return { ok: true };

      case 'saveImage': {
        let dataUrl = arg && arg.dataUrl;
        if (!dataUrl) {
          try { dataUrl = await this.exportPng(); } catch (e) {
            return { ok: false, error: '导出图片失败：' + (e.message || e) };
          }
        }
        const stamp = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const name = `翻译截图_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}_${p(stamp.getHours())}${p(stamp.getMinutes())}${p(stamp.getSeconds())}.png`;
        const pics = app.getPath('pictures');
        const res = await dialog.showSaveDialog(this.toolbarWin || undefined, {
          title: '保存截图',
          defaultPath: path.join(pics, name),
          filters: [{ name: 'PNG 图片', extensions: ['png'] }]
        });
        if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
        const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(res.filePath, Buffer.from(b64, 'base64'));
        return { ok: true, path: res.filePath };
      }

      case 'copyImage': {
        let dataUrl = arg && arg.dataUrl;
        if (!dataUrl) {
          try { dataUrl = await this.exportPng(); } catch { return { ok: false }; }
        }
        clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
        return { ok: true };
      }

      case 'openDataFolder':
        shell.openPath(app.getPath('userData'));
        return { ok: true };

      case 'resizeToolbar': {
        if (!this.toolbarWin || this.toolbarWin.isDestroyed()) return { ok: false };
        const h = Math.max(40, Math.min(520, Number(arg) || 46));
        const b = this.toolbarWin.getBounds();
        const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
        const maxBottom = display.workArea.y + display.workArea.height;
        const y = Math.max(display.workArea.y, Math.min(b.y, maxBottom - h - 2));
        this.toolbarWin.setBounds({ x: b.x, y, width: b.width, height: h });
        return { ok: true };
      }

      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  async retranslate({ reOcr = false } = {}) {
    const s = this.session;
    if (!s) return;
    if (reOcr) { await this.runPipeline(); return; }

    const started = Date.now();
    this.setStatus('translating');
    try {
      const texts = (s.blocks || []).map((b) => b.text);
      const out = await this.translator.translateBlocks(texts, { srcLang: s.srcLang, targetLang: s.targetLang });
      s.blocks = s.blocks.map((b, i) => ({ ...b, dst: (out[i] || '').trim() }));
      s.ms = Date.now() - started;
      this.setStatus('ready');
      if (s.historyId) {
        this.history.update?.(s.historyId, { translation: s.blocks.map((b) => b.dst).join('\n'), targetLang: s.targetLang });
      }
    } catch (e) {
      this.setStatus('error', e.message || String(e));
    }
  }

  closeSession() {
    if (this._closingSession) return;
    this._closingSession = true;
    try {
      this.session = null;
      const rw = this.resultWin; this.resultWin = null;
      const tw = this.toolbarWin; this.toolbarWin = null;
      try { if (rw && !rw.isDestroyed()) rw.destroy(); } catch { }
      try { if (tw && !tw.isDestroyed()) tw.destroy(); } catch { }
      wins.destroyOverlays();
      const mw = this.mainWindowGetter && this.mainWindowGetter();
      if (this.restoreMain && mw) { mw.show(); }
      this.restoreMain = false;
    } finally {
      setTimeout(() => { this._closingSession = false; }, 120);
    }
  }
}

module.exports = { CaptureController };
