const { app, clipboard, net } = require('electron');
const previousClipboard = clipboard.readText();
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { fakeFetch } = require('../tests/fixtures/figma.cjs');
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
        document.querySelector('.import-button').click();
        await waitFor(() => document.querySelector('.import-dialog[open]'), 'Import dialog did not open');
        setValue(document.querySelector('.import-dialog input[type=url]'), 'https://www.figma.com/design/fixture/Example?node-id=10-20');
        setValue(document.querySelector('.import-dialog input[type=password]'), 'fixture-token');
        await new Promise(resolve => setTimeout(resolve,50));
        document.querySelector('.import-dialog form').requestSubmit();
        await waitFor(() => !document.querySelector('.import-dialog[open]'), 'Import dialog did not close');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 6, 'Imported layers did not render');
        if (document.querySelector('.import-dialog input[type=password]').value !== '') throw new Error('Token remains in form');
        const snapshot = await window.designer.read();
        if (snapshot.documents.length !== 2 || snapshot.document.source.kind !== 'figma') throw new Error('Import did not create a new document');
        document.querySelector('.figma-reference-bar button').click();
        await waitFor(() => document.querySelector('.reference-image img')?.naturalWidth > 0, 'Saved preview failed to decode');
        document.querySelector('[aria-label="Close reference"]').click();
        document.querySelectorAll('.figma-reference-bar button')[1].click();
        await waitFor(() => document.querySelectorAll('.figma-reference-bar button')[1].textContent.includes('copied'), 'Coding prompt did not copy');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { importUI: true, tokenCleared: true, layers: 6, previewDecoded: true, codingPrompt: true };
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
        path.join(directory, 'figma-import.png'),
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
require('../.vite/build/main.cjs');
