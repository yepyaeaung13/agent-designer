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
        document.querySelector('.figma-reference-bar button').click();
        await waitFor(() => document.querySelector('.reference-image img')?.naturalWidth > 0, 'Saved preview failed to decode');
        document.querySelector('[aria-label="Close reference"]').click();
        [...document.querySelectorAll('.layer-row')].find(row => row.textContent.includes('Heading')).click();
        await waitFor(() => [...document.querySelectorAll('.inspector label')].some(label => label.textContent.includes('Font family')), 'Typography controls missing');
        const field = name => [...document.querySelectorAll('.inspector label')].find(label => label.textContent.trim() === name)?.querySelector('input');
        if (field('Font family').value !== 'Arial' || field('Font weight').value !== '600' || field('Line height (px)').value !== '36') throw new Error('Imported typography not displayed');
        for (const [name, value, key] of [['Font family', 'Georgia', 'fontFamily'], ['Font weight', '700', 'fontWeight'], ['Line height (px)', '44', 'lineHeight'], ['Letter spacing (px)', '2', 'letterSpacing']]) {
          const input = field(name); setValue(input, value); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
          await waitFor(async () => String((await window.designer.read()).document.pages[0].nodes.find(node => node.name === 'Heading')[key]) === value, name + ' did not save');
        }
        document.querySelectorAll('.figma-reference-bar button')[1].click();
        await waitFor(() => document.querySelectorAll('.figma-reference-bar button')[1].textContent.includes('copied'), 'Coding prompt did not copy');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { importUI: true, cancelUnchanged: true, layers: 6, previewDecoded: true, codingPrompt: true, typographySaved: true };
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
        path.join(directory, 'typography.png'),
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
