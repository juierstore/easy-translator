'use strict';

/** 判断字符是否属于 CJK（用于决定拼接时是否加空格） */
function isCjk(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x3040 && c <= 0x30ff) || (c >= 0x20000 && c <= 0x2a6df);
}

function overlap1d(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/**
 * 把 OCR 行合并成段落块：
 *  - 水平投影重叠足够大
 *  - 行高接近
 *  - 行间距紧凑
 */
function groupLines(lines) {
  const src = (lines || [])
    .filter((l) => l && l.text && String(l.text).trim().length > 0 && l.h > 0)
    .map((l) => ({
      text: String(l.text),
      x: Number(l.x) || 0,
      y: Number(l.y) || 0,
      w: Number(l.w) || 0,
      h: Number(l.h) || 0
    }))
    .sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) * 0.5 ? a.y - b.y : a.x - b.x));

  const blocks = [];
  for (const line of src) {
    const prev = blocks[blocks.length - 1];
    let merged = false;

    if (prev) {
      const last = prev.lines[prev.lines.length - 1];
      const vGap = line.y - (last.y + last.h);
      const hOverlap = overlap1d(prev.x, prev.x + prev.w, line.x, line.x + line.w);
      const minW = Math.min(prev.w, line.w) || 1;
      const hRatio = hOverlap / minW;
      const hDiff = Math.abs(line.h - last.h) / Math.max(line.h, last.h, 1);

      if (vGap >= -last.h * 0.5 && vGap < Math.min(last.h, line.h) * 0.62 &&
        hRatio > 0.6 && hDiff < 0.18) {
        // 判定为同一段落的续行
        const a = last.text.slice(-1);
        const b = line.text.slice(0, 1);
        const sep = (isCjk(a) && isCjk(b)) ? '' : ' ';
        prev.text += sep + line.text;
        prev.lines.push(line);
        const x1 = Math.min(prev.x, line.x);
        const y1 = Math.min(prev.y, line.y);
        const x2 = Math.max(prev.x + prev.w, line.x + line.w);
        const y2 = Math.max(prev.y + prev.h, line.y + line.h);
        prev.x = x1; prev.y = y1; prev.w = x2 - x1; prev.h = y2 - y1;
        merged = true;
      }
    }

    if (!merged) {
      blocks.push({ text: line.text, x: line.x, y: line.y, w: line.w, h: line.h, lines: [line] });
    }
  }
  return blocks;
}

module.exports = { groupLines, isCjk };
