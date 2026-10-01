const { app } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
app.setPath(
  'userData',
  mkdtempSync(path.join(require('node:os').tmpdir(), 'spacing-check-')),
);
setTimeout(() => app.exit(1), 30000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      window.showInactive();
      const result = await window.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      await pause(700);
      const before = await window.designer.read();
      const nodes = before.document.pages[0].nodes;
      const card = nodes.find(node => node.name === 'Idea card');
      const headline = nodes.find(node => node.name === 'Headline');
      [...document.querySelectorAll('.layer-row')].find(row => row.textContent.trim().endsWith('Headline')).click();
      await pause(100);
      const viewport = document.querySelector('.canvas-viewport');
      function position(node) { let x = node.x, y = node.y; while(node.parentId) { node = nodes.find(item => item.id === node.parentId); x += node.x; y += node.y; } return { x, y }; }
      function hover(zoom, altKey = true) {
        const rect = viewport.getBoundingClientRect(), pos = position(card);
        viewport.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, altKey, clientX: rect.x + (pos.x + card.width / 2) * zoom, clientY: rect.y + (pos.y + card.height / 2) * zoom }));
      }
      hover(1);
      await pause(150);
      let overlay = document.querySelector('.spacing-overlay');
      if (!overlay || !overlay.getAttribute('aria-label').includes('Idea card')) throw new Error('Alt-hover did not measure target');
      const values = [...overlay.querySelectorAll('text')].map(text => text.textContent);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
      await pause(80);
      if (document.querySelector('.spacing-overlay')) throw new Error('Guides remain after Alt release');
      document.querySelector('[aria-label="Zoom out"]').click();
      await pause(100);
      hover(0.9);
      await pause(100);
      overlay = document.querySelector('.spacing-overlay');
      if (!overlay || JSON.stringify([...overlay.querySelectorAll('text')].map(text => text.textContent)) !== JSON.stringify(values)) throw new Error('Measurements changed with zoom');
      window.dispatchEvent(new Event('blur'));
      await pause(80);
      if (document.querySelector('.spacing-overlay')) throw new Error('Guides remain after blur');
      if (JSON.stringify((await window.designer.read()).document) !== JSON.stringify(before.document)) throw new Error('Measurements edited the design');
      hover(0.9); await pause(100);
      return { altHover: true, stableZoom: true, releaseHides: true, blurHides: true, documentUnchanged: true, values };
    })()`);
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'spacing.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log(result);
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
