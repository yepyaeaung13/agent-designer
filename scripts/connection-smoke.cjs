const { app } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const folder = process.argv
  .find((a) => a.startsWith('--connection-fixture='))
  ?.split('=')
  .slice(1)
  .join('=');
if (!folder) throw Error('An isolated fixture directory is required.');
app.setPath('userData', folder);
const timer = setTimeout(() => app.exit(1), 30000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    try {
      const receiptFile = path.join(folder, 'connection-receipt.json');
      let current = await window.webContents.executeJavaScript(
        'window.designer.connection()',
      );
      assert(current.url, current.error);
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      const reopened = fs.existsSync(receiptFile);
      if (reopened) {
        const prior = JSON.parse(fs.readFileSync(receiptFile));
        assert.equal(current.url, prior.url);
        assert.equal(hash(current.token), prior.tokenHash);
      }
      const old = current;
      if (process.argv.includes('--reset-connection')) {
        await window.webContents.executeJavaScript(`(async()=>{
      [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Connect agent').click();
      for(let i=0;i<100;i++){const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Reset connection');if(b){b.click();break;}await new Promise(r=>setTimeout(r,20));}
      for(let i=0;i<100;i++){if((await window.designer.connection()).token!==${JSON.stringify(old.token)})return;await new Promise(r=>setTimeout(r,20));}throw Error('Reset did not complete');
    })()`);
        current = await window.webContents.executeJavaScript(
          'window.designer.connection()',
        );
        assert.equal(current.url, old.url);
        assert.notEqual(current.token, old.token);
        const rejected = await fetch(old.url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + old.token,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        assert.equal(rejected.status, 401);
      }
      const saved = fs.readFileSync(
        path.join(folder, 'mcp-connection.json'),
        'utf8',
      );
      assert(!saved.includes(current.token));
      fs.writeFileSync(
        receiptFile,
        JSON.stringify({ url: current.url, tokenHash: hash(current.token) }),
      );
      console.log(
        JSON.stringify({
          stableRestart: reopened,
          encryptedStorage: true,
          reset: process.argv.includes('--reset-connection'),
        }),
      );
      clearTimeout(timer);
      app.quit();
    } catch (error) {
      console.error(error.message);
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
