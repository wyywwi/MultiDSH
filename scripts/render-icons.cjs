// Render the provided dark/light MultiDSH SVG icons into PNG sizes + the ICO.
//
// Run with Electron (the repo already ships Electron for the desktop package):
//   packages\desktop\node_modules\electron\dist\electron.exe scripts\render-icons.cjs --no-sandbox
//
// Inputs:  assets/icon/dsh-dark.svg  (white whales, for dark backgrounds)
//          assets/icon/dsh-light.svg (dark whales, for light backgrounds)
// Outputs: assets/icon/icon-dark-<size>.png, icon-light-<size>.png,
//          assets/icon/icon-dark.png, icon-light.png
// The .ico is built by scripts/make-ico.py from icon-dark-256.png.
'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const HERE = path.resolve(__dirname, '..', 'assets', 'icon');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const VARIANTS = [
  { name: 'dark', file: 'dsh-dark.svg' },
  { name: 'light', file: 'dsh-light.svg' },
];

function svgDataUrl(file) {
  const svg = fs.readFileSync(path.join(HERE, file), 'utf8');
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function pageFor(dataUrl) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'img{display:block;width:1024px;height:1024px}</style></head>' +
    `<body><img id="icon" src="${dataUrl}"></body></html>`
  );
}

async function renderVariant(win, variant) {
  const html = pageFor(svgDataUrl(variant.file));
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Wait until the embedded image is decoded.
  for (let i = 0; i < 50; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      '(() => { const img = document.getElementById("icon"); return Boolean(img && img.complete && img.naturalWidth > 0); })()',
      true,
    );
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 400));
  const shot = await win.webContents.capturePage();
  const png = shot.toPNG();
  const base = nativeImage.createFromBuffer(png);
  const actual = base.getSize();
  if (actual.width !== 1024 || actual.height !== 1024) {
    console.log(`[render-icons] note: capture is ${actual.width}x${actual.height}, resizing from it`);
  }
  for (const size of SIZES) {
    const resized = base.resize({ width: size, height: size, quality: 'best' });
    const out = path.join(HERE, `icon-${variant.name}-${size}.png`);
    fs.writeFileSync(out, resized.toPNG());
  }
  fs.writeFileSync(path.join(HERE, `icon-${variant.name}.png`), png);
  console.log(`[render-icons] ${variant.name}: ${SIZES.join(',')} + icon-${variant.name}.png`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  win.setContentSize(1024, 1024);
  try {
    for (const variant of VARIANTS) await renderVariant(win, variant);
    console.log('[render-icons] done');
    app.exit(0);
  } catch (err) {
    console.error('[render-icons] failed:', err);
    app.exit(1);
  }
});
