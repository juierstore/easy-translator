'use strict';
const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(ROOT, 'src', 'preload');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ICON = path.join(ROOT, 'assets', 'icon.png');

const overlayWindows = [];

function iconOption() {
  return fs.existsSync(ICON) ? ICON : undefined;
}

function baseWebPreferences(name) {
  return {
    preload: path.join(PRELOAD, `${name}-preload.js`),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    backgroundThrottling: false
  };
}

/** 全屏框选层（每个显示器一个） */
function createOverlayWindow(display) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: baseWebPreferences('overlay')
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'overlay', 'index.html'));
  overlayWindows.push(win);
  return win;
}

function destroyOverlays() {
  while (overlayWindows.length) {
    const w = overlayWindows.pop();
    try { if (!w.isDestroyed()) w.destroy(); } catch { }
  }
}

/** 结果层：与选区像素对齐，鼠标穿透 */
function createResultWindow(rect, display) {
  const win = new BrowserWindow({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(2, Math.round(rect.width)),
    height: Math.max(2, Math.round(rect.height)),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: baseWebPreferences('result')
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'result', 'index.html'));
  return win;
}

/** 选区旁的浮动工具条 */
function createToolbarWindow(width, height) {
  const win = new BrowserWindow({
    width: Math.round(width),
    height: Math.round(height),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: baseWebPreferences('toolbar')
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(RENDERER, 'toolbar', 'index.html'));
  return win;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 计算工具条位置：优先选区下方，放不下就放上方，并夹在工作区内 */
function placeToolbar(rect, size, workArea) {
  const gap = 10;
  let x = Math.round(rect.x + rect.width - size.width);
  let y = Math.round(rect.y + rect.height + gap);

  const bottomLimit = workArea.y + workArea.height - 6;
  const topLimit = workArea.y + 6;

  if (y + size.height > bottomLimit) {
    const above = Math.round(rect.y - size.height - gap);
    if (above >= topLimit) y = above;
    else y = clamp(y, topLimit, Math.max(topLimit, bottomLimit - size.height));
  }
  if (y < topLimit) y = topLimit;
  x = clamp(x, workArea.x + 6, Math.max(workArea.x + 6, workArea.x + workArea.width - size.width - 6));
  return { x, y };
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0d0f13',
    show: false,
    icon: iconOption(),
    webPreferences: baseWebPreferences('main')
  });
  win.loadFile(path.join(RENDERER, 'main', 'index.html'));
  return win;
}

module.exports = {
  ROOT, PRELOAD, RENDERER, ICON,
  createOverlayWindow, destroyOverlays, createResultWindow, createToolbarWindow,
  createMainWindow, placeToolbar, clamp
};
