'use strict';
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const MAX_THUMB_W = 420;

function nowIso() { return new Date().toISOString(); }

function makeId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

class History {
  constructor() {
    this.root = path.join(app.getPath('userData'), 'history');
    this.imgDir = path.join(this.root, 'images');
    this.entryDir = path.join(this.root, 'entries');
    this.indexFile = path.join(this.root, 'index.json');
    this.index = [];
    this.ensureDirs();
    this.load();
  }

  ensureDirs() {
    for (const d of [this.root, this.imgDir, this.entryDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch { }
    }
  }

  load() {
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (!Array.isArray(this.index)) this.index = [];
    } catch {
      this.index = [];
    }
  }

  persist() {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 1), 'utf8');
    } catch (e) { console.error('[history] persist failed', e); }
  }

  /**
   * @param {object} e
   * @param {Buffer} e.image  PNG buffer（原始裁剪图）
   */
  add(e) {
    const id = e.id || makeId();
    const imgName = `${id}.png`;
    const thumbName = `${id}_thumb.png`;

    let w = 0, h = 0;
    try {
      fs.writeFileSync(path.join(this.imgDir, imgName), e.image);
      const img = nativeImage.createFromBuffer(e.image);
      const size = img.getSize();
      w = size.width; h = size.height;
      const thumb = (w > MAX_THUMB_W) ? img.resize({ width: MAX_THUMB_W, quality: 'good' }) : img;
      fs.writeFileSync(path.join(this.imgDir, thumbName), thumb.toPNG());
    } catch (err) {
      console.error('[history] write image failed', err);
    }

    const entry = {
      id,
      ts: e.ts || nowIso(),
      srcLang: e.srcLang || 'auto',
      targetLang: e.targetLang || 'zh-CN',
      text: e.text || '',
      translation: e.translation || '',
      provider: e.provider || '',
      model: e.model || '',
      ms: e.ms || 0,
      w, h,
      image: imgName,
      thumb: thumbName,
      lines: e.lines || [],
      blocks: e.blocks || []
    };

    try {
      fs.writeFileSync(path.join(this.entryDir, `${id}.json`), JSON.stringify(entry), 'utf8');
    } catch (err) { console.error('[history] write entry failed', err); }

    this.index.unshift({
      id: entry.id,
      ts: entry.ts,
      srcLang: entry.srcLang,
      targetLang: entry.targetLang,
      translation: entry.translation,
      text: entry.text,
      w, h,
      thumb: thumbName
    });
    this.prune();
    this.persist();
    return entry;
  }

  prune() {
    const limit = 3000;
    if (this.index.length > limit) {
      const drop = this.index.splice(limit);
      for (const it of drop) this.removeFiles(it.id);
    }
  }

  removeFiles(id) {
    for (const f of [`${id}.png`, `${id}_thumb.png`]) {
      try { fs.unlinkSync(path.join(this.imgDir, f)); } catch { }
    }
    try { fs.unlinkSync(path.join(this.entryDir, `${id}.json`)); } catch { }
  }

  /** 按设置里的条数裁剪旧记录 */
  trimTo(limit) {
    const n = Math.max(1, Number(limit) || 300);
    if (this.index.length > n) {
      const drop = this.index.splice(n);
      for (const it of drop) this.removeFiles(it.id);
      this.persist();
    }
  }

  list({ query = '', offset = 0, limit = 60 } = {}) {
    let items = this.index;
    const q = String(query || '').trim().toLowerCase();
    if (q) {
      items = items.filter((it) =>
        (it.translation || '').toLowerCase().includes(q) ||
        (it.text || '').toLowerCase().includes(q)
      );
    }
    return {
      total: items.length,
      items: items.slice(offset, offset + limit)
    };
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.entryDir, `${id}.json`), 'utf8'));
    } catch { return null; }
  }

  remove(id) {
    this.index = this.index.filter((it) => it.id !== id);
    this.removeFiles(id);
    this.persist();
    return true;
  }

  clear() {
    for (const it of this.index) this.removeFiles(it.id);
    this.index = [];
    this.persist();
    return true;
  }

  imagePath(name) {
    if (!name || /[\\/]|\.\./.test(name)) return null;
    const p = path.join(this.imgDir, path.basename(name));
    return fs.existsSync(p) ? p : null;
  }
}

module.exports = { History };
