const { app, clipboard, net, dialog } = require('electron');
const previousClipboard = clipboard.readText();
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
  fakeFetch,
  root,
  response,
  png,
} = require('../tests/fixtures/figma.cjs');
globalThis.fetch = fakeFetch;
net.fetch = fakeFetch;
app.setPath(
  'userData',
  mkdtempSync(path.join(tmpdir(), 'designer-import-smoke-')),
);
const timeout = setTimeout(() => {
  console.error('Import smoke test timed out');
  app.exit(1);
}, 40000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') console.error(details.message);
  });
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate, message) => { for (let i=0;i<100;i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,50)); } throw new Error(message || 'UI condition timed out'); };
        const setValue = (input, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); };
        await waitFor(() => document.querySelectorAll('.layer-row').length === 4, 'Initial editor did not load');
        const before = await window.designer.read();
        await window.designer.importBundle();
        const cancelled = await window.designer.read();
        if (before.document.id !== cancelled.document.id || before.documents.length !== cancelled.documents.length) throw new Error('Cancel changed workspace');
        [...document.querySelectorAll('button')].find(button => button.textContent === 'Import export file').click();
        await waitFor(() => document.querySelectorAll('.layer-row').length === 6, 'Imported layers did not render');        const snapshot = await window.designer.read();
        if (snapshot.documents.length !== 2 || snapshot.document.source.kind !== 'figma') throw new Error('Import did not create a new document');
        const viewport = document.querySelector('.canvas-viewport');
        const canvas = viewport.querySelector('canvas');
        const box = canvas.getBoundingClientRect();
        const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await frame();
        const beforePan = canvas.toDataURL();
        canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: box.x + 150, clientY: box.y + 150 }));
        if (!viewport.classList.contains('right-panning')) throw new Error('Right drag did not start');
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 2, clientX: box.x + 240, clientY: box.y + 210 }));
        await frame();
        if (canvas.toDataURL() === beforePan) throw new Error('Canvas did not pan');
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
        if (viewport.classList.contains('right-panning')) throw new Error('Pan did not stop');
        const afterPan = canvas.toDataURL();
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0, clientX: 1, clientY: 1 }));
        await frame();
        if (canvas.toDataURL() !== afterPan) throw new Error('Canvas moved after release');
        canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, buttons: 2 }));
        window.dispatchEvent(new Event('blur'));
        if (viewport.classList.contains('right-panning')) throw new Error('Pan stuck after blur');
        const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        canvas.dispatchEvent(menu);
        if (!menu.defaultPrevented) throw new Error('Context menu not suppressed');
        if (JSON.stringify((await window.designer.read()).document) !== JSON.stringify(snapshot.document)) throw new Error('Panning changed document');
        document.querySelector('.figma-reference-bar button').click();
        await waitFor(() => document.querySelector('.reference-image img')?.naturalWidth > 0, 'Saved preview failed to decode');
        document.querySelector('[aria-label="Close reference"]').click();
        document.querySelectorAll('.figma-reference-bar button')[1].click();
        await waitFor(() => document.querySelectorAll('.figma-reference-bar button')[1].textContent.includes('copied'), 'Coding prompt did not copy');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { rightDragPans: true, releaseStops: true, blurStops: true, documentUnchanged: true };
      })()`);
      const prompt = await clipboard.readText();
      if (
        !prompt.includes('expectedRevision') ||
        !prompt.includes('get_asset') ||
        prompt.includes('fixture-token')
      )
        throw new Error('Invalid coding handoff prompt');
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'bundle-import.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log('Figma import smoke test:', JSON.stringify(result));
      clearTimeout(timeout);
      await clipboard.writeText(await previousClipboard);
      app.quit();
    } catch (error) {
      console.error(
        'Visible UI:',
        await window.webContents.executeJavaScript('document.body.innerText'),
      );
      console.error(error);
      await clipboard.writeText(await previousClipboard);
      app.exit(1);
    }
  });
});
const bundlePath = path.join(
  app.getPath('userData'),
  'fixture.agentdesign.json',
);
writeFileSync(
  bundlePath,
  JSON.stringify({
    format: 'agent-designer.figma-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    fileKey: 'fixture',
    entry: response.nodes[root.id],
    preview: 'png',
    renders: { '10:24': 'png', '10:25': 'png' },
    images: { 'fixture-photo': 'png' },
    warnings: [],
    assets: [
      { key: 'png', mimeType: 'image/png', base64: png.toString('base64') },
    ],
  }),
);
let picked = false;
dialog.showOpenDialog = async () => {
  if (!picked) {
    picked = true;
    return { canceled: true, filePaths: [] };
  }
  return { canceled: false, filePaths: [bundlePath] };
};
require('../.vite/build/main.cjs');
