'use strict';
/**
 * Windows 原生 OCR 常驻进程封装。
 * 底层是 scripts/ocr-worker.ps1（Windows.Media.Ocr），保持常驻以复用已加载的识别引擎。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

class OcrWorker {
  constructor(scriptPath) {
    this.scriptPath = scriptPath;
    this.proc = null;
    this.rl = null;
    this.ready = false;
    this.starting = null;
    this.seq = 0;
    this.pending = new Map();
    this.readyInfo = null;
  }

  get isAlive() {
    return !!(this.proc && !this.proc.killed && this.ready);
  }

  async start() {
    if (this.isAlive) return this.readyInfo;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; this._kill(); reject(new Error('OCR 引擎启动超时')); }
      }, 20000);

      const proc = spawn(PS_EXE, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath
      ], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });

      this.proc = proc;
      let stderr = '';

      this.rl = readline.createInterface({ input: proc.stdout });
      this.rl.on('line', (line) => this._onLine(line, (info) => {
        if (!settled) { settled = true; clearTimeout(timer); this.ready = true; this.readyInfo = info; resolve(info); }
      }));

      proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

      proc.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });

      proc.on('exit', (code) => {
        this.ready = false;
        this.proc = null;
        this.starting = null;
        for (const [, p] of this.pending) p.reject(new Error('OCR 进程已退出 (' + code + ') ' + stderr.slice(-300)));
        this.pending.clear();
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('OCR 进程启动失败: ' + stderr.slice(-400))); }
      });
    });

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  _onLine(line, onReady) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.ready) { if (onReady) onReady(msg); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'OCR 失败'));
  }

  _kill() {
    try { if (this.proc) this.proc.kill(); } catch { }
    this.proc = null;
    this.ready = false;
  }

  async recognize(imagePath, { lang = 'auto', upscale = 2, timeout = 30000 } = {}) {
    if (!this.isAlive) await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OCR 识别超时'));
      }, timeout);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      const payload = JSON.stringify({ id, path: imagePath, lang, upscale });
      try {
        this.proc.stdin.write(payload + '\n', 'utf8');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  dispose() {
    try { if (this.proc) this.proc.stdin.write('quit\n'); } catch { }
    setTimeout(() => this._kill(), 300);
  }
}

module.exports = { OcrWorker, PS_EXE };
