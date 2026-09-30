const { app } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
app.setPath(
  'userData',
  mkdtempSync(path.join(tmpdir(), 'designer-pages-smoke-')),
);
const timeout = setTimeout(() => {
  console.error('Workspace smoke test timed out');
  app.exit(1);
}, 40000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') console.error(details.message);
  });
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async (predicate, message) => { for (let i=0; i<100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(message || 'UI condition timed out'); };
        const idle = () => waitFor(() => document.querySelector('.statusbar')?.textContent.includes('All changes saved'));
        const click = async (selector) => { await idle(); const button = document.querySelector(selector); if (!button || button.disabled) throw new Error('Button unavailable: '+selector); button.click(); };
        const fill = async (name) => { await waitFor(() => document.querySelector('.name-dialog[open] input')); const input = document.querySelector('.name-dialog[open] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); document.querySelector('.name-dialog[open] form').requestSubmit(); await waitFor(() => !document.querySelector('.name-dialog[open]'), 'Form did not close'); await idle(); };
        await waitFor(() => document.querySelectorAll('.layer-row').length === 4);
        if (typeof window.require !== 'undefined') throw new Error('Renderer has Node access');
        const first = await window.designer.read();
        await click('[aria-label="Add rectangle"]');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 5);
        await click('[title="Undo (Ctrl+Z)"]');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 4);
        await click('[aria-label="New page"]'); await fill('Mobile');
        await waitFor(() => document.querySelectorAll('.page-item').length === 2 && document.querySelectorAll('.layer-row').length === 0);
        await click('[aria-label="Add ellipse"]');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 1);
        await click('[aria-label="Rename page"]'); await fill('Mobile layout');
        await waitFor(() => document.querySelector('.page-item.active').textContent.includes('Mobile layout'));
        await click('[aria-label="Delete page"]');
        await waitFor(() => document.querySelector('.name-dialog[open]'));
        document.querySelector('.name-dialog[open] button[type="submit"]').click();
        await waitFor(() => document.querySelectorAll('.page-item').length === 1 && document.querySelectorAll('.layer-row').length === 4);
        await click('[title="Undo (Ctrl+Z)"]');
        await waitFor(() => document.querySelectorAll('.page-item').length === 2);
        await click('[aria-label="Open documents"]');
        await waitFor(() => document.querySelector('.library-dialog[open]'));
        await click('.library-dialog[open] [aria-label="New document"]'); await fill('Product explorations');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 0 && document.querySelector('.document-switcher').textContent.includes('Product explorations'));
        const second = await window.designer.read();
        if (second.document.id === first.document.id || second.canUndo) throw new Error('Document isolation failed');
        await click('[aria-label="Add text"]');
        await waitFor(() => document.querySelectorAll('.layer-row').length === 1);
        await click('[aria-label="Open documents"]');
        await waitFor(() => document.querySelector('.library-dialog[open]'));
        await click('.library-dialog[open] [aria-label="Rename document"]'); await fill('Brand explorations');
        await waitFor(() => document.querySelector('.document-switcher').textContent.includes('Brand explorations'));
        await click('.library-dialog[open] [aria-label="Delete document"]');
        await waitFor(() => document.querySelector('.name-dialog[open]'));
        document.querySelector('.name-dialog[open] button[type="submit"]').click();
        await waitFor(() => document.querySelectorAll('.layer-row').length === 4 && !document.querySelector('.library-dialog[open]'));
        const final = await window.designer.read();
        if (final.document.id !== first.document.id || final.documents.length !== 1 || final.document.pages.length !== 2) throw new Error('Document deletion/switch failed');
        if (JSON.stringify(final.document.pages[0].nodes) !== JSON.stringify(first.document.pages[0].nodes)) throw new Error('Original page changed');
        if (final.document.pages[1].nodes.length !== 1) throw new Error('Page undo lost a layer');
        await waitFor(() => document.querySelectorAll('.page-item').length === 2, 'Restored pages not rendered');
        await idle();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!document.querySelector('canvas')) throw new Error('Canvas missing');
        return { pages: 2, documentCRUD: true, pageCRUD: true, isolatedUndo: true, originalPageUnchanged: true };
      })()`);
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'workspace.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log('Workspace smoke test:', JSON.stringify(result));
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
});
require('../.vite/build/main.cjs');
