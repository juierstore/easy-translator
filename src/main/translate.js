'use strict';
const { getLang } = require('./lang');

class TranslateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TranslateError';
    this.code = code || 'ERR';
  }
}

const HTTP_HINTS = {
  400: '请求格式有误',
  401: 'API Key 无效或已过期，请到设置里重新填写',
  402: '账户余额不足，请到 DeepSeek 平台充值',
  403: '该 Key 没有访问权限',
  404: '接口地址不存在，请检查 Base URL',
  422: '参数错误',
  429: '请求过于频繁，请稍后再试',
  500: '服务端错误，请重试',
  502: '网关错误，请重试',
  503: '服务暂时不可用，请重试'
};

function normalizeBase(base) {
  let b = String(base || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b;
  return b;
}

function endpoint(base, suffix) {
  const b = normalizeBase(base);
  if (b.endsWith('/chat/completions')) return b;
  return b + suffix;
}

function withTimeout(ms, externalSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('请求超时')), ms);
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.search(/[[{]/);
  if (first < 0) return null;
  const openCh = t[first];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(t.slice(first, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

class Translator {
  constructor(settings) {
    this.settings = settings;
  }

  get s() { return this.settings.data; }

  async deepseek(messages, { stream = false, json = false, signal, maxTokens = 2000 } = {}) {
    const key = this.settings.getApiKey();
    if (!key) {
      throw new TranslateError('还没有配置 DeepSeek API Key，请到「设置」里填写，或临时切换到免密翻译。', 'NO_KEY');
    }
    const body = {
      model: this.s.model || 'deepseek-chat',
      messages,
      temperature: 0.2,
      stream: !!stream,
      max_tokens: maxTokens
    };
    if (json && !String(this.s.model).includes('reasoner')) {
      body.response_format = { type: 'json_object' };
    }

    const t = withTimeout(stream ? 120000 : 60000, signal);
    let res;
    try {
      res = await fetch(endpoint(this.s.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: t.signal
      });
    } catch (e) {
      t.done();
      if (e.name === 'AbortError') throw new TranslateError('请求已取消或超时', 'ABORT');
      throw new TranslateError('网络连接失败：' + (e.message || e), 'NET');
    }

    if (!res.ok) {
      t.done();
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || '';
      } catch { }
      const hint = HTTP_HINTS[res.status] || `HTTP ${res.status}`;
      throw new TranslateError(detail ? `${hint}：${detail}` : hint, 'HTTP_' + res.status);
    }

    if (stream) return { res, done: t.done };
    const data = await res.json();
    t.done();
    const text = data?.choices?.[0]?.message?.content || '';
    return { text, usage: data?.usage };
  }

  /** 批量翻译（截图取词用）：按块对齐返回 */
  async translateBlocks(texts, { srcLang, targetLang, signal } = {}) {
    const items = texts.map((t) => String(t || ''));
    if (!items.length) return [];

    const provider = this.s.provider;
    if (provider === 'free') {
      return this.translateBlocksFree(items, { srcLang, targetLang, signal });
    }
    return this.translateBlocksDeepseek(items, { srcLang, targetLang, signal });
  }

  async translateBlocksDeepseek(items, { srcLang, targetLang, signal } = {}) {
    const tg = getLang(targetLang);
    const sl = getLang(srcLang);
    const out = new Array(items.length).fill('');

    // 过长的输入拆成多批，避免单次返回被截断
    const batches = [];
    let cur = [], curLen = 0;
    for (let i = 0; i < items.length; i++) {
      const len = items[i].length;
      if (cur.length && curLen + len > 2200) { batches.push(cur); cur = []; curLen = 0; }
      cur.push(i);
      curLen += len + 8;
    }
    if (cur.length) batches.push(cur);

    const sys = [
      '你是一个高质量的截图取词翻译引擎。',
      `把用户提供的 JSON 字符串数组里的每一条，翻译成${tg.prompt}。`,
      sl.code === 'auto' ? '源语言请自动判断。' : `源语言是${sl.prompt}。`,
      '严格要求：',
      '1. 只输出 JSON 对象，形如 {"t":["译文1","译文2"]}，数组长度必须与输入完全一致，顺序对应。',
      '2. 只翻译，不解释、不加引号、不合并句子。',
      '3. 保留原文中的数字、变量名、代码标识符、专有名词、URL、占位符。',
      '4. 若某条本身是纯符号/数字/无需翻译，原样返回。',
      '5. 译文要贴合原文长度，界面文本要简洁自然。'
    ].join('\n');

    for (const batch of batches) {
      const payload = batch.map((i) => items[i]);
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: JSON.stringify(payload) }
      ];
      let parsed = null;
      try {
        const { text } = await this.deepseek(messages, { json: true, signal, maxTokens: 4000 });
        const j = extractJson(text);
        if (Array.isArray(j)) parsed = j;
        else if (j && Array.isArray(j.t)) parsed = j.t;
        else if (j && Array.isArray(j.translations)) parsed = j.translations;
      } catch (e) {
        if (e.code === 'NO_KEY') throw e; // 让上层给出明确提示
        parsed = null;
      }

      if (parsed && parsed.length === batch.length) {
        batch.forEach((idx, k) => { out[idx] = String(parsed[k] ?? ''); });
      } else {
        // 解析失败或长度不匹配：逐条兜底
        for (const idx of batch) {
          try {
            const { text } = await this.deepseek([
              { role: 'system', content: `把下面的文本翻译成${tg.prompt}，只输出译文本身。` },
              { role: 'user', content: items[idx] }
            ], { signal, maxTokens: 1200 });
            out[idx] = String(text || '').trim();
          } catch (e) {
            if (e.code === 'NO_KEY') throw e;
            out[idx] = '';
          }
        }
      }
    }
    return out;
  }

  async translateBlocksFree(items, { srcLang, targetLang, signal } = {}) {
    const out = new Array(items.length).fill('');
    const sl = srcLang === 'auto' ? 'auto' : getLang(srcLang).google;
    const tl = getLang(targetLang).google;

    const todo = [];
    for (let i = 0; i < items.length; i++) if (items[i] && items[i].trim()) todo.push(i);

    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const i = todo[cursor++];
        try {
          out[i] = await this.freeOne(items[i], sl, tl, signal);
        } catch {
          out[i] = '';
        }
      }
    };
    const n = Math.max(1, Math.min(3, todo.length));
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  async freeOne(text, sl, tl, signal) {
    // 1) MyMemory（免密、国内可直连）
    try {
      const u = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sl === 'auto' ? 'en' : sl)}|${encodeURIComponent(tl)}`;
      const t = withTimeout(15000, signal);
      const r = await fetch(u, { signal: t.signal });
      t.done();
      if (r.ok) {
        const j = await r.json();
        const s = j?.responseData?.translatedText;
        if (s && !/^MYMEMORY WARNING/i.test(s)) return s;
      }
    } catch { }

    // 2) Google gtx（部分网络可用）
    const t2 = withTimeout(12000, signal);
    try {
      const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
      const r = await fetch(u, { signal: t2.signal });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && Array.isArray(j[0])) {
          return j[0].map((seg) => seg[0]).join('');
        }
      }
    } catch { } finally { t2.done(); }

    throw new TranslateError('免密翻译通道不可用（网络受限）', 'FREE_FAIL');
  }

  /** 文字翻译（主窗口用，支持流式） */
  async translateText(text, { srcLang, targetLang, onDelta, signal } = {}) {
    const tg = getLang(targetLang);
    const sl = getLang(srcLang);
    if (this.s.provider === 'free') {
      const v = await this.freeOne(text, sl.google, tg.google, signal);
      if (onDelta) onDelta(v);
      return { text: v, provider: 'free' };
    }

    const messages = [
      {
        role: 'system',
        content: `你是一个专业的翻译引擎。请把用户输入的文本翻译成${tg.prompt}。` +
          (sl.code === 'auto' ? '自动判断源语言。' : `源语言是${sl.prompt}。`) +
          '只输出译文，不要任何解释、前言、引号或 Markdown 代码块。'
      },
      { role: 'user', content: text }
    ];

    if (!onDelta) {
      const { text: out } = await this.deepseek(messages, { signal, maxTokens: 4000 });
      return { text: String(out || '').trim(), provider: 'deepseek' };
    }

    const { res, done } = await this.deepseek(messages, { stream: true, signal, maxTokens: 4000 });
    let full = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content;
            if (delta) { full += delta; if (onDelta) onDelta(delta, full); }
          } catch { }
        }
      }
    } finally {
      done();
    }
    return { text: full.trim(), provider: 'deepseek' };
  }

  async testConnection() {
    const { text } = await this.deepseek([
      { role: 'system', content: '你是翻译引擎，只输出译文。' },
      { role: 'user', content: 'Hello' }
    ], { maxTokens: 20 });
    return { text: String(text || '').trim() };
  }
}

module.exports = { Translator, TranslateError };
