'use strict';

/**
 * 结果层渲染器
 * 目标：把原文"糊化"掉，并在原位绘制目标语言文本
 * 关键点：背景色自适应、文字容器自适应、字号自适应
 */

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

let state = null;
let img = null;
let imgData = null;        // ImageData 缓存（用于取背景色）
let blurred = null;        // 预先模糊的底图
let uiScale = 1;
let lastImageKey = '';

const LINE_H = 1.3;
const FONT_STACK = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

const CJK_RE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/;
const CJK_ONE = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]/;

/* ---------------- 颜色工具 ---------------- */
function srgbToLin(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(r, g, b) {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrastRatio(l1, l2) {
  const a = Math.max(l1, l2), b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}
function mix(c, target, amount) {
  return [
    Math.round(c[0] + (target[0] - c[0]) * amount),
    Math.round(c[1] + (target[1] - c[1]) * amount),
    Math.round(c[2] + (target[2] - c[2]) * amount)
  ];
}
function rgbStr(c, a = 1) {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** 估计矩形区域的主背景色（取出现频率最高的量化色） */
function estimateBackground(data, x, y, w, h) {
  const iw = data.width, ih = data.height;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(iw, Math.ceil(x + w)), y1 = Math.min(ih, Math.ceil(y + h));
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 22));
  const counts = new Map();
  let n = 0;
  for (let yy = y0; yy < y1; yy += step) {
    for (let xx = x0; xx < x1; xx += step) {
      const i = (yy * iw + xx) * 4;
      const key = ((data.data[i] >> 3) << 10) | ((data.data[i + 1] >> 3) << 5) | (data.data[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
      n++;
    }
  }
  if (!n) return [255, 255, 255];
  let bestKey = 0, best = -1;
  for (const [k, v] of counts) if (v > best) { best = v; bestKey = k; }

  // 对该色桶内的实际像素取均值
  const tr = (bestKey >> 10) & 31, tg = (bestKey >> 5) & 31, tb = bestKey & 31;
  let sr = 0, sg = 0, sb = 0, c = 0;
  for (let yy = y0; yy < y1; yy += step) {
    for (let xx = x0; xx < x1; xx += step) {
      const i = (yy * iw + xx) * 4;
      const r = data.data[i], g = data.data[i + 1], b = data.data[i + 2];
      if ((r >> 3) === tr && (g >> 3) === tg && (b >> 3) === tb) { sr += r; sg += g; sb += b; c++; }
    }
  }
  if (!c) return [tr * 8 + 4, tg * 8 + 4, tb * 8 + 4];
  return [Math.round(sr / c), Math.round(sg / c), Math.round(sb / c)];
}

/** 依据背景色挑选高对比、又不突兀的文字色 */
function pickTextColor(bg) {
  const L = luminance(bg[0], bg[1], bg[2]);
  let color;
  if (L > 0.55) {
    color = mix(bg, [8, 10, 14], 0.9);          // 深色文字，保留背景色相
  } else if (L < 0.18) {
    color = mix(bg, [255, 255, 255], 0.93);
  } else {
    color = mix(bg, [255, 255, 255], 0.9);
  }
  // 保底：对比度不足时继续推向黑/白
  let l1 = luminance(color[0], color[1], color[2]);
  let ratio = contrastRatio(l1, L);
  let push = 0;
  const target = L > 0.45 ? [0, 0, 0] : [255, 255, 255];
  while (ratio < 5.2 && push < 1) {
    push += 0.12;
    color = mix(color, target, 0.35);
    l1 = luminance(color[0], color[1], color[2]);
    ratio = contrastRatio(l1, L);
  }
  return { color, lum: l1, ratio };
}

/* ---------------- 文本排版 ---------------- */
function tokenize(text) {
  const tokens = [];
  const re = /(\s+)|([\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3040-\u30ff])|([^\s\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u3040-\u30ff]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[0]);
  return tokens;
}

function wrapText(c, text, maxW) {
  const result = [];
  const paras = String(text).split(/\n/);
  for (const para of paras) {
    if (!para.trim()) continue;
    const tokens = tokenize(para);
    let line = '';
    for (const tk of tokens) {
      const cand = line + tk;
      if (c.measureText(cand).width <= maxW || line === '') {
        if (line === '' && c.measureText(tk).width > maxW) {
          // 单个超长 token 按字符硬切
          let chunk = '';
          for (const ch of tk) {
            if (c.measureText(chunk + ch).width > maxW && chunk) {
              result.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = cand;
        }
      } else {
        if (line.trim()) result.push(line.trimEnd());
        line = tk.trimStart();
      }
    }
    if (line.trim()) result.push(line.trimEnd());
  }
  return result;
}

function fontFor(text, size, weight) {
  return `${weight || 500} ${size}px ${FONT_STACK}`;
}

/** 在给定盒子内寻找最大可容纳字号 */
function fitBlock(text, availW, availH, maxSize, weight) {
  let size = Math.max(6, Math.min(maxSize, availH * 0.94));
  const minSize = Math.max(6, Math.min(9, size * 0.6));
  for (; size >= minSize; size -= 0.5) {
    ctx.font = fontFor(text, size, weight);
    const lines = wrapText(ctx, text, availW);
    if (!lines.length) return { size, lines: [], lh: size * LINE_H };
    const lh = size * LINE_H;
    if (lines.length * lh <= availH + 0.8) return { size, lines, lh };
  }
  ctx.font = fontFor(text, minSize, weight);
  const lines = wrapText(ctx, text, availW);
  return { size: minSize, lines, lh: minSize * LINE_H };
}

/** 计算某个块可用的排版空间（避免压到相邻块） */
function computeSpace(b, index, blocks, W, H) {
  const nLines = Math.max(1, b.nLines || 1);
  const origLineH = b.h / nLines;
  const padX = Math.max(1, Math.min(3, nLines > 1 ? 2 : b.h * 0.08));
  // 译文永远不应该比原文更大，取原文单行字高的 0.86 作为上限
  const maxSize = Math.max(7.5, Math.min(52 * uiScale, origLineH * 0.86));

  // 右侧可扩展宽度
  let maxW = Math.min(W - b.x - padX, Math.max(b.w * 1.02, b.w + origLineH * 2.2));
  for (let j = 0; j < blocks.length; j++) {
    if (j === index) continue;
    const o = blocks[j];
    const vOverlap = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y);
    if (vOverlap > Math.min(b.h, o.h) * 0.5 && o.x > b.x + b.w - 6) {
      maxW = Math.min(maxW, o.x - b.x - padX - 2);
    }
  }
  maxW = Math.max(Math.min(b.w, 40), maxW);

  // 向下可扩展高度
  let limit = H - b.y - 2;
  for (let j = 0; j < blocks.length; j++) {
    if (j === index) continue;
    const o = blocks[j];
    if (o.y > b.y + 1 && o.y < limit + b.y) {
      const wOverlap = Math.min(b.x + maxW, o.x + o.w) - Math.max(b.x, o.x);
      if (wOverlap > 2) limit = Math.min(limit, o.y - b.y - 2);
    }
  }
  const maxH = Math.max(b.h, Math.min(limit, b.h * 1.9));
  return { padX, availW: Math.max(16, maxW), availH: maxH, origLineH, maxSize };
}

/* ---------------- 绘制 ---------------- */
function roundedPath(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, rr);
  else {
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }
}

function buildBlurred() {
  blurred = document.createElement('canvas');
  blurred.width = canvas.width;
  blurred.height = canvas.height;
  const bc = blurred.getContext('2d');
  const r = Math.max(3, Math.round(9 * uiScale));
  bc.filter = `blur(${r}px) saturate(0.85)`;
  bc.drawImage(img, 0, 0, canvas.width, canvas.height);
  bc.filter = 'none';
}

function drawPill(text, opts = {}) {
  const fs = Math.round(13 * uiScale);
  ctx.font = `500 ${fs}px ${FONT_STACK}`;
  const tw = ctx.measureText(text).width;
  const padX = 14 * uiScale, h = 30 * uiScale;
  const w = tw + padX * 2;
  const x = (canvas.width - w) / 2;
  const y = opts.y != null ? opts.y : 12 * uiScale;

  roundedPath(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(14,17,23,0.90)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = Math.max(1, uiScale);
  ctx.stroke();

  ctx.fillStyle = opts.color || '#dbe3f2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, y + h / 2 + 0.5 * uiScale);
  ctx.textAlign = 'left';
}

function draw() {
  if (!img || !state) return;
  const W = canvas.width, H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);

  if (state.showOriginal) return;
  if (state.status === 'ocr') { drawPill('识别中…'); return; }
  if (state.status === 'translating') { drawPill('翻译中…'); return; }
  if (state.status === 'empty') { drawPill('未识别到文字'); return; }
  if (state.status === 'error') { drawPill('翻译失败：' + (state.error || '未知错误'), { color: '#ffb4b4' }); return; }
  if (state.status !== 'ready') return;

  const blocks = (state.blocks || []).filter((b) => b && (b.dst || b.text));
  if (!blocks.length) { drawPill('未识别到文字'); return; }

  if (!blurred) buildBlurred();

  if (!imgData) {
    try { imgData = ctx.getImageData(0, 0, W, H); } catch { imgData = null; }
  }
  if (!imgData) { drawPill('无法读取截图像素'); return; }

  const order = blocks.map((b, i) => i).sort((a, b2) => blocks[a].y - blocks[b2].y || blocks[a].x - blocks[b2].x);

  for (const idx of order) {
    const b = blocks[idx];
    // 翻译为空时回填原文，避免出现"一部分替换、一部分仍是原文"的割裂感
    const dstText = (b.dst && b.dst.trim()) ? b.dst : b.text;
    const space = computeSpace(b, idx, blocks, W, H);
    const bg = estimateBackground(imgData, b.x - 1, b.y - 1, Math.min(space.availW, W - b.x) + 2, b.h + 2);
    const tc = pickTextColor(bg);

    // 对照模式：原文以更小字号放在译文上方
    let origText = null;
    let origSize = 0;
    let origH = 0;
    if (state.compare) {
      origSize = Math.max(7, Math.min(b.h * 0.5, space.maxSize * 0.52));
      ctx.font = fontFor(b.text, origSize, 400);
      origText = wrapText(ctx, b.text, space.availW);
      origH = Math.min(origText.length, 1) * origSize * 1.3;
    }

    const availH = Math.max(6, space.availH - origH);
    const fit = fitBlock(dstText, space.availW, availH, space.maxSize, 500);
    if (!fit.lines.length) continue;

    // 遮罩必须同时盖住原文宽度与译文宽度，否则会露出残留字形
    let maxLineW = 0;
    ctx.font = fontFor(dstText, fit.size, 500);
    for (const ln of fit.lines) maxLineW = Math.max(maxLineW, ctx.measureText(ln).width);

    const padY = Math.max(1, Math.min(3, b.h * 0.07));
    const boxX = Math.max(0, b.x - space.padX);
    const boxW = Math.min(Math.max(b.w, maxLineW) + space.padX * 2, W - boxX);
    const textH = fit.lines.length * fit.lh;
    const contentH = textH + origH;

    // 贴近画面底部的块：空间不够时整体上移，避免最后一行被画布裁掉
    const needH = Math.max(contentH + padY * 2, b.h + padY * 2);
    let boxY = Math.max(0, b.y - padY);
    if (boxY + needH > H) {
      const prevBottom = (() => {
        let v = 0;
        for (let j = 0; j < blocks.length; j++) {
          if (j === idx) continue;
          const o = blocks[j];
          if (o.y + o.h <= b.y + 1) v = Math.max(v, o.y + o.h);
        }
        return v + 2;
      })();
      boxY = Math.max(prevBottom, Math.min(boxY, H - needH));
    }
    const boxH = Math.min(needH, H - boxY);

    const centerDiff = Math.abs((b.x + b.w / 2) - W / 2);
    const alignCenter = centerDiff < W * 0.055;
    const textX = alignCenter ? boxX + boxW / 2 : boxX + space.padX;

    // 1) 糊化：裁切 + 模糊底图 + 背景色覆盖
    ctx.save();
    roundedPath(ctx, boxX, boxY, boxW, boxH, Math.min(4 * uiScale, b.h * 0.25));
    ctx.clip();
    ctx.drawImage(blurred, 0, 0, W, H);
    ctx.fillStyle = rgbStr(bg, 0.975);
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.restore();

    // 2) 文字
    let cursorY = boxY + padY + Math.max(0, (boxH - padY * 2 - contentH) / 2);
    ctx.save();
    roundedPath(ctx, boxX, boxY, boxW, boxH, 3);
    ctx.clip();
    ctx.textAlign = alignCenter ? 'center' : 'left';
    ctx.textBaseline = 'middle';

    if (origText) {
      ctx.font = fontFor(b.text, origSize, 400);
      ctx.fillStyle = rgbStr(tc.color, 0.6);
      ctx.fillText(origText[0], textX, cursorY + origSize * 0.65);
      cursorY += origH;
    }

    ctx.font = fontFor(dstText, fit.size, 500);
    ctx.fillStyle = rgbStr(tc.color, 1);
    ctx.shadowColor = 'rgba(0,0,0,0.16)';
    ctx.shadowBlur = 1.5 * uiScale;
    for (let i = 0; i < fit.lines.length; i++) {
      ctx.fillText(fit.lines[i], textX, cursorY + fit.lh / 2 + fit.size * 0.04);
      cursorY += fit.lh;
    }
    ctx.restore();
  }
}

/* ---------------- 数据接入 ---------------- */
function setState(s) {
  if (!s) return;
  const imageKey = String(s.imageDataUrl || '').length + ':' + s.pxW + 'x' + s.pxH;
  const needNewImage = imageKey !== lastImageKey;

  state = s;
  uiScale = (s.pxW && s.rect && s.rect.width) ? s.pxW / s.rect.width : (window.devicePixelRatio || 1);

  if (!needNewImage && img) { draw(); return; }

  lastImageKey = imageKey;
  const im = new Image();
  im.onload = () => {
    img = im;
    canvas.width = im.naturalWidth || s.pxW;
    canvas.height = im.naturalHeight || s.pxH;
    imgData = null;
    blurred = null;
    draw();
  };
  im.src = s.imageDataUrl;
}

window.etResult.init().then((s) => { if (s) setState(s); }).catch(() => { });
window.etResult.onData(setState);

window.etResult.onExport(() => {
  let out = '';
  try { out = canvas.toDataURL('image/png'); } catch { out = ''; }
  window.etResult.sendExport(out);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.etResult.close();
});
