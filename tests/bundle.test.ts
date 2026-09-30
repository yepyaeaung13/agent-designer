import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DocumentService } from '../src/main/document-service';
import { importFigmaBundle } from '../src/main/figma-bundle';
import { flattenFigma, normalizeFigma } from '../src/main/figma-import';
import { getDesignContext } from '../src/main/design-context';
import { root, response, png } from './fixtures/figma.cjs';

test('large-page previews are bounded, allow longer rendering, and clean up progress timers', async () => {
  for (const compactPreview of [false, true]) {
    const messages: any[] = [];
    const deadlines: number[] = [];
    const active = new Set<object>();
    let scale = 0;
    const frame = {
      id: '1:1',
      name: 'Long page',
      type: 'FRAME',
      width: 1440,
      height: 10000,
      exportAsync: async (options: any) => {
        if (options.format === 'JSON_REST_V1')
          return {
            document: {
              id: '1:1',
              name: 'Long page',
              type: 'FRAME',
              children: [],
            },
          };
        scale = options.constraint.value;
        return png;
      },
    };
    const figma = {
      showUI() {},
      currentPage: { selection: [frame] },
      fileKey: '',
      ui: {
        onmessage: async (_message: any) => {},
        postMessage: (message: any) => messages.push(message),
      },
      base64Encode: (bytes: Uint8Array) =>
        Buffer.from(bytes).toString('base64'),
    };
    vm.runInNewContext(readFileSync('figma-plugin/code.js', 'utf8'), {
      figma,
      __html__: '',
      setTimeout: (_callback: unknown, ms: number) => {
        deadlines.push(ms);
        const id = {};
        active.add(id);
        return id;
      },
      clearTimeout: (id: object) => active.delete(id),
      setInterval: (callback: () => void) => {
        const id = {};
        active.add(id);
        callback();
        return id;
      },
      clearInterval: (id: object) => active.delete(id),
    });
    await figma.ui.onmessage({
      type: 'export',
      requestId: 'large',
      compactPreview,
    });
    assert.ok(messages.some((message) => message.type === 'ready'));
    assert.ok(messages.some((message) => message.text?.includes('elapsed')));
    assert.ok(deadlines.includes(180000));
    assert.ok(scale * frame.height <= (compactPreview ? 1024 : 2048));
    assert.ok(
      scale * scale * frame.width * frame.height <=
        (compactPreview ? 500000 : 2000000),
    );
    assert.equal(active.size, 0);
  }
});

test('frame image fills after solid fills and typography survive normalization', () => {
  const source = {
    kind: 'figma' as const,
    fileKey: 'test',
    nodeId: root.id,
    url: '',
    version: 'test',
    importedAt: new Date().toISOString(),
    previewAssetId: 'a'.repeat(64),
    importedRevision: 0,
  };
  const doc = normalizeFigma(
    {
      ...root,
      fills: [...root.fills, { type: 'IMAGE', imageRef: 'background' }],
      cornerRadius: 9999,
    },
    source,
    {},
    { background: 'b'.repeat(64) },
  );
  assert.equal(doc.pages[0].nodes[0].backgroundAssetId, 'b'.repeat(64));
  assert.equal(doc.pages[0].nodes[0].cornerRadius, 200);
  const text = doc.pages[0].nodes.find((node) => node.type === 'text')!;
  assert.equal(text.fontFamily, 'Arial');
  assert.equal(text.fontWeight, 600);
  assert.equal(text.lineHeight, 36);
  assert.equal(text.letterSpacing, -0.5);
});

test('plugin export imports offline with original properties and assets for coding', async () => {
  const messages: any[] = [];
  const live = (node: any) => ({
    ...node,
    width: 600,
    height: 400,
    exportAsync: async (options: any) =>
      options.format === 'JSON_REST_V1' ? response.nodes['10:20'] : png,
  });
  const figma = {
    showUI() {},
    fileKey: 'FixtureFile',
    currentPage: { selection: [live(root)] },
    ui: {
      onmessage: async (_message: any) => {},
      postMessage: (message: any) => messages.push(message),
    },
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    getNodeByIdAsync: async (id: string) =>
      live(flattenFigma(root).find((node) => node.id === id)),
    getImageByHash: () => ({ getBytesAsync: async () => png }),
  };
  vm.runInNewContext(readFileSync('figma-plugin/code.js', 'utf8'), {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    figma,
    __html__: '',
  });
  await figma.ui.onmessage({ type: 'export' });
  const ready = messages.find((message) => message.type === 'ready');
  assert.ok(ready, JSON.stringify(messages));
  const folder = mkdtempSync(path.join(tmpdir(), 'designer-bundle-'));
  const service = new DocumentService(path.join(folder, 'test.sqlite'));
  try {
    const snapshot = importFigmaBundle(service, Buffer.from(ready.json));
    const doc = snapshot.document;
    assert.equal(doc.pages[0].nodes.length, 6);
    assert.equal(doc.source!.version.startsWith('plugin-export:'), true);
    assert.deepEqual(
      service.getAsset(doc.id, doc.source!.previewAssetId).bytes,
      png,
    );
    const context = getDesignContext(service, {
      documentId: doc.id,
      pageId: doc.pages[0].id,
      nodeId: doc.pages[0].nodes[0].id,
      offset: 0,
      limit: 100,
    });
    assert.ok(JSON.stringify(context).includes('Fixture'));
    const before = JSON.stringify(service.read());
    const broken = JSON.parse(ready.json);
    broken.assets = [];
    assert.throws(() =>
      importFigmaBundle(service, Buffer.from(JSON.stringify(broken))),
    );
    assert.equal(JSON.stringify(service.read()), before);
    broken.assets = JSON.parse(ready.json).assets;
    broken.renders = {};
    assert.throws(
      () => importFigmaBundle(service, Buffer.from(JSON.stringify(broken))),
      /missing a rendered layer/,
    );
    assert.equal(JSON.stringify(service.read()), before);
    broken.renders = JSON.parse(ready.json).renders;
    broken.assets[0].base64 = Buffer.from('<script>bad</script>').toString(
      'base64',
    );
    assert.throws(
      () => importFigmaBundle(service, Buffer.from(JSON.stringify(broken))),
      /image type/,
    );
    assert.equal(JSON.stringify(service.read()), before);
  } finally {
    service.close();
    rmSync(folder, { recursive: true, force: true });
  }
  messages.length = 0;
  figma.currentPage.selection = [];
  await figma.ui.onmessage({ type: 'export' });
  assert.equal(messages.at(-1).type, 'error');
});

test('plugin UI accepts correlated desktop bridge replies and recovers when no reply arrives', () => {
  const elements: Record<string, any> = Object.fromEntries(
    ['export', 'download', 'status', 'compact'].map((id) => [id, {}]),
  );
  const sent: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const window: any = {};
  const parent = { postMessage: (message: any) => sent.push(message) };
  const script = readFileSync('figma-plugin/ui.html', 'utf8').match(
    /<script>([\s\S]*?)<\/script>/,
  )![1];
  vm.runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    window,
    parent,
    // Figma's UI can lack crypto.randomUUID (or crypto entirely).
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Blob,
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  elements.export.onclick();
  const requestId = sent[0].pluginMessage.requestId;
  window.onmessage({
    source: null,
    data: {
      pluginMessage: { type: 'progress', requestId: 'wrong', text: 'wrong' },
    },
  });
  assert.equal(elements.status.textContent, 'Preparing export…');
  window.onmessage({
    source: null,
    data: {
      pluginMessage: {
        type: 'progress',
        requestId,
        text: 'Rendering reference image…',
      },
    },
  });
  assert.equal(elements.status.textContent, 'Rendering reference image…');
  window.onmessage({
    source: null,
    data: {
      pluginMessage: { type: 'ready', requestId, json: '{}', name: 'Contact' },
    },
  });
  assert.equal(elements.download.hidden, false);
  assert.equal(elements.export.disabled, false);
  assert.equal(timers.size, 0);
  elements.export.onclick();
  assert.notEqual(sent[1].pluginMessage.requestId, requestId);
  [...timers.values()][0]();
  assert.match(elements.status.textContent, /did not respond/);
  assert.equal(elements.export.disabled, false);
});
