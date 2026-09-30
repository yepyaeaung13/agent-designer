const { app, dialog } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
app.setPath(
  'userData',
  mkdtempSync(path.join(require('node:os').tmpdir(), 'shadow-check-')),
);
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [path.join(app.getPath('downloads'), 'Map.agentdesign-1.json')],
});
setTimeout(() => app.exit(1), 30000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      await pause(500);
      let snapshot = await window.designer.importBundle();
      const shadows = snapshot.document.pages[0].nodes.filter(node => node.shadow?.enabled);
      if (shadows.length !== 3) throw new Error('Expected three imported group shadows');
      for (let i=0;i<4;i++) { document.querySelector('[aria-label="Zoom out"]').click(); await pause(50); }
      await pause(1500);
      const canvas = document.querySelector('.canvas-viewport canvas');
      const withShadows = canvas.toDataURL();
      for (const node of shadows) {
        [...document.querySelectorAll('.layer-row')].find(row => row.textContent.trim().endsWith(node.name)).click(); await pause(100); [...document.querySelectorAll('.inspector label')].find(label => label.textContent.trim() === 'Enable shadow').querySelector('input').click(); await pause(150);
      }
      await pause(500);
      if (canvas.toDataURL() === withShadows) throw new Error('Group shadows did not change any pixels');
      for (const node of shadows) {
        [...document.querySelectorAll('.layer-row')].find(row => row.textContent.trim().endsWith(node.name)).click(); await pause(100); [...document.querySelectorAll('.inspector label')].find(label => label.textContent.trim() === 'Enable shadow').querySelector('input').click(); await pause(150);
      }
      await pause(500);
      return { importedShadows: shadows.length, renderingChangesPixels: true };
    })()`);
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'map-shadows.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log(result);
      app.quit();
    } catch (error) {
      writeFileSync(
        path.join(__dirname, '..', '.artifacts', 'shadow-failure.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.error(error);
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
