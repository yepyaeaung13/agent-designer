import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DocumentService } from '../src/main/document-service';
import { makeNode, type DesignCommand } from '../src/shared/design';
import { startMcp } from '../src/main/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const command = (
  service: DocumentService,
  action: DesignCommand,
  documentId = service.read().document.id,
  pageId = service.read(documentId).activePageId,
) =>
  service.execute({
    documentId,
    pageId,
    expectedRevision: service.read(documentId).document.revision,
    command: action,
  });

test('migrates v1 losslessly, keeps a backup, and persists workspace selection across restarts', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'designer-migration-'));
  const file = path.join(directory, 'test.sqlite');
  const legacy = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: 'Existing work',
    revision: 7,
    nodes: [makeNode('rectangle')],
  };
  const original = new Database(file);
  original.exec(
    'CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA user_version=1;',
  );
  original
    .prepare('INSERT INTO documents VALUES (?, ?, ?)')
    .run(legacy.id, JSON.stringify(legacy), new Date().toISOString());
  original.close();
  let service = new DocumentService(file);
  try {
    const migrated = service.read().document;
    assert.equal(migrated.id, legacy.id);
    assert.equal(migrated.revision, 7);
    assert.equal(migrated.schemaVersion, 3);
    assert.deepEqual(migrated.pages[0].nodes, legacy.nodes);
    const other = service.workspace({
      type: 'create_document',
      name: 'Second design',
      activate: true,
    });
    const pageId = crypto.randomUUID();
    command(service, { type: 'create_page', id: pageId, name: 'Details' });
    service.workspace({
      type: 'open_page',
      documentId: other.document.id,
      pageId,
    });
    command(service, { type: 'create', node: makeNode('text') });
    service.close();
    service = new DocumentService(file);
    assert.equal(service.read().document.id, other.document.id);
    assert.equal(service.read().activePageId, pageId);
    assert.equal(service.read().document.pages[1].nodes.length, 1);
    assert.equal(service.list().length, 2);
    assert.deepEqual(
      service.read(legacy.id).document.pages[0].nodes,
      legacy.nodes,
    );
    const db = new Database(file, { readonly: true });
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 3);
      const backup = db
        .prepare('SELECT content FROM document_backups WHERE id=?')
        .get(legacy.id) as { content: string };
      assert.deepEqual(JSON.parse(backup.content), legacy);
    } finally {
      db.close();
    }
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid legacy hierarchies roll back the migration without rewriting saved data', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'designer-rollback-'));
  const file = path.join(directory, 'test.sqlite');
  const legacy = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: 'Broken parent',
    revision: 0,
    nodes: [{ ...makeNode('text'), parentId: crypto.randomUUID() }],
  };
  const db = new Database(file);
  try {
    db.exec(
      'CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL); PRAGMA user_version=1;',
    );
    db.prepare('INSERT INTO documents VALUES (?, ?, ?)').run(
      legacy.id,
      JSON.stringify(legacy),
      'today',
    );
    assert.throws(() => new DocumentService(file), /frame/);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.equal(
      (db.prepare('SELECT content FROM documents').get() as { content: string })
        .content,
      JSON.stringify(legacy),
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pages isolate nodes, enforce hierarchy, and support delete/undo without touching other documents', () => {
  const service = new DocumentService(':memory:');
  try {
    const first = service.read();
    const firstId = first.document.id;
    const page1 = first.activePageId;
    const page2 = crypto.randomUUID();
    command(service, { type: 'create_page', id: page2, name: 'Mobile' });
    const frame = makeNode('frame');
    command(service, { type: 'create', node: frame }, firstId, page2);
    const child = { ...makeNode('text'), parentId: frame.id };
    assert.throws(
      () => command(service, { type: 'create', node: child }, firstId, page1),
      /frame/,
    );
    command(service, { type: 'create', node: child }, firstId, page2);
    assert.throws(
      () =>
        command(
          service,
          { type: 'update', id: child.id, patch: { x: 20 } },
          firstId,
          page1,
        ),
      /not found/,
    );
    assert.throws(
      () => command(service, { type: 'create', node: child }, firstId, page2),
      /Duplicate/,
    );
    assert.throws(
      () =>
        command(service, { type: 'create_page', id: page2, name: 'Duplicate' }),
      /Duplicate/,
    );
    command(service, { type: 'rename_page', id: page2, name: 'Mobile layout' });
    service.workspace({
      type: 'open_page',
      documentId: firstId,
      pageId: page2,
    });
    command(service, { type: 'delete', id: frame.id });
    assert.equal(service.read().document.pages[1].nodes.length, 0);
    command(service, { type: 'undo' });
    assert.equal(service.read().document.pages[1].nodes.length, 2);
    const second = service.workspace({
      type: 'create_document',
      name: 'Separate document',
      activate: true,
    });
    assert.equal(second.canUndo, false);
    command(service, { type: 'delete_page', id: page2 }, firstId);
    assert.equal(service.read().document.id, second.document.id);
    assert.equal(service.read(firstId).activePageId, page1);
    command(service, { type: 'undo' }, firstId);
    assert.equal(service.read(firstId).document.pages[1].nodes.length, 2);
    command(service, { type: 'redo' }, firstId);
    assert.equal(service.read(firstId).document.pages.length, 1);
    assert.throws(
      () => command(service, { type: 'delete_page', id: page1 }, firstId),
      /at least one page/,
    );
    assert.deepEqual(
      service.read(firstId).document.pages[0].nodes,
      first.document.pages[0].nodes,
    );
    assert.throws(() =>
      service.execute({
        expectedRevision: 0,
        command: { type: 'rename', name: 'No ID' },
      }),
    );
    assert.throws(
      () =>
        service.execute({
          documentId: firstId,
          expectedRevision: 0,
          command: { type: 'rename', name: 'Stale' },
        }),
      /changed/,
    );
    assert.throws(
      () =>
        service.execute({
          documentId: second.document.id,
          expectedRevision: 0,
          command: { type: 'create', node: makeNode('text') },
        }),
      /pageId/,
    );
    command(service, { type: 'rename', name: 'Renamed design' });
    assert.equal(
      service.list().find((item) => item.id === second.document.id)?.name,
      'Renamed design',
    );
    assert.throws(
      () =>
        service.workspace({
          type: 'delete_document',
          id: second.document.id,
          expectedRevision: 0,
        }),
      /changed/,
    );
    service.workspace({
      type: 'delete_document',
      id: second.document.id,
      expectedRevision: 1,
    });
    assert.equal(service.read().document.id, firstId);
    assert.throws(() => service.read(second.document.id), /not found/);
    assert.throws(
      () =>
        service.workspace({
          type: 'delete_document',
          id: firstId,
          expectedRevision: service.read().document.revision,
        }),
      /at least one document/,
    );
  } finally {
    service.close();
  }
});

test('MCP authenticates and targets background documents without changing the open canvas', async () => {
  const service = new DocumentService(':memory:');
  const mcp = await startMcp(service);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const unpack = (result: any) => {
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    assert.equal((await fetch(mcp.url, { method: 'POST' })).status, 401);
    assert.equal(
      (
        await fetch(mcp.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${mcp.token}`,
            Origin: 'https://example.com',
          },
        })
      ).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
      }),
    );
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      [
        'create_document',
        'delete_document',
        'execute_command',
        'get_asset',
        'get_coding_brief',
        'get_current_preview',
        'get_design_changes',
        'get_design_context',
        'get_preview',
        'list_documents',
        'list_frames',
        'read_document',
      ],
    );
    const activeId = service.read().document.id;
    const created = unpack(
      await client.callTool({
        name: 'create_document',
        arguments: { name: 'Agent draft' },
      }),
    );
    assert.equal(service.read().document.id, activeId);
    const documentId = created.document.id;
    const pageId = created.document.pages[0].id;
    const node = makeNode('rectangle');
    unpack(
      await client.callTool({
        name: 'execute_command',
        arguments: {
          documentId,
          pageId,
          expectedRevision: 0,
          command: { type: 'create', node },
        },
      }),
    );
    const read = unpack(
      await client.callTool({
        name: 'read_document',
        arguments: { documentId },
      }),
    );
    assert.equal(read.document.pages[0].nodes[0].id, node.id);
    const brief = unpack(
      await client.callTool({
        name: 'get_coding_brief',
        arguments: { documentId, pageId, nodeId: node.id, expectedRevision: 1 },
      }),
    );
    assert.equal(brief.selection.id, undefined);
    assert.equal(brief.scope.nodeId, node.id);
    assert.equal(brief.preview.available, false);
    const unchanged = unpack(
      await client.callTool({
        name: 'get_design_changes',
        arguments: { ...brief.scope, baseline: brief.changeTracking.baseline },
      }),
    );
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.toRevision, 1);
    const staleBrief = await client.callTool({
      name: 'get_coding_brief',
      arguments: { documentId, pageId, nodeId: node.id, expectedRevision: 0 },
    });
    assert.equal(staleBrief.isError, true);
    assert.equal(service.read().document.id, activeId);
    const conflict = await client.callTool({
      name: 'execute_command',
      arguments: {
        documentId,
        pageId,
        expectedRevision: 0,
        command: { type: 'delete', id: node.id },
      },
    });
    assert.equal(conflict.isError, true);
    const listed = unpack(
      await client.callTool({ name: 'list_documents', arguments: {} }),
    );
    assert.equal(listed.length, 2);
    unpack(
      await client.callTool({
        name: 'delete_document',
        arguments: { documentId, expectedRevision: 1 },
      }),
    );
    assert.equal(service.list().length, 1);
  } finally {
    await client.close();
    await mcp.close();
    service.close();
  }
});
