const { app } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
app.setPath(
  'userData',
  mkdtempSync(path.join(require('node:os').tmpdir(), 'theme-check-')),
);
setTimeout(() => app.exit(1), 30000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      await window.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (document.documentElement.dataset.theme !== 'dark') throw new Error('Default theme is not dark');
      if (getComputedStyle(document.querySelector('.topbar')).backgroundColor !== 'rgb(32, 33, 39)') throw new Error('Header theme missing');
      document.querySelector('.theme-toggle').click();
      if (localStorage.getItem('designer-theme') !== 'light') throw new Error('Theme not saved');
    })()`);
      await new Promise((resolve) => {
        window.webContents.once('did-finish-load', resolve);
        window.webContents.reload();
      });
      await window.webContents.executeJavaScript(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (document.documentElement.dataset.theme !== 'light') throw new Error('Theme not restored');
      document.querySelector('.theme-toggle').click();
      document.querySelector('.import-button').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      if (getComputedStyle(document.querySelector('.import-dialog')).backgroundColor !== 'rgb(32, 33, 39)') throw new Error('Dialog theme missing');
      document.querySelector('.import-dialog').close();
      document.querySelector('.layer-row').click();
      await new Promise(resolve => setTimeout(resolve, 100));
    })()`);
      window.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'dark-theme.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log('Dark theme, dialog, toggle and saved preference verified.');
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
