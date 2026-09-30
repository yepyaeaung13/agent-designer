import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  documentSchema,
  legacyDocumentSchema,
  makeNode,
  requestSchema,
  workspaceActionSchema,
  validateTree,
  type DesignDocument,
  type Snapshot,
} from '../shared/design';

type History = { undo: DesignDocument[]; redo: DesignDocument[] };
export class DocumentService extends EventEmitter {
  private db: Database.Database;
  private documents = new Map<string, DesignDocument>();
  private histories = new Map<string, History>();
  private activeId = '';
  private pages: Record<string, string> = {};
  private sequence = 0;

  constructor(filename: string) {
    super();
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode = WAL');
      const version = this.db.pragma('user_version', {
        simple: true,
      }) as number;
      if (version > 3) throw new Error('This database requires a newer app.');
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS document_backups (id TEXT PRIMARY KEY, content TEXT NOT NULL, saved_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS workspace_state (id INTEGER PRIMARY KEY CHECK (id=1), content TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS import_sources (document_id TEXT PRIMARY KEY, content TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, bytes BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS document_assets (document_id TEXT NOT NULL, asset_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(document_id, asset_id));`);
        const rows = this.db
          .prepare('SELECT id, content FROM documents ORDER BY updated_at, id')
          .all() as { id: string; content: string }[];
        for (const row of rows) {
          let raw = JSON.parse(row.content);
          if (version < 2 && raw.schemaVersion === 1) {
            const legacy = legacyDocumentSchema.parse(raw);
            raw = {
              schemaVersion: 3,
              id: legacy.id,
              name: legacy.name,
              revision: legacy.revision,
              pages: [
                {
                  id: crypto.randomUUID(),
                  name: 'Page 1',
                  nodes: legacy.nodes,
                },
              ],
            };
            this.db
              .prepare(
                'INSERT OR IGNORE INTO document_backups VALUES (?, ?, ?)',
              )
              .run(row.id, row.content, new Date().toISOString());
          }
          if (version < 3 && raw.schemaVersion === 2) {
            this.db
              .prepare(
                'INSERT OR IGNORE INTO document_backups VALUES (?, ?, ?)',
              )
              .run(row.id, row.content, new Date().toISOString());
            raw = { ...raw, schemaVersion: 3 };
          }
          const document = documentSchema.parse(raw);
          if (document.id !== row.id)
            throw new Error('Document ID does not match its saved record.');
          validateTree(document);
          if (version < 3) this.persist(document);
          this.documents.set(document.id, document);
        }
        this.db.pragma('user_version = 3');
      })();
      if (!this.documents.size) {
        const frame = { ...makeNode('frame', 80, 80), name: 'Welcome board' };
        const title = {
          ...makeNode('text', 48, 56),
          parentId: frame.id,
          text: 'Make room for ideas.',
          name: 'Headline',
          width: 550,
          fontSize: 36,
        };
        const subtitle = {
          ...makeNode('text', 48, 116),
          parentId: frame.id,
          text: 'A local canvas. Ready for you and your agents.',
          name: 'Description',
          width: 530,
          fontSize: 17,
          fill: '#777d8b',
        };
        const shape = {
          ...makeNode('rectangle', 48, 194),
          parentId: frame.id,
          width: 250,
          height: 158,
          fill: '#ebe7ff',
          name: 'Idea card',
        };
        const document = this.blank('Untitled design');
        document.pages[0].nodes = [frame, title, subtitle, shape];
        this.persist(document);
        this.documents.set(document.id, document);
      }
      const row = this.db
        .prepare('SELECT content FROM workspace_state WHERE id=1')
        .get() as { content: string } | undefined;
      const state = row
        ? z
            .object({
              activeId: z.string(),
              pages: z.record(z.string(), z.string()),
            })
            .parse(JSON.parse(row.content))
        : undefined;
      this.activeId =
        state?.activeId && this.documents.has(state.activeId)
          ? state.activeId
          : this.documents.keys().next().value!;
      this.pages = state?.pages ?? {};
      for (const document of this.documents.values())
        this.pages[document.id] = this.validPage(
          document,
          this.pages[document.id],
        );
      this.saveWorkspace();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private blank(name: string): DesignDocument {
    return {
      schemaVersion: 3,
      id: crypto.randomUUID(),
      name,
      revision: 0,
      pages: [{ id: crypto.randomUUID(), name: 'Page 1', nodes: [] }],
    };
  }
  private get(id: string) {
    const document = this.documents.get(id);
    if (!document) throw new Error('Document not found.');
    return document;
  }
  private history(id: string): History {
    let history = this.histories.get(id);
    if (!history) {
      history = { undo: [], redo: [] };
      this.histories.set(id, history);
    }
    return history;
  }
  private validPage(document: DesignDocument, id?: string) {
    return document.pages.some((page) => page.id === id)
      ? id!
      : document.pages[0].id;
  }
  list() {
    return [...this.documents.values()].map((document) => ({
      id: document.id,
      name: document.name,
      revision: document.revision,
      pageCount: document.pages.length,
      nodeCount: document.pages.reduce(
        (count, page) => count + page.nodes.length,
        0,
      ),
    }));
  }
  read(documentId = this.activeId): Snapshot {
    const document = this.get(documentId);
    const history = this.history(documentId);
    return {
      document: structuredClone(document),
      documents: this.list(),
      activeDocumentId: this.activeId,
      activePageId: this.validPage(document, this.pages[document.id]),
      sequence: this.sequence,
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
    };
  }
  private notify() {
    this.sequence++;
    this.emit('changed', this.read());
  }
  private saveWorkspace(activeId = this.activeId, pages = this.pages) {
    this.db
      .prepare(
        'INSERT INTO workspace_state (id, content) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content',
      )
      .run(JSON.stringify({ activeId, pages }));
  }

  workspace(input: unknown): Snapshot {
    const action = workspaceActionSchema.parse(input);
    let activeId = this.activeId;
    const pages = { ...this.pages };
    let created: DesignDocument | undefined;
    if (action.type === 'create_document') {
      created = this.blank(action.name);
      pages[created.id] = created.pages[0].id;
      if (action.activate) activeId = created.id;
    } else if (action.type === 'open_document') {
      this.get(action.id);
      activeId = action.id;
    } else if (action.type === 'open_page') {
      const document = this.get(action.documentId);
      if (!document.pages.some((page) => page.id === action.pageId))
        throw new Error('Page not found.');
      activeId = action.documentId;
      pages[activeId] = action.pageId;
    } else {
      const document = this.get(action.id);
      if (document.revision !== action.expectedRevision)
        throw new Error('The design changed. Refresh and try again.');
      if (this.documents.size === 1)
        throw new Error('Keep at least one document.');
      if (activeId === action.id)
        activeId = [...this.documents.keys()].find((id) => id !== action.id)!;
      delete pages[action.id];
    }
    this.db.transaction(() => {
      if (created) this.persist(created);
      if (action.type === 'delete_document') {
        this.db.prepare('DELETE FROM documents WHERE id=?').run(action.id);
        this.db
          .prepare('DELETE FROM import_sources WHERE document_id=?')
          .run(action.id);
        this.db
          .prepare('DELETE FROM document_assets WHERE document_id=?')
          .run(action.id);
        this.db
          .prepare(
            'DELETE FROM assets WHERE id NOT IN (SELECT asset_id FROM document_assets)',
          )
          .run();
      }
      this.saveWorkspace(activeId, pages);
    })();
    if (created) this.documents.set(created.id, created);
    if (action.type === 'delete_document') {
      this.documents.delete(action.id);
      this.histories.delete(action.id);
    }
    this.activeId = activeId;
    this.pages = pages;
    this.notify();
    return this.read(created?.id);
  }

  execute(input: unknown): Snapshot {
    const { documentId, pageId, expectedRevision, command } =
      requestSchema.parse(input);
    const document = this.get(documentId);
    if (expectedRevision !== document.revision)
      throw new Error('The design changed. Refresh and try again.');
    const history = this.history(documentId);
    const previous = structuredClone(document);
    let next = structuredClone(previous);
    if (command.type === 'undo' || command.type === 'redo') {
      const stack = history[command.type];
      if (!stack.length) return this.read(documentId);
      next = structuredClone(stack[stack.length - 1]);
    } else if (command.type === 'rename') next.name = command.name;
    else if (command.type === 'create_page')
      next.pages.push({ id: command.id, name: command.name, nodes: [] });
    else if (command.type === 'rename_page' || command.type === 'delete_page') {
      const page = next.pages.find((item) => item.id === command.id);
      if (!page) throw new Error('Page not found.');
      if (command.type === 'rename_page') page.name = command.name;
      else {
        if (next.pages.length === 1) throw new Error('Keep at least one page.');
        next.pages = next.pages.filter((item) => item.id !== command.id);
      }
    } else {
      const page = next.pages.find((item) => item.id === pageId);
      if (!page)
        throw new Error('A valid pageId is required for node commands.');
      if (command.type === 'create') page.nodes.push(command.node);
      else {
        const node = page.nodes.find((item) => item.id === command.id);
        if (!node) throw new Error('Node not found on this page.');
        if (command.type === 'update') Object.assign(node, command.patch);
        else {
          const deleted = new Set([command.id]);
          let count = 0;
          while (count !== deleted.size) {
            count = deleted.size;
            page.nodes.forEach((item) => {
              if (item.parentId && deleted.has(item.parentId))
                deleted.add(item.id);
            });
          }
          page.nodes = page.nodes.filter((item) => !deleted.has(item.id));
        }
      }
    }
    next.revision = previous.revision + 1;
    next = documentSchema.parse(next);
    validateTree(next);
    const pages = {
      ...this.pages,
      [documentId]: this.validPage(next, this.pages[documentId]),
    };
    this.db.transaction(() => {
      this.persist(next);
      this.saveWorkspace(this.activeId, pages);
    })();
    if (command.type === 'undo') {
      history.undo.pop();
      history.redo.push(previous);
    } else if (command.type === 'redo') {
      history.redo.pop();
      history.undo.push(previous);
    } else {
      history.undo.push(previous);
      history.redo = [];
    }
    if (history.undo.length > 100) history.undo.shift();
    this.documents.set(documentId, next);
    this.pages = pages;
    this.notify();
    return this.read(documentId);
  }
  private persist(document: DesignDocument) {
    this.db
      .prepare(
        'INSERT INTO documents (id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at',
      )
      .run(document.id, JSON.stringify(document), new Date().toISOString());
  }
  importDocument(
    input: DesignDocument,
    raw: unknown,
    assets: { id: string; mimeType: string; bytes: Buffer; role: string }[],
  ) {
    const document = documentSchema.parse(input);
    validateTree(document);
    if (this.documents.has(document.id))
      throw new Error('Imported document already exists.');
    const ids = new Set(assets.map((asset) => asset.id));
    if (!document.source || !ids.has(document.source.previewAssetId))
      throw new Error('Import requires a saved reference preview.');
    for (const page of document.pages)
      for (const node of page.nodes)
        if (node.assetId && !ids.has(node.assetId))
          throw new Error('Missing imported asset.');
    for (const page of document.pages)
      for (const node of page.nodes)
        if (node.backgroundAssetId && !ids.has(node.backgroundAssetId))
          throw new Error('Missing background asset.');
    const pages = { ...this.pages, [document.id]: document.pages[0].id };
    this.db.transaction(() => {
      this.persist(document);
      this.db
        .prepare('INSERT INTO import_sources VALUES (?, ?)')
        .run(document.id, JSON.stringify(raw));
      for (const asset of assets) {
        this.db
          .prepare('INSERT OR IGNORE INTO assets VALUES (?, ?, ?)')
          .run(asset.id, asset.mimeType, asset.bytes);
        this.db
          .prepare('INSERT OR IGNORE INTO document_assets VALUES (?, ?, ?)')
          .run(document.id, asset.id, asset.role);
      }
      this.saveWorkspace(document.id, pages);
    })();
    this.documents.set(document.id, document);
    this.activeId = document.id;
    this.pages = pages;
    this.notify();
    return this.read();
  }
  getAsset(documentId: string, assetId: string) {
    this.get(documentId);
    const row = this.db
      .prepare(
        'SELECT a.id, a.mime_type, a.bytes, d.role FROM assets a JOIN document_assets d ON d.asset_id=a.id WHERE d.document_id=? AND a.id=?',
      )
      .get(documentId, assetId) as
      | { id: string; mime_type: string; bytes: Buffer; role: string }
      | undefined;
    if (!row) throw new Error('Asset not found in this document.');
    return {
      id: row.id,
      mimeType: row.mime_type,
      bytes: row.bytes,
      role: row.role,
    };
  }
  listAssets(documentId: string) {
    this.get(documentId);
    return this.db
      .prepare(
        'SELECT a.id, a.mime_type AS mimeType, length(a.bytes) AS byteLength, d.role FROM assets a JOIN document_assets d ON d.asset_id=a.id WHERE d.document_id=?',
      )
      .all(documentId) as {
      id: string;
      mimeType: string;
      byteLength: number;
      role: string;
    }[];
  }
  getSource(documentId: string): unknown {
    this.get(documentId);
    const row = this.db
      .prepare('SELECT content FROM import_sources WHERE document_id=?')
      .get(documentId) as { content: string } | undefined;
    return row ? JSON.parse(row.content) : null;
  }
  close() {
    this.db.close();
  }
}
