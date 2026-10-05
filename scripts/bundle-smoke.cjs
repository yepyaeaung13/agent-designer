const { app, clipboard, net, dialog } = require('electron');
const previousClipboard = app.whenReady().then(() => clipboard.readText());
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { root, response, png } = require('../tests/fixtures/figma.cjs');
const externalRequests = [];
const denyExternal = async () => {
  externalRequests.push('fetch');
  throw new Error('External requests are disabled during plugin import.');
};
globalThis.fetch = denyExternal;
net.fetch = denyExternal;
app.setPath(
  'userData',
  mkdtempSync(path.join(tmpdir(), 'designer-import-smoke-')),
);
const timeout = setTimeout(() => {
  console.error('Import smoke test timed out');
  app.exit(1);
}, 60000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      externalRequests.push(new URL(details.url).origin);
      callback({ cancel: true });
    },
  );
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
        document.querySelector('.coding-handoff-bar button').click();
        await waitFor(() => document.querySelector('.coding-handoff-dialog[open]'), 'Coding handoff did not open');
        await waitFor(() => !document.querySelector('.coding-handoff-dialog .primary').disabled, 'Local handoff check did not finish');
        if (!document.querySelector('.handoff-readiness').textContent.includes('local images')) throw new Error('Local readiness summary missing');
        document.querySelector('.coding-handoff-dialog .primary').click();
        await waitFor(() => document.querySelector('.coding-handoff-dialog .primary').textContent.includes('copied'), 'Coding prompt did not copy');
        document.querySelector('.coding-handoff-dialog .modal-actions button').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        return { importUI: true, cancelUnchanged: true, layers: 6, previewDecoded: true, codingPrompt: true };
      })()`);
      const prompt = await clipboard.readText();
      if (
        !prompt.includes('expectedRevision') ||
        !prompt.includes('get_asset') ||
        !prompt.includes('Do not call the Figma API, Figma MCP') ||
        prompt.includes('fixture-token')
      )
        throw new Error('Invalid coding handoff prompt');
      if (externalRequests.length)
        throw new Error(
          'Plugin handoff attempted external requests: ' +
            JSON.stringify(externalRequests),
        );
      const directory = path.join(__dirname, '..', '.artifacts');
      mkdirSync(directory, { recursive: true });
      window.show();
      await window.webContents.executeJavaScript(`(async () => {
        document.querySelector('.coding-handoff-bar button').click();
        for (let i = 0; i < 100; i++) {
          if (!document.querySelector('.coding-handoff-dialog .primary').disabled) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Readiness screenshot did not settle');
      })()`);
      writeFileSync(
        path.join(directory, 'handoff-readiness.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      await window.webContents.executeJavaScript(
        `document.querySelector('.coding-handoff-dialog .modal-actions button').click()`,
      );
      const updatedBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
      updatedBundle.exportedAt = new Date().toISOString();
      updatedBundle.entry.document.children[0].characters =
        'Updated export heading';
      updatedBundle.entry.document.children[1].paddingLeft = 36;
      const section = structuredClone(root.children[1].children[0]);
      section.id = '10:99';
      section.name = 'Added section';
      section.characters = 'New export section';
      section.relativeTransform = [
        [1, 0, 32],
        [0, 1, 350],
      ];
      section.absoluteBoundingBox = { x: 332, y: 550, width: 500, height: 30 };
      section.characterStyleOverrides = [];
      section.styleOverrideTable = {};
      updatedBundle.entry.document.children.push(section);
      writeFileSync(bundlePath, JSON.stringify(updatedBundle));
      // Native modal dialogs need a visible compositor surface on this desktop.
      window.show();
      await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async predicate => { for (let i=0;i<100;i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,50)); } throw new Error('Export review did not open'); };
        let snapshot = await window.designer.read();
        const frame = snapshot.document.pages[0].nodes.find(node => node.source.nodeId === '10:20');
        const heading = snapshot.document.pages[0].nodes.find(node => node.source.nodeId === '10:21');
        for (const [id, patch] of [[heading.id, {text:'Local heading'}], [frame.id, {fill:'#e5f4eb'}]]) {
          snapshot = await window.designer.execute({documentId:snapshot.document.id, pageId:snapshot.activePageId, expectedRevision:snapshot.document.revision, command:{type:'update',id,patch}});
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        [...document.querySelectorAll('.figma-reference-bar button')].find(button => button.textContent === 'Update from export').click();
        await waitFor(() => document.querySelector('.export-update-dialog[open]'));
        if (document.querySelectorAll('.export-conflict').length !== 1) throw new Error('Expected one text conflict');
        if (document.querySelector('.export-conflict select').value !== 'local') throw new Error('Local conflict must be default');
      })()`);
      writeFileSync(
        path.join(directory, 'export-update-review.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      const updateResult = await window.webContents
        .executeJavaScript(`(async () => {
        const waitFor = async (predicate, message) => { for (let i=0;i<100;i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,50)); } throw new Error(message); };
        const snapshot = await window.designer.read();
        const headingId = snapshot.document.pages[0].nodes.find(node => node.source.nodeId === '10:21').id;
        const updateButton = () => [...document.querySelectorAll('.figma-reference-bar button')].find(button => button.textContent === 'Update from export');
        document.querySelector('.export-update-dialog .form-actions button').click();
        await waitFor(() => !document.querySelector('.export-update-dialog[open]'), 'Cancel did not close review');
        if ((await window.designer.read()).document.revision !== snapshot.document.revision) throw new Error('Cancel mutated document');
        updateButton().click();
        await waitFor(() => document.querySelector('.export-update-dialog[open]'), 'Review did not reopen');
        const select = document.querySelector('.export-conflict select');
        select.value = 'export'; select.dispatchEvent(new Event('change', {bubbles:true}));
        await new Promise(resolve => setTimeout(resolve, 100));
        document.querySelector('.export-update-dialog .primary').click();
        await waitFor(() => !document.querySelector('.export-update-dialog[open]'), 'Update did not apply');
        let current = await window.designer.read();
        if (current.document.id !== snapshot.document.id || current.documents.length !== 2 || current.activePageId !== snapshot.activePageId) throw new Error('Update changed document identity');
        const nodes = current.document.pages[0].nodes;
        if (nodes.find(node => node.id === headingId).text !== 'Updated export heading') throw new Error('Export text choice not applied');
        if (nodes.find(node => node.source.nodeId === '10:20').fill !== '#e5f4eb') throw new Error('Independent local edit was lost');
        if (nodes.find(node => node.source.nodeId === '10:22').layout.padding.left !== 36) throw new Error('Independent export edit was lost');
        if (!nodes.some(node => node.source.nodeId === '10:99')) throw new Error('New layer was not added');
        current = await window.designer.execute({documentId:current.document.id, expectedRevision:current.document.revision, command:{type:'undo'}});
        if (current.document.pages[0].nodes.find(node => node.id === headingId).text !== 'Local heading' || current.document.pages[0].nodes.length !== 6) throw new Error('Update undo failed');
        current = await window.designer.execute({documentId:current.document.id, expectedRevision:current.document.revision, command:{type:'redo'}});
        if (current.document.pages[0].nodes.length !== 7) throw new Error('Update redo failed');
        await new Promise(resolve => setTimeout(resolve, 100));
        updateButton().click();
        await waitFor(() => document.querySelector('.export-update-dialog[open]'), 'Review did not open for stale check');
        await window.designer.execute({documentId:current.document.id, pageId:current.activePageId, expectedRevision:current.document.revision, command:{type:'update',id:headingId,patch:{fontSize:29}}});
        await waitFor(() => document.querySelector('.export-update-dialog .primary').disabled, 'Stale review was not disabled');
        document.querySelector('.export-update-dialog .form-actions button').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        return {cancelUnchanged:true, conflictChoice:true, localEditsPreserved:true, stableIds:true, addedLayer:true, undoRedo:true, staleReviewRejected:true};
      })()`);
      if (externalRequests.length)
        throw new Error('Export update attempted external requests');
      updatedBundle.fileKey = '';
      writeFileSync(bundlePath, JSON.stringify(updatedBundle));
      await window.webContents.executeJavaScript(`(async () => {
        const waitFor = async predicate => { for (let i=0;i<100;i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve,50)); } throw new Error('Identity confirmation review did not open'); };
        const before = await window.designer.read();
        [...document.querySelectorAll('.figma-reference-bar button')].find(button => button.textContent === 'Update from export').click();
        await waitFor(() => document.querySelector('.export-update-dialog[open]'));
        const checkbox = document.querySelector('.export-identity input');
        const apply = document.querySelector('.export-update-dialog .primary');
        if (!checkbox || !apply.disabled) throw new Error('Unknown file identity was not guarded');
        checkbox.click(); await new Promise(resolve => setTimeout(resolve,100));
        if (apply.disabled) throw new Error('Identity confirmation did not enable apply');
        document.querySelector('.export-update-dialog .form-actions button').click();
        await new Promise(resolve => setTimeout(resolve,100));
        if ((await window.designer.read()).document.revision !== before.document.revision) throw new Error('Identity review cancellation mutated document');
      })()`);
      updateResult.identityConfirmation = true;
      writeFileSync(
        path.join(directory, 'bundle-import.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
      console.log('Figma import smoke test:', JSON.stringify(result));
      console.log('Export update smoke test:', JSON.stringify(updateResult));
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
