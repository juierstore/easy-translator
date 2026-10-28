'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  hotkey: 'Alt+Shift+S',
  apiKeyEnc: '',
  apiKeyPlain: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  provider: 'deepseek',        // deepseek | free
  srcLang: 'en',               // auto | en | zh-CN | ...
  targetLang: 'zh-CN',
  ocrUpscale: 2,
  keepHistory: true,
  historyLimit: 300,
  closeOnBlur: true
};

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    this._cachedKey = undefined;
    this.load();
  }

  load() {
    try {
      let raw = fs.readFileSync(this.file, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);   // 兼容带 BOM 的 json
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULTS, ...parsed };
    } catch {
      this.data = { ...DEFAULTS };
    }
    this._cachedKey = undefined;
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[settings] save failed', e);
    }
  }

  /** 对外安全的快照：不带明文 key */
  publicView() {
    return {
      ...this.data,
      apiKeyEnc: undefined,
      apiKeyPlain: undefined,
      hasApiKey: !!this.getApiKey(),
      apiKeyHint: this.getKeyHint()
    };
  }

  patch(partial) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(partial || {})) {
      if (allowed.includes(k)) this.data[k] = v;
    }
    this.save();
    return this.publicView();
  }

  setApiKey(key) {
    const k = String(key || '').trim();
    this.data.apiKeyEnc = '';
    this.data.apiKeyPlain = '';
    this._cachedKey = undefined;
    if (!k) { this.save(); return this.publicView(); }
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      try {
        this.data.apiKeyEnc = safeStorage.encryptString(k).toString('base64');
        this.save();
        return this.publicView();
      } catch { /* 降级到明文 */ }
    }
    this.data.apiKeyPlain = k;
    this.save();
    return this.publicView();
  }

  getApiKey() {
    if (this._cachedKey !== undefined) return this._cachedKey;
    let key = '';
    if (this.data.apiKeyEnc) {
      try {
        key = safeStorage.decryptString(Buffer.from(this.data.apiKeyEnc, 'base64'));
      } catch { key = ''; }
    } else {
      key = this.data.apiKeyPlain || process.env.DEEPSEEK_API_KEY || '';
    }
    this._cachedKey = key || '';
    return this._cachedKey;
  }

  getKeyHint() {
    const k = this.getApiKey();
    if (!k) return '';
    if (k.length <= 10) return k.slice(0, 2) + '••••';
    return k.slice(0, 6) + '••••••' + k.slice(-4);
  }
}

module.exports = { Settings, DEFAULTS };
