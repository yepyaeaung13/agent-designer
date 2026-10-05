import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocumentService } from '../src/main/document-service';
import { parseFigmaBundle } from '../src/main/figma-bundle';
import { prepareExportUpdate } from '../src/main/figma-sync';
import {
  flattenFigma,
  needsRender,
  type FigmaNode,
} from '../src/main/figma-import';
import { makeNode, type DesignCommand } from '../src/shared/design';
import { getDesignContext } from '../src/main/design-context';
import { root, png } from './fixtures/figma.cjs';

function bytes(
  change: (node: FigmaNode) => void = () => {},
  fileKey = 'FixtureFile',
  asset = png,
) {
  const source = structuredClone(root) as FigmaNode;
  change(source);
  return Buffer.from(
    JSON.stringify({
      format: 'agent-designer.figma-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      fileKey,
      entry: { document: source },
      preview: 'png',
      renders: Object.fromEntries(
        flattenFigma(source)
          .filter(needsRender)
          .map((node) => [node.id, 'png']),
      ),
      images: { 'fixture-photo': 'png' },
      warnings: [],
      assets: [
        { key: 'png', mimeType: 'image/png', base64: asset.toString('base64') },
      ],
    }),
  );
}
function fixture(filename = ':memory:', legacy = false) {
  const service = new DocumentService(filename);
  const bundle = parseFigmaBundle(bytes());
  const raw: Record<string, unknown> = bundle.raw;
  if (legacy) delete raw.baseline;
  const imported = service.importDocument(bundle.document, raw, bundle.assets);
  const documentId = imported.document.id,
    pageId = imported.activePageId;
  const node = (sourceId: string) =>
    service
      .read(documentId)
      .document.pages.find((page) => page.id === pageId)!
      .nodes.find((node) => node.source?.nodeId === sourceId)!;
  const execute = (command: DesignCommand) =>
    service.execute({
      documentId,
      pageId,
      expectedRevision: service.read(documentId).document.revision,
      command,
    });
  const prepare = (bundle: Buffer) =>
    prepareExportUpdate(
      service,
      documentId,
      service.read(documentId).document.revision,
      parseFigmaBundle(bundle),
      'updated.agentdesign.json',
    );
  const apply = async (
    plan: ReturnType<typeof prepare>,
    choices: Record<string, 'local' | 'export'> = {},
    confirmed = false,
  ) => {
    const result = plan.resolve(choices, confirmed);
    return service.updateImportedDocument(
      documentId,
      plan.review.expectedRevision,
      result.document,
      result.raw,
      result.assets,
    );
  };
  return { service, documentId, pageId, node, execute, prepare, apply };
}

test('updated exports preserve identity and local fields while applying independent source changes', async () => {
  const f = fixture();
  try {
    const headingId = f.node('10:21').id;
    f.execute({ type: 'update', id: headingId, patch: { fill: '#123456' } });
    f.execute({
      type: 'update',
      id: f.node('10:20').id,
      patch: { layout: { ...f.node('10:20').layout!, gap: 30 } },
    });
    f.execute({ type: 'rename', name: 'My local document' });
    const extraPage = crypto.randomUUID();
    f.execute({ type: 'create_page', id: extraPage, name: 'Local page' });
    const unrelated = makeNode('rectangle');
    f.execute({ type: 'create', node: unrelated });
    const plan = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'New heading';
        source.paddingLeft = 48;
      }),
    );
    assert.equal(plan.review.conflicts.length, 0);
    await f.apply(plan);
    assert.equal(f.node('10:21').id, headingId);
    assert.equal(f.node('10:21').text, 'New heading');
    assert.equal(f.node('10:21').fill, '#123456');
    assert.equal(f.node('10:20').layout!.gap, 30);
    assert.equal(f.node('10:20').layout!.padding.left, 48);
    const result = f.service.read().document;
    assert.equal(result.id, f.documentId);
    assert.equal(result.name, 'My local document');
    assert.equal(result.pages[0].id, f.pageId);
    assert.equal(result.pages[1].id, extraPage);
    assert.deepEqual(
      result.pages[0].nodes.find((node) => node.id === unrelated.id),
      unrelated,
    );
    assert.notEqual(result.source!.importedRevision, result.revision);
  } finally {
    f.service.close();
  }
});

test('competing text and styled ranges resolve together; the new baseline retains deliberate local choices', async () => {
  const f = fixture();
  try {
    f.execute({
      type: 'update',
      id: f.node('10:21').id,
      patch: {
        text: 'Local',
        textRuns: [{ start: 0, end: 5, fontWeight: 700 }],
      },
    });
    const incoming = bytes((source) => {
      source.children![0].characters = 'Export';
    });
    const plan = f.prepare(incoming);
    assert.equal(plan.review.conflicts.length, 1);
    assert.equal(plan.review.conflicts[0].field, 'Text and styled ranges');
    await f.apply(plan);
    assert.equal(f.node('10:21').text, 'Local');
    assert.equal(f.node('10:21').textRuns![0].end, 5);
    const repeated = f.prepare(incoming);
    assert.equal(repeated.review.conflicts.length, 0);
    await f.apply(repeated);
    assert.equal(f.node('10:21').text, 'Local');
    const newer = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Newest export';
      }),
    );
    const choices = Object.fromEntries(
      newer.review.conflicts.map((conflict) => [
        conflict.id,
        'export' as const,
      ]),
    );
    await f.apply(newer, choices);
    assert.equal(f.node('10:21').text, 'Newest export');
    assert.equal(f.node('10:21').textRuns, undefined);
  } finally {
    f.service.close();
  }
});

test('source additions, deletions, reparenting and order apply with stable existing layer IDs', async () => {
  const f = fixture();
  try {
    const headingId = f.node('10:21').id;
    const photoId = f.node('10:25').id;
    const plan = f.prepare(
      bytes((source) => {
        const card = source.children![1];
        const photo = card.children!.pop()!;
        card.children = card.children!.filter((node) => node.id !== '10:24');
        source.children = [
          photo,
          card,
          source.children![0],
          {
            ...structuredClone(source.children![0]),
            id: '10:99',
            name: 'New text',
            characters: 'Added',
          },
        ];
      }),
    );
    assert.equal(plan.review.conflicts.length, 0);
    assert.equal(plan.review.added, 1);
    assert.equal(plan.review.removed, 1);
    await f.apply(plan);
    assert.equal(f.node('10:21').id, headingId);
    assert.equal(f.node('10:25').id, photoId);
    assert.equal(f.node('10:25').parentId, f.node('10:20').id);
    assert.equal(f.node('10:24'), undefined);
    assert.equal(f.node('10:99').text, 'Added');
    assert.equal(
      f.service.read().document.source!.importedRevision,
      f.service.read().document.revision,
    );
  } finally {
    f.service.close();
  }
});

test('hierarchy conflicts keep local additions and edited deleted layers until explicitly resolved', async () => {
  const f = fixture();
  try {
    const cardId = f.node('10:22').id;
    const extra = {
      ...makeNode('text'),
      parentId: cardId,
      text: 'My addition',
    };
    f.execute({ type: 'create', node: extra });
    f.execute({
      type: 'update',
      id: f.node('10:23').id,
      patch: { text: 'Local description' },
    });
    const plan = f.prepare(
      bytes((source) => {
        source.children = [source.children![0]];
      }),
    );
    assert.equal(plan.review.conflicts[0].field, 'Layer hierarchy and order');
    await f.apply(plan);
    assert.equal(f.node('10:22').id, cardId);
    assert.ok(
      f.service
        .read()
        .document.pages[0].nodes.some((node) => node.id === extra.id),
    );
    f.execute({ type: 'undo' });
    const again = f.prepare(
      bytes((source) => {
        source.children = [source.children![0]];
      }),
    );
    await f.apply(again, { [again.review.conflicts[0].id]: 'export' });
    assert.equal(f.node('10:22'), undefined);
    assert.equal(
      f.service
        .read()
        .document.pages[0].nodes.some((node) => node.id === extra.id),
      false,
    );
  } finally {
    f.service.close();
  }
});

test('local deletions survive unchanged exports and conflict with updated export content', async () => {
  const f = fixture();
  try {
    const headingId = f.node('10:21').id;
    f.execute({ type: 'delete', id: headingId });
    const unchanged = f.prepare(bytes());
    assert.equal(unchanged.review.conflicts.length, 0);
    await f.apply(unchanged);
    assert.equal(f.node('10:21'), undefined);
    const changed = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Changed remotely';
      }),
    );
    assert.equal(
      changed.review.conflicts[0].field,
      'Layer hierarchy and order',
    );
    await f.apply(changed, { [changed.review.conflicts[0].id]: 'export' });
    assert.equal(f.node('10:21').id, headingId);
    assert.equal(f.node('10:21').text, 'Changed remotely');
  } finally {
    f.service.close();
  }
});

test('undo and redo restore source context, assets and the merge baseline; updates persist after restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'figma-sync-'));
  const filename = path.join(directory, 'design.sqlite');
  const f = fixture(filename);
  let closed = false;
  try {
    const originalSource = f.service.getSource(f.documentId);
    const originalReference = f.service.read().document.source!.previewAssetId;
    const asset = Buffer.concat([png, Buffer.from('updated asset')]);
    const incoming = bytes(
      (source) => {
        source.children![0].characters = 'Updated export';
      },
      'FixtureFile',
      asset,
    );
    await f.apply(f.prepare(incoming));
    const updatedReference = f.service.read().document.source!.previewAssetId;
    assert.notEqual(updatedReference, originalReference);
    f.execute({ type: 'undo' });
    assert.deepEqual(f.service.getSource(f.documentId), originalSource);
    assert.equal(
      f.service.read().document.source!.previewAssetId,
      originalReference,
    );
    assert.deepEqual(
      f.service.getAsset(f.documentId, originalReference).bytes,
      png,
    );
    f.execute({ type: 'redo' });
    const scope = {
      documentId: f.documentId,
      pageId: f.pageId,
      nodeId: f.node('10:21').id,
    };
    assert.equal(
      getDesignContext(f.service, scope).nodes[0].originalFigmaProperties
        ?.characters,
      'Updated export',
    );
    assert.deepEqual(
      f.service.getAsset(f.documentId, updatedReference).bytes,
      asset,
    );
    f.service.close();
    closed = true;
    const reopened = new DocumentService(filename);
    try {
      const plan = prepareExportUpdate(
        reopened,
        f.documentId,
        reopened.read().document.revision,
        parseFigmaBundle(incoming),
        'again.json',
      );
      assert.equal(plan.review.conflicts.length, 0);
      assert.equal(plan.review.updated, 0);
      assert.equal(
        reopened.read().document.source!.previewAssetId,
        updatedReference,
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('wrong sources, missing file identity, malformed exports and stale reviews cannot mutate documents', async () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.service.read());
    assert.throws(
      () =>
        f.prepare(
          bytes((source) => {
            source.id = 'wrong';
          }),
        ),
      /same Figma frame/,
    );
    assert.throws(
      () => f.prepare(bytes(() => {}, 'OtherFile')),
      /different Figma file/,
    );
    assert.throws(() => f.prepare(Buffer.from('{}')));
    const unverified = f.prepare(bytes(() => {}, ''));
    assert.throws(() => unverified.resolve({}, false), /same Figma file/);
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.throws(
      () => unverified.resolve({ unknown: 'export' }, true),
      /Unknown export conflict/,
    );
    const plan = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Remote';
      }),
    );
    f.execute({
      type: 'update',
      id: f.node('10:21').id,
      patch: { text: 'Changed while reviewing' },
    });
    const afterEdit = JSON.stringify(f.service.read());
    await assert.rejects(f.apply(plan), /design changed/);
    assert.equal(JSON.stringify(f.service.read()), afterEdit);
  } finally {
    f.service.close();
  }
});

test('legacy imports reconstruct a baseline and layout failures leave document and source unchanged', async () => {
  const f = fixture(':memory:', true);
  try {
    const plan = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Legacy update';
      }),
    );
    assert.equal(plan.review.conflicts.length, 0);
    await f.apply(plan);
    assert.equal(f.node('10:21').text, 'Legacy update');
    const rootId = f.node('10:20').id;
    f.service.setLayoutRecalculator(async () => {
      throw new Error('Measurement unavailable');
    });
    const failing = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Not saved';
      }),
    );
    const resolved = failing.resolve({}, false);
    resolved.document.pages[0].nodes.find(
      (node) => node.id === rootId,
    )!.layout!.enabled = true;
    const before = JSON.stringify(f.service.read());
    const sourceBefore = JSON.stringify(f.service.getSource(f.documentId));
    await assert.rejects(
      f.service.updateImportedDocument(
        f.documentId,
        failing.review.expectedRevision,
        resolved.document,
        resolved.raw,
        resolved.assets,
      ),
      /Measurement unavailable/,
    );
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.equal(
      JSON.stringify(f.service.getSource(f.documentId)),
      sourceBefore,
    );
  } finally {
    f.service.close();
  }
});

test('a type replacement conflicts with local edits and transaction failures roll back source and design', async () => {
  const f = fixture();
  try {
    f.execute({
      type: 'update',
      id: f.node('10:21').id,
      patch: { fill: '#123456' },
    });
    const plan = f.prepare(
      bytes((source) => {
        source.children![0].type = 'RECTANGLE';
      }),
    );
    assert.equal(plan.review.conflicts[0].field, 'Layer hierarchy and order');
    await f.apply(plan);
    assert.equal(f.node('10:21').type, 'text');
    assert.equal(f.node('10:21').fill, '#123456');
    f.execute({ type: 'undo' });
    const again = f.prepare(
      bytes((source) => {
        source.children![0].type = 'RECTANGLE';
      }),
    );
    const resolved = again.resolve(
      { [again.review.conflicts[0].id]: 'export' },
      false,
    );
    const circular: Record<string, unknown> = { raw: resolved.raw };
    circular.self = circular;
    const before = JSON.stringify(f.service.read());
    const sourceBefore = JSON.stringify(f.service.getSource(f.documentId));
    await assert.rejects(
      f.service.updateImportedDocument(
        f.documentId,
        again.review.expectedRevision,
        resolved.document,
        circular,
        resolved.assets,
      ),
      /circular/i,
    );
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.equal(
      JSON.stringify(f.service.getSource(f.documentId)),
      sourceBefore,
    );
    await f.apply(again, { [again.review.conflicts[0].id]: 'export' });
    assert.equal(f.node('10:21').type, 'rectangle');
  } finally {
    f.service.close();
  }
});

test('an edit during asynchronous update measurement invalidates the update without replacing the baseline', async () => {
  const f = fixture();
  try {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.service.setLayoutRecalculator(async (nodes) => {
      await blocked;
      return nodes;
    });
    const plan = f.prepare(
      bytes((source) => {
        source.children![0].characters = 'Export';
      }),
    );
    const resolved = plan.resolve({}, false);
    resolved.document.pages[0].nodes.find(
      (node) => node.source?.nodeId === '10:20',
    )!.layout!.enabled = true;
    const sourceBefore = JSON.stringify(f.service.getSource(f.documentId));
    const pending = f.service.updateImportedDocument(
      f.documentId,
      plan.review.expectedRevision,
      resolved.document,
      resolved.raw,
      resolved.assets,
    );
    f.execute({
      type: 'update',
      id: f.node('10:21').id,
      patch: { text: 'Concurrent local edit' },
    });
    release();
    await assert.rejects(pending, /design changed during layout measurement/);
    assert.equal(f.node('10:21').text, 'Concurrent local edit');
    assert.equal(
      JSON.stringify(f.service.getSource(f.documentId)),
      sourceBefore,
    );
  } finally {
    f.service.close();
  }
});
