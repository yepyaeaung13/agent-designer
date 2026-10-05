import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DocumentService } from '../src/main/document-service';
import { FontStore } from '../src/main/font-store';
import { importFigmaBundle } from '../src/main/figma-bundle';
import { flattenFigma, needsRender } from '../src/main/figma-import';
import { startMcp } from '../src/main/mcp';
import { codingPrompt } from '../src/shared/coding-handoff';
import { root, png } from './fixtures/figma.cjs';
import handoff from '../scripts/design-handoff.cjs';

function fontBytes() {
  const bytes = Buffer.alloc(156);
  bytes.writeUInt32BE(0x10000, 0);
  bytes.writeUInt16BE(2, 4);
  bytes.write('OS/2', 12);
  bytes.writeUInt32BE(44, 20);
  bytes.writeUInt32BE(78, 24);
  bytes.write('post', 28);
  bytes.writeUInt32BE(124, 36);
  bytes.writeUInt32BE(32, 40);
  bytes.writeUInt16BE(400, 48);
  bytes.writeUInt16BE(64, 106);
  bytes.writeUInt32BE(0x30000, 124);
  return bytes;
}

test('plugin-file handoff survives restart and local edits without external requests', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'offline-handoff-'));
  const database = path.join(directory, 'design.sqlite');
  let service = new DocumentService(database);
  let mcp: Awaited<ReturnType<typeof startMcp>> | undefined;
  const client = new Client({ name: 'offline-coding-client', version: '1' });
  const originalFetch = globalThis.fetch;
  const externalRequests: string[] = [];
  let localOrigin = '';
  let localRequests = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== localOrigin) {
      externalRequests.push(url.origin);
      throw new Error('External networking is disabled for this handoff.');
    }
    localRequests++;
    return originalFetch(input, options);
  };
  try {
    // One-pixel scope matches the stub PNG. Actual raster fidelity is covered
    // by the desktop preview smoke tests, not this transport/persistence test.
    const source = {
      ...root,
      size: { x: 1, y: 1 },
      absoluteBoundingBox: { ...root.absoluteBoundingBox, width: 1, height: 1 },
    };
    const bundle = {
      format: 'agent-designer.figma-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      fileKey: '',
      entry: { document: source },
      preview: 'shared',
      renders: Object.fromEntries(
        flattenFigma(source)
          .filter(needsRender)
          .map((node) => [node.id, 'shared']),
      ),
      images: { 'fixture-photo': 'shared' },
      warnings: [],
      assets: [
        {
          key: 'shared',
          mimeType: 'image/png',
          base64: png.toString('base64'),
        },
      ],
    };
    const imported = importFigmaBundle(
      service,
      Buffer.from(JSON.stringify(bundle)),
    );
    const documentId = imported.document.id;
    const pageId = imported.activePageId;
    const frame = imported.document.pages[0].nodes[0];
    const heading = imported.document.pages[0].nodes.find(
      (node) => node.type === 'text',
    )!;
    const store = new FontStore(directory);
    const font = store.import(
      { family: 'Arial', weight: '400', style: 'normal' },
      fontBytes(),
    );
    service.close();
    service = new DocumentService(database);
    const reopenedFonts = new FontStore(directory);
    let previewCount = 0;
    mcp = await startMcp(
      service,
      0,
      async (input) => {
        previewCount++;
        assert.equal(input.documentId, documentId);
        assert.equal(
          input.nodes.find((node) => node.id === heading.id)?.text,
          'Updated locally',
        );
        for (const node of input.nodes)
          for (const id of [node.assetId, node.backgroundAssetId])
            if (id)
              assert.deepEqual(service.getAsset(documentId, id).bytes, png);
        return png.toString('base64');
      },
      reopenedFonts,
    );
    localOrigin = new URL(mcp.url).origin;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      assert.ok(!result.isError, JSON.stringify(result));
      return result;
    };
    const json = (result: CallToolResult) =>
      JSON.parse((result.content[0] as { text: string }).text);
    const scope = {
      documentId,
      pageId,
      nodeId: frame.id,
      expectedRevision: imported.document.revision,
    };
    const brief = json(await call('get_coding_brief', scope));
    assert.equal(brief.designAccess.externalDesignRequestsRequired, false);
    assert.equal(brief.missingAssetIds.length, 0);
    // Deduplicated reference bytes may also be a required layer asset.
    assert.equal(brief.assets.length, 1);
    for (const asset of brief.assets) {
      const result = await call(asset.retrieve.tool, asset.retrieve.arguments);
      assert.deepEqual(
        Buffer.from((result.content[1] as any).resource.blob, 'base64'),
        png,
      );
    }
    const available = brief.fontAssets.variants.filter(
      (variant: any) => variant.status === 'available',
    );
    assert.equal(available.length, 1);
    assert.equal(available[0].asset.id, font.id);
    const retrievedFont = await call(
      'get_font',
      available[0].asset.retrieve.arguments,
    );
    const retrievedBytes = Buffer.from(
      (retrievedFont.content[1] as any).resource.blob,
      'base64',
    );
    assert.deepEqual(retrievedBytes, fontBytes());
    assert.equal(
      createHash('sha256').update(retrievedBytes).digest('hex'),
      available[0].asset.sha256,
    );
    assert.ok(
      brief.fontAssets.variants.some(
        (variant: any) => variant.status === 'unavailable',
      ),
    );
    const reference = await call('get_preview', { documentId });
    assert.deepEqual(
      Buffer.from((reference.content[1] as any).data, 'base64'),
      png,
    );
    const revision = json(
      await call('execute_command', {
        documentId,
        pageId,
        expectedRevision: scope.expectedRevision,
        command: {
          type: 'update',
          id: heading.id,
          patch: { text: 'Updated locally' },
        },
      }),
    ).document.revision;
    const current = { ...scope, expectedRevision: revision };
    const updatedBrief = json(await call('get_coding_brief', current));
    assert.equal(updatedBrief.preview.stale, true);
    const changes = json(
      await call('get_design_changes', {
        ...current,
        baseline: brief.changeTracking.baseline,
      }),
    );
    assert.equal(changes.unchanged, false);
    const layers: any[] = [];
    let offset = 0;
    for (;;) {
      const context = json(
        await call('get_design_context', { ...current, offset, limit: 2 }),
      );
      layers.push(...context.nodes);
      if (context.nextOffset === null) break;
      offset = context.nextOffset;
    }
    assert.equal(layers.length, imported.document.pages[0].nodes.length);
    assert.equal(
      layers.find((node) => node.id === heading.id).text,
      'Updated locally',
    );
    assert.equal(
      layers.find((node) => node.id === heading.id).originalFigmaProperties
        .characters,
      heading.text,
    );
    await call('get_layout_context', current);
    await call('get_component_manifest', current);
    const preview = await call(
      'get_current_preview',
      updatedBrief.currentPreview.retrieve.arguments,
    );
    assert.equal(json(preview).revision, revision);
    assert.equal(previewCount, 1);
    const snapshot = await handoff.retrieveHandoff(
      client,
      current,
      brief.changeTracking.baseline,
    );
    assert.equal(snapshot.receipts.brief.scope.expectedRevision, revision);
    assert.equal(snapshot.receipts.changes.unchanged, false);
    assert.deepEqual(
      snapshot.files.get(`public/fonts/${available[0].asset.filename}`),
      fontBytes(),
    );
    assert.deepEqual(snapshot.files.get('design/current.png'), png);
    assert.deepEqual(snapshot.files.get('design/reference.png'), png);
    assert.equal(
      snapshot.receipts.context.flatMap((page: any) => page.nodes).length,
      layers.length,
    );
    const stale = await client.callTool({
      name: 'get_design_context',
      arguments: scope,
    });
    assert.equal(stale.isError, true);
    const prompt = codingPrompt({ ...current, target: 'existing' });
    assert.match(prompt, /Do not call the Figma API, Figma MCP/);
    assert.equal(prompt.includes(mcp.token), false);
    assert.ok(localRequests > 0);
    assert.deepEqual(externalRequests, []);
  } finally {
    try {
      await client.close();
    } finally {
      globalThis.fetch = originalFetch;
      await mcp?.close();
      service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
