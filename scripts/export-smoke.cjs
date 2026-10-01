const { app, dialog, net, nativeImage } = require('electron');
const { mkdtempSync, readFileSync } = require('node:fs');
const path = require('node:path');
const folder = mkdtempSync(
  path.join(require('node:os').tmpdir(), 'export-check-'),
);
app.setPath('userData', folder);
net.fetch = require('../tests/fixtures/figma.cjs').fakeFetch;
const files = [];
let cancel = false;
dialog.showSaveDialog = async (_window, options) => {
  if (cancel) return { canceled: true };
  const format = options.filters[0].extensions[0];
  const filePath = path.join(folder, `export-${files.length}.${format}`);
  files.push(filePath);
  return { canceled: false, filePath };
};
setTimeout(() => app.exit(1), 40000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      window.showInactive();
      await window.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      await pause(500);
      await window.designer.importFigma({ url: 'https://www.figma.com/design/fixture/Example?node-id=10-20', token: 'fixture-token' });
      await pause(700);
      [...document.querySelectorAll('.layer-row')].find(row => row.textContent.trim().endsWith('Contact fixture')).click();
      await pause(150);
      const beforeExport = (await window.designer.read()).document;
      document.querySelector('[aria-label="Zoom out"]').click();
      for (const format of ['png', 'svg']) {
        for (const scale of [1, 2, 3, 4]) {
          const controls = document.querySelector('.layer-export');
          const select = (index, value) => { const input = controls.querySelectorAll('select')[index]; input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
          select(1, format); select(0, String(scale)); await pause(80);
          controls.querySelector('button').click();
          for (let i=0;i<100;i++) { await pause(50); if (!controls.querySelector('button').disabled && controls.textContent.includes('Export saved.')) break; }
          if (!controls.textContent.includes('Export saved.')) throw new Error(controls.textContent);
        }
      }
      if (JSON.stringify((await window.designer.read()).document) !== JSON.stringify(beforeExport)) throw new Error('Export modified the design');
    })()`);
      for (let i = 0; i < 4; i++) {
        const bitmap = nativeImage.createFromPath(files[i]);
        const size = bitmap.getSize();
        const pixels = bitmap.toBitmap();
        let imagePixel = false;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          if (
            pixels[offset] < 60 &&
            pixels[offset + 1] < 60 &&
            pixels[offset + 2] > 200 &&
            pixels[offset + 3] > 0
          ) {
            imagePixel = true;
            break;
          }
        }
        if (!imagePixel)
          throw new Error('PNG lost the red fixture image asset');
        if (size.width !== 600 * (i + 1) || size.height !== 400 * (i + 1))
          throw new Error(`Wrong PNG dimensions ${JSON.stringify(size)}`);
        const svg = readFileSync(files[i + 4], 'utf8');
        if (
          !svg.includes(`width="${600 * (i + 1)}" height="${400 * (i + 1)}"`) ||
          !svg.includes('<text ') ||
          !svg.includes('<rect ') ||
          !svg.includes('data:image/png;base64,')
        )
          throw new Error('SVG lost native shapes, text or embedded assets');
        const parsed = await window.webContents.executeJavaScript(
          `new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml').querySelector('parsererror') === null`,
        );
        if (!parsed) throw new Error('Invalid SVG XML');
      }
      cancel = true;
      const saved = await window.webContents.executeJavaScript(
        `window.designer.saveExport({ name: 'cancel', format: 'svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' })`,
      );
      if (saved !== false || files.length !== 8)
        throw new Error('Save cancellation failed');
      console.log(
        'PNG and SVG at 1x, 2x, 3x, 4x, assets, vector elements, XML and cancellation verified.',
      );
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
