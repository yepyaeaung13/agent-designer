import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DocumentService } from '../src/main/document-service';
import { FigmaImporter, parseFigmaUrl } from '../src/main/figma-import';
import { getDesignContext } from '../src/main/design-context';
import { startMcp } from '../src/main/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fakeFetch, response, png } from './fixtures/figma.cjs';
import {
  downloadFigmaAsset,
  rateLimitMessage,
} from '../src/main/figma-network';

test('asset transport retries transient failures, including interrupted bodies, without credentials', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, options) => {
    assert.equal(options?.headers, undefined);
    calls++;
    if (calls === 1)
      throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
    if (calls === 2)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection reset'));
          },
        }),
      );
    return new Response(png);
  };
  const bytes = await downloadFigmaAsset(
    'https://s3-alpha.figma.com/test.png',
    fetcher,
    () => true,
    async () => {},
  );
  assert.equal(calls, 3);
  assert.deepEqual(bytes, png);
});

test('asset retries revalidate redirects and redact signed URL details from errors', async () => {
  const address = 'https://s3-alpha.figma.com/test.png?secret=must-not-appear';
  await assert.rejects(
    downloadFigmaAsset(
      address,
      async () => {
        throw new Error(address);
      },
      () => true,
      async () => {},
    ),
    (error: Error) =>
      error.message.includes('after 3 attempts') &&
      !error.message.includes('secret='),
  );
  let calls = 0;
  await assert.rejects(
    downloadFigmaAsset(
      address,
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        });
      },
      (url) => url.protocol === 'https:',
      async () => {},
    ),
    /unsupported asset host/,
  );
  assert.equal(calls, 1);
  assert.match(rateLimitMessage('399796'), /112 hours/);
});

test('retrying an incomplete import reuses successful calls and batches preview with PNG layers', async () => {
  const service = new DocumentService(':memory:');
  const paths: string[] = [];
  let failSvg = true;
  const importer = new FigmaImporter(service, async (url, options) => {
    paths.push(String(url));
    if (String(url).includes('format=svg') && failSvg) {
      failSvg = false;
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': '60' },
      });
    }
    return fakeFetch(url, options);
  });
  try {
    await assert.rejects(importer.import(input), /rate limit/);
    const snapshot = await importer.import(input);
    assert.ok(snapshot.document.source);
    assert.equal(paths.filter((url) => url.includes('/nodes?')).length, 1);
    assert.equal(paths.filter((url) => url.includes('format=png')).length, 1);
    assert.ok(paths.some((url) => url.includes('ids=10%3A20%2C10%3A25')));
  } finally {
    service.close();
  }
});

const input = {
  url: 'https://www.figma.com/design/fixture/Example?node-id=10-20',
  token: 'fixture-token-never-save',
};
test('Figma URLs are scoped to a frame and reject non-Figma hosts', () => {
  assert.equal(parseFigmaUrl(input.url).nodeId, '10:20');
  assert.equal(
    parseFigmaUrl('https://www.figma.com/file/abc/Test?node-id=458%3A6288')
      .nodeId,
    '458:6288',
  );
  for (const url of [
    'http://localhost/a',
    'https://evil.test/design/abc?node-id=1-2',
    'https://www.figma.com/design/abc/No-node',
  ])
    assert.throws(() => parseFigmaUrl(url));
});

test('imports structure, typography, layout, raw properties and assets atomically; reopens offline', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'designer-figma-'));
  const filename = path.join(directory, 'test.sqlite');
  let service = new DocumentService(filename);
  try {
    const original = service.read().document;
    const snapshot = await new FigmaImporter(service, fakeFetch).import(input);
    const document = snapshot.document;
    assert.equal(service.list().length, 2);
    assert.deepEqual(service.read(original.id).document, original);
    const nodes = document.pages[0].nodes;
    assert.equal(nodes.length, 6);
    assert.equal(nodes[0].layout?.direction, 'vertical');
    assert.equal(nodes[0].layout?.padding.left, 32);
    assert.equal(nodes[1].fontFamily, 'Arial');
    assert.equal(nodes[1].fontWeight, 600);
    assert.equal(nodes[1].x, 32);
    assert.equal(nodes[3].parentId, nodes[2].id);
    assert.ok(nodes[4].assetId);
    assert.equal(
      service.getAsset(document.id, nodes[4].assetId!).mimeType,
      'image/svg+xml',
    );
    assert.ok(
      document.source?.warnings.some((warning) =>
        warning.includes('mixed text'),
      ),
    );
    const request = {
      documentId: document.id,
      pageId: document.pages[0].id,
      nodeId: nodes[0].id,
      limit: 2,
    };
    const context = getDesignContext(service, request);
    assert.equal(context.nextOffset, 2);
    assert.equal(context.totalNodes, 6);
    assert.equal(
      getDesignContext(service, { ...request, offset: 2 }).nodes[1]
        .originalFigmaProperties?.styleOverrideTable !== undefined,
      true,
    );
    assert.ok(
      !JSON.stringify(service.getSource(document.id)).includes(input.token),
    );
    assert.throws(
      () => service.getAsset(original.id, nodes[4].assetId!),
      /not found/,
    );
    service.execute({
      documentId: document.id,
      pageId: document.pages[0].id,
      expectedRevision: 0,
      command: {
        type: 'update',
        id: nodes[1].id,
        patch: { text: 'Local edit' },
      },
    });
    assert.equal(getDesignContext(service, request).referenceIsStale, true);
    assert.throws(
      () => getDesignContext(service, { ...request, expectedRevision: 0 }),
      /changed/,
    );
    service.close();
    service = new DocumentService(filename);
    assert.equal(service.read().document.pages[0].nodes[1].text, 'Local edit');
    assert.deepEqual(
      service.getAsset(document.id, document.source!.previewAssetId).bytes,
      png,
    );
    assert.ok(service.getSource(document.id));
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed imports leave no document and never forward tokens to asset hosts', async () => {
  const service = new DocumentService(':memory:');
  try {
    const before = service.read();
    const failed = async () => new Response('', { status: 403 });
    await assert.rejects(
      new FigmaImporter(service, failed).import(input),
      /denied access/,
    );
    const malicious = async (url: any, options: any) =>
      String(url).includes('/v1/images/')
        ? Response.json({ images: { '10:20': 'http://127.0.0.1/private' } })
        : fakeFetch(url, options);
    await assert.rejects(
      new FigmaImporter(service, malicious).import(input),
      /unsupported asset host/,
    );
    const broken = async (url: any, options: any) =>
      String(url).endsWith('/nodes?ids=10%3A20&geometry=paths')
        ? Response.json({ ...response, nodes: {} })
        : fakeFetch(url, options);
    await assert.rejects(
      new FigmaImporter(service, broken).import(input),
      /Select a frame/,
    );
    assert.deepEqual(service.read(), before);
  } finally {
    service.close();
  }
});

test('v2 documents migrate to v3 without altering pages or revisions', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'designer-v2-'));
  const filename = path.join(directory, 'test.sqlite');
  const old = {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    name: 'Existing pages',
    revision: 5,
    pages: [{ id: crypto.randomUUID(), name: 'Page A', nodes: [] }],
  };
  const db = new Database(filename);
  db.exec(
    'CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA user_version=2;',
  );
  db.prepare('INSERT INTO documents VALUES (?, ?, ?)').run(
    old.id,
    JSON.stringify(old),
    'today',
  );
  db.close();
  const service = new DocumentService(filename);
  try {
    assert.deepEqual(service.read().document, { ...old, schemaVersion: 3 });
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP delivers paged context, reference images and exact asset bytes to a coding client', async () => {
  const service = new DocumentService(':memory:');
  const imported = await new FigmaImporter(service, fakeFetch).import(input);
  const document = imported.document;
  const mcp = await startMcp(service);
  const client = new Client({ name: 'coding-agent-fixture', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.content as any[];
    };
    const frames = JSON.parse(
      (await call('list_frames', { documentId: document.id }))[0].text,
    );
    assert.equal(frames.pages[0].frames.length, 2);
    const context = JSON.parse(
      (
        await call('get_design_context', {
          documentId: document.id,
          pageId: document.pages[0].id,
          nodeId: document.pages[0].nodes[0].id,
        })
      )[0].text,
    );
    assert.equal(context.nodes.length, 6);
    const preview = await call('get_preview', { documentId: document.id });
    assert.equal(preview[1].type, 'image');
    assert.deepEqual(Buffer.from(preview[1].data, 'base64'), png);
    const assetId = document.pages[0].nodes[4].assetId!;
    const asset = await call('get_asset', { documentId: document.id, assetId });
    assert.equal(asset[1].resource.mimeType, 'image/svg+xml');
    assert.deepEqual(
      Buffer.from(asset[1].resource.blob, 'base64'),
      service.getAsset(document.id, assetId).bytes,
    );
  } finally {
    await client.close();
    await mcp.close();
    service.close();
  }
});
