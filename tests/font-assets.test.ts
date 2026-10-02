import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FontStore } from '../src/main/font-store';
import { DocumentService } from '../src/main/document-service';
import { makeNode } from '../src/shared/design';
import { getFontManifest, getFontAsset } from '../src/main/font-assets';
import { getCodingBrief } from '../src/main/coding-brief';
import { startMcp } from '../src/main/mcp';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { png } from './fixtures/figma.cjs';

function fontBytes() {
  const b = Buffer.alloc(156);
  b.writeUInt32BE(0x10000, 0);
  b.writeUInt16BE(2, 4);
  b.write('OS/2', 12);
  b.writeUInt32BE(44, 20);
  b.writeUInt32BE(78, 24);
  b.write('post', 28);
  b.writeUInt32BE(124, 36);
  b.writeUInt32BE(32, 40);
  b.writeUInt16BE(400, 48);
  b.writeUInt16BE(64, 106);
  b.writeUInt32BE(0x30000, 124);
  return b;
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'scoped-fonts-')),
    store = new FontStore(directory),
    service = new DocumentService(':memory:');
  const doc = service.read().document,
    pageId = doc.pages[0].id;
  const root = { ...makeNode('frame'), width: 1, height: 1 },
    hidden = { ...makeNode('frame'), parentId: root.id, visible: false };
  for (const node of [
    root,
    hidden,
    {
      ...makeNode('text'),
      parentId: root.id,
      fontFamily: 'Used Font',
      fontWeight: 400,
    },
    { ...makeNode('text'), parentId: hidden.id, fontFamily: 'Hidden Font' },
    { ...makeNode('text'), fontFamily: 'Other Font' },
  ])
    service.execute({
      documentId: doc.id,
      pageId,
      expectedRevision: service.read().document.revision,
      command: { type: 'create', node },
    });
  const scope = {
    documentId: doc.id,
    pageId,
    nodeId: root.id,
    expectedRevision: 5,
  };
  const used = store.import(
    { family: 'Used Font', weight: '400', style: 'normal' },
    fontBytes(),
  );
  const hiddenFont = store.import(
    { family: 'Hidden Font', weight: '400', style: 'normal' },
    fontBytes(),
  );
  const other = store.import(
    { family: 'Other Font', weight: '400', style: 'normal' },
    fontBytes(),
  );
  return {
    service,
    store,
    scope,
    used,
    hiddenFont,
    other,
    directory,
    close() {
      service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('font manifest scopes validated bytes to visible text with checksums and no paths', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.service.read()),
      manifest = getFontManifest(f.service, f.scope, f.store);
    assert.equal(manifest.variants.length, 1);
    const variant = manifest.variants[0];
    assert.equal(variant.status, 'available');
    assert(variant.asset);
    assert('retrieve' in variant.asset);
    const retrieveArgs = variant.asset.retrieve.arguments;
    const bytes = getFontAsset(f.service, retrieveArgs, f.store);
    assert.equal(bytes.data, fontBytes().toString('base64'));
    assert.equal(
      bytes.metadata.sha256,
      createHash('sha256').update(fontBytes()).digest('hex'),
    );
    assert(!JSON.stringify(manifest).includes(f.directory));
    for (const fontId of [f.hiddenFont.id, f.other.id, 'a'.repeat(64)])
      assert.throws(
        () =>
          getFontAsset(
            f.service,
            {
              ...f.scope,
              fontId,
              expectedFontFingerprint: manifest.fingerprint,
            },
            f.store,
          ),
        /selected scope/,
      );
    assert.throws(() =>
      getFontAsset(
        f.service,
        {
          ...f.scope,
          fontId: '../../secret',
          expectedFontFingerprint: manifest.fingerprint,
        },
        f.store,
      ),
    );
    assert.throws(
      () =>
        getFontManifest(
          f.service,
          { ...f.scope, expectedRevision: 0 },
          f.store,
        ),
      /design changed/,
    );
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.deepEqual(
      getCodingBrief(f.service, f.scope, true, f.store).fontAssets,
      manifest,
    );
    f.store.import(
      { family: 'Unrelated Font', weight: '400', style: 'normal' },
      fontBytes(),
    );
    assert.equal(
      getFontManifest(f.service, f.scope, f.store).fingerprint,
      manifest.fingerprint,
    );
    f.store.remove(f.used.id);
    assert.throws(
      () => getFontAsset(f.service, retrieveArgs, f.store),
      /font library changed/,
    );
    assert.equal(
      getFontManifest(f.service, f.scope, f.store).variants[0].status,
      'unavailable',
    );
    assert.equal(f.service.read().document.revision, 5);
  } finally {
    f.close();
  }
});
test('authenticated MCP retrieves fonts and rejects changes during preview rendering', async () => {
  const f = fixture();
  const mcp = await startMcp(
    f.service,
    0,
    async () => {
      f.store.remove(f.used.id);
      return png.toString('base64');
    },
    f.store,
  );
  const client = new Client({ name: 'font-client-test', version: '1' });
  try {
    assert.equal((await fetch(mcp.url, { method: 'POST' })).status, 401);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
      }),
    );
    const read = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult;
    const briefResult = await read('get_coding_brief', f.scope);
    assert(!briefResult.isError);
    const brief = JSON.parse((briefResult.content[0] as { text: string }).text);
    const result = await read(
      'get_font',
      brief.fontAssets.variants[0].asset.retrieve.arguments,
    );
    assert(!result.isError);
    assert.equal(
      (result.content[1] as any).resource.blob,
      fontBytes().toString('base64'),
    );
    const invalid = await read('get_font', {
      ...brief.fontAssets.variants[0].asset.retrieve.arguments,
      fontId: f.other.id,
    });
    assert(invalid.isError);
    const preview = await read('get_current_preview', {
      ...brief.currentPreview.retrieve.arguments,
      maxDimension: 256,
    });
    assert(preview.isError);
    assert.match(
      (preview.content[0] as { text: string }).text,
      /font library changed/,
    );
    const stale = await read(
      'get_font',
      brief.fontAssets.variants[0].asset.retrieve.arguments,
    );
    assert(stale.isError);
  } finally {
    await client.close();
    await mcp.close();
    f.close();
  }
});
