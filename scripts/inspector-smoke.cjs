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
      await pause(1000); const child = snapshot.document.pages[0].nodes.find(node => node.name === 'Regional Depots');
      [...document.querySelectorAll('.layer-row')].find(row => row.textContent.trim().endsWith(child.name)).click();
      await pause(250);
      const summary = document.querySelector('.effect-summary');
      if (!summary.textContent.includes('Shadow on parent: Group 16') || !summary.textContent.includes('25%') || !summary.textContent.includes('Blur 25px')) throw new Error('Parent shadow values missing');
      [...summary.querySelectorAll('button')].find(button => button.textContent === 'Edit Group 16 shadow').click();
      await pause(400);
      const label = name => [...document.querySelectorAll('.inspector label')].find(item => item.textContent.trim() === name);
      if (label('Name').querySelector('input').value !== 'Group 16') throw new Error('Wrong shadow owner selected');
      if (label('Shadow blur (px)').querySelector('input').value !== '25' || label('Shadow opacity (%)').querySelector('input').value !== '25') throw new Error('Shadow fields missing imported values');
      return { parentShadowSummary: true, correctOwnerSelected: true, importedValuesDisplayed: true };    })()`);
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
