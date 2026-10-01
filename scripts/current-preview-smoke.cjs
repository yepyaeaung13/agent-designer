const { app, net, nativeImage } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const fakeFetch = require('../tests/fixtures/figma.cjs').fakeFetch;
const realFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
net.fetch = fakeFetch;
app.setPath(
  'userData',
  mkdtempSync(path.join(tmpdir(), 'current-preview-smoke-')),
);
const timer = setTimeout(() => app.exit(1), 60000);
app.on('browser-window-created', (_event, window) =>
  window.webContents.once('did-finish-load', async () => {
    let client;
    try {
      const initial = await window.webContents.executeJavaScript(
        'window.designer.read()',
      );
      const connection = await window.webContents.executeJavaScript(
        'window.designer.connection()',
      );
      client = new Client({ name: 'current-preview-smoke', version: '1.0.0' });
      // The fixture replaces global fetch for imports; MCP uses the real local transport.
      const transport = new StreamableHTTPClientTransport(
        new URL(connection.url),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${connection.token}` },
          },
          fetch: realFetch,
        },
      );
      await client.connect(transport);
      async function call(name, args) {
        const result = await client.callTool({ name, arguments: args });
        assert(!result.isError, JSON.stringify(result));
        return result;
      }
      const json = (result) =>
        JSON.parse(result.content.find((item) => item.type === 'text').text);
      const created = json(
        await call('create_document', { name: 'Background preview check' }),
      );
      const documentId = created.document.id,
        pageId = created.document.pages[0].id;
      const rootId = crypto.randomUUID(),
        rectId = crypto.randomUUID(),
        textId = crypto.randomUUID();
      const base = {
        parentId: null,
        type: 'frame',
        name: 'Current frame',
        x: 80,
        y: 80,
        width: 200,
        height: 120,
        rotation: 0,
        fill: '#ffffff',
        opacity: 1,
        cornerRadius: 0,
        text: '',
        fontSize: 18,
        visible: true,
        locked: false,
      };
      let revision = 0;
      async function execute(command) {
        await call('execute_command', {
          documentId,
          pageId,
          expectedRevision: revision,
          command,
        });
        revision++;
      }
      await execute({ type: 'create', node: { ...base, id: rootId } });
      await execute({
        type: 'create',
        node: {
          ...base,
          id: rectId,
          parentId: rootId,
          type: 'rectangle',
          name: 'Color block',
          x: 20,
          y: 20,
          width: 50,
          height: 30,
          fill: '#ff0000',
        },
      });
      await execute({
        type: 'create',
        node: {
          ...base,
          id: textId,
          parentId: rootId,
          type: 'text',
          name: 'Edited title',
          x: 20,
          y: 70,
          width: 160,
          height: 30,
          text: 'Before',
          fill: '#111111',
          fontFamily: 'Arial',
        },
      });
      async function preview(extra = {}) {
        const result = await call('get_current_preview', {
          documentId,
          pageId,
          nodeId: rootId,
          expectedRevision: revision,
          ...extra,
        });
        return {
          meta: json(result),
          bytes: Buffer.from(
            result.content.find((item) => item.type === 'image').data,
            'base64',
          ),
        };
      }
      function pixel(bytes, x, y) {
        const image = nativeImage.createFromBuffer(bytes),
          bitmap = image.toBitmap(),
          width = image.getSize().width;
        return [
          ...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
        ];
      }
      const before = await preview();
      assert.deepEqual(pixel(before.bytes, 25, 25), [0, 0, 255, 255]);
      assert.equal(before.meta.revision, 3);
      assert.equal(before.meta.width, 200);
      await execute({
        type: 'update',
        id: textId,
        patch: { text: 'After editing' },
      });
      const textEdited = await preview();
      assert(
        !textEdited.bytes.equals(before.bytes),
        'Edited text changes the PNG',
      );
      await execute({
        type: 'update',
        id: rectId,
        patch: { fill: '#00ff00', x: 80 },
      });
      const edited = await preview();
      assert.deepEqual(pixel(edited.bytes, 25, 25), [255, 255, 255, 255]);
      assert.deepEqual(pixel(edited.bytes, 85, 25), [0, 255, 0, 255]);
      const stale = await client.callTool({
        name: 'get_current_preview',
        arguments: { documentId, pageId, nodeId: rootId, expectedRevision: 3 },
      });
      assert.equal(stale.isError, true);
      const brief = json(
        await call('get_coding_brief', {
          documentId,
          pageId,
          nodeId: rootId,
          expectedRevision: revision,
        }),
      );
      assert.equal(brief.currentPreview.retrieve.tool, 'get_current_preview');
      assert.equal(brief.currentPreview.revision, revision);
      assert.equal(brief.preview.available, false);
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Zoom out"]').click()`,
      );
      const zoomed = await preview();
      assert(
        zoomed.bytes.equals(edited.bytes),
        'Editor zoom does not affect background preview',
      );
      const stillOpen = await window.webContents.executeJavaScript(
        'window.designer.read()',
      );
      assert.equal(stillOpen.document.id, initial.document.id);
      await execute({
        type: 'update',
        id: rootId,
        patch: { width: 800, height: 401 },
      });
      const scaled = await preview({ maxDimension: 256 });
      assert.equal(scaled.meta.width, 256);
      assert.equal(scaled.meta.height, 129);
      const imported = await window.webContents.executeJavaScript(
        `window.designer.importFigma({url:'https://www.figma.com/design/fixture/Example?node-id=10-20',token:'fixture-token'})`,
      );
      const frame = imported.document.pages[0].nodes.find(
        (node) => !node.parentId,
      );
      const importedCurrent = await call('get_current_preview', {
        documentId: imported.document.id,
        pageId: imported.document.pages[0].id,
        nodeId: frame.id,
        expectedRevision: 0,
      });
      assert.equal(json(importedCurrent).kind, 'current-canvas');
      assert.equal(json(importedCurrent).width, 600);
      const reference = await call('get_preview', {
        documentId: imported.document.id,
      });
      assert.equal(json(reference).kind, 'imported-reference');
      const images = nativeImage.createFromBuffer(
        Buffer.from(
          importedCurrent.content.find((item) => item.type === 'image').data,
          'base64',
        ),
      );
      assert(!images.isEmpty());
      await execute({
        type: 'update',
        id: rectId,
        patch: { assetId: 'e'.repeat(64) },
      });
      const missing = await client.callTool({
        name: 'get_current_preview',
        arguments: {
          documentId,
          pageId,
          nodeId: rootId,
          expectedRevision: revision,
        },
      });
      assert.equal(missing.isError, true);
      const artifacts = path.join(__dirname, '../.artifacts');
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        path.join(artifacts, 'current-preview-before.png'),
        before.bytes,
      );
      writeFileSync(
        path.join(artifacts, 'current-preview-edited.png'),
        edited.bytes,
      );
      writeFileSync(
        path.join(artifacts, 'current-preview-imported.png'),
        Buffer.from(
          importedCurrent.content.find((item) => item.type === 'image').data,
          'base64',
        ),
      );
      console.log(
        'Current preview smoke:',
        JSON.stringify({
          textEdits: true,
          colorAndSpacingEdits: true,
          staleRejected: true,
          backgroundViewPreserved: true,
          zoomIndependent: true,
          boundedDimensions: true,
          localAssetsRendered: true,
          missingAssetRejected: true,
          briefIncludesPreview: true,
        }),
      );
      clearTimeout(timer);
      await client.close();
      app.quit();
    } catch (error) {
      console.error(error.message);
      if (client) await client.close().catch(() => {});
      app.exit(1);
    }
  }),
);
require('../.vite/build/main.cjs');
