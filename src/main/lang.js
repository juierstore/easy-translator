'use strict';
/** 支持的语言表（主进程与渲染进程共用同一份数据） */

const LANGS = [
  { code: 'auto',  name: '自动检测', short: '自动', google: 'auto',  prompt: 'auto-detect' },
  { code: 'zh-CN', name: '简体中文', short: '简中', google: 'zh-CN', prompt: 'Simplified Chinese' },
  { code: 'zh-TW', name: '繁體中文', short: '繁中', google: 'zh-TW', prompt: 'Traditional Chinese' },
  { code: 'en',    name: '英语',     short: '英语', google: 'en',    prompt: 'English' },
  { code: 'ja',    name: '日语',     short: '日语', google: 'ja',    prompt: 'Japanese' },
  { code: 'ko',    name: '韩语',     short: '韩语', google: 'ko',    prompt: 'Korean' },
  { code: 'fr',    name: '法语',     short: '法语', google: 'fr',    prompt: 'French' },
  { code: 'de',    name: '德语',     short: '德语', google: 'de',    prompt: 'German' },
  { code: 'es',    name: '西班牙语', short: '西语', google: 'es',    prompt: 'Spanish' },
  { code: 'ru',    name: '俄语',     short: '俄语', google: 'ru',    prompt: 'Russian' },
  { code: 'pt',    name: '葡萄牙语', short: '葡语', google: 'pt',    prompt: 'Portuguese' },
  { code: 'it',    name: '意大利语', short: '意语', google: 'it',    prompt: 'Italian' },
  { code: 'ar',    name: '阿拉伯语', short: '阿语', google: 'ar',    prompt: 'Arabic' },
  { code: 'th',    name: '泰语',     short: '泰语', google: 'th',    prompt: 'Thai' },
  { code: 'vi',    name: '越南语',   short: '越语', google: 'vi',    prompt: 'Vietnamese' }
];

const BY_CODE = new Map(LANGS.map((l) => [l.code, l]));

function getLang(code) {
  return BY_CODE.get(code) || BY_CODE.get('auto');
}

/** OCR 返回的 BCP-47 tag 归一化到我们的语言码 */
function normalizeOcrLang(tag) {
  if (!tag) return 'auto';
  const t = String(tag).toLowerCase();
  if (t.startsWith('zh-hant') || t.includes('-tw') || t.includes('-hk')) return 'zh-TW';
  if (t.startsWith('zh')) return 'zh-CN';
  if (t.startsWith('en')) return 'en';
  if (t.startsWith('ja')) return 'ja';
  if (t.startsWith('ko')) return 'ko';
  if (t.startsWith('fr')) return 'fr';
  if (t.startsWith('de')) return 'de';
  if (t.startsWith('es')) return 'es';
  if (t.startsWith('ru')) return 'ru';
  if (t.startsWith('pt')) return 'pt';
  if (t.startsWith('it')) return 'it';
  if (t.startsWith('ar')) return 'ar';
  if (t.startsWith('th')) return 'th';
  if (t.startsWith('vi')) return 'vi';
  return 'auto';
}

/** 简单的本地语种猜测，用于 OCR 语言无法判断时兜底 */
function guessLang(text) {
  if (!text) return 'auto';
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const hira = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (hira > 2) return 'ja';
  if (hangul > 2) return 'ko';
  if (cjk > 1) return 'zh-CN';
  if (latin > 1) return 'en';
  return 'auto';
}

/** 源语种与目标语种相同时自动对调 */
function autoSwapPair(src, tgt) {
  if (src === 'auto' || !src) return { src, tgt };
  if (src === tgt) {
    if (src === 'zh-CN') return { src, tgt: 'en' };
    if (src === 'en') return { src, tgt: 'zh-CN' };
    return { src, tgt: 'zh-CN' };
  }
  return { src, tgt };
}

module.exports = { LANGS, getLang, normalizeOcrLang, guessLang, autoSwapPair };
