import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { makeNode, type DesignDocument } from '../src/shared/design';
import { getCodingBrief } from '../src/main/coding-brief';
import { codingPrompt } from '../src/shared/coding-handoff';

test('local readiness is scoped, read-only, and checks visibility at the exact revision', () => {
  const service = new DocumentService(':memory:');
  try {
    const root = makeNode('frame');
    const hidden = { ...makeNode('frame'), parentId: root.id, visible: false };
    const document: DesignDocument = {
      schemaVersion: 3,
      id: crypto.randomUUID(),
      name: 'Local',
      revision: 0,
      pages: [
        {
          id: crypto.randomUUID(),
          name: 'Page',
          nodes: [
            root,
            hidden,
            {
              ...makeNode('image'),
              parentId: hidden.id,
              assetId: 'a'.repeat(64),
            },
            { ...makeNode('text'), fontFamily: 'Unrelated font' },
          ],
        },
      ],
    };
    const saved = service.read().document;
    for (const node of document.pages[0].nodes) {
      service.execute({
        documentId: saved.id,
        pageId: saved.pages[0].id,
        expectedRevision: service.read().document.revision,
        command: { type: 'create', node },
      });
    }
    const scope = {
      documentId: saved.id,
      pageId: saved.pages[0].id,
      nodeId: root.id,
      expectedRevision: 4,
    };
    const before = JSON.stringify(service.read());
    assert.deepEqual(getCodingBrief(service, scope).readiness, {
      status: 'ready',
      imageCount: 0,
      localFontCount: 0,
      issues: [],
    });
    assert.deepEqual(
      getCodingBrief(service, { ...scope, nodeId: hidden.id }).readiness.issues,
      ['The selected scope has no visible layers.'],
    );
    assert.throws(() =>
      getCodingBrief(service, { ...scope, expectedRevision: 1 }),
    );
    assert.equal(JSON.stringify(service.read()), before);
  } finally {
    service.close();
  }
});

test('coding brief covers large subtrees, excludes unrelated and hidden assets, and reports reference freshness', () => {
  const service = new DocumentService(':memory:');
  try {
    const preview = 'a'.repeat(64),
      used = 'b'.repeat(64),
      hiddenAsset = 'c'.repeat(64),
      otherAsset = 'd'.repeat(64);
    const root = {
      ...makeNode('frame'),
      name: 'Contact',
      width: 1440,
      height: 2538,
      source: { nodeId: '1:1', type: 'FRAME' },
    };
    const section = {
      ...makeNode('frame'),
      parentId: root.id,
      name: 'Contact form',
    };
    const hidden = { ...makeNode('frame'), parentId: root.id, visible: false };
    const nodes = [
      root,
      section,
      hidden,
      { ...makeNode('image'), parentId: section.id, assetId: used },
      { ...makeNode('image'), parentId: hidden.id, assetId: hiddenAsset },
      { ...makeNode('image'), assetId: otherAsset },
      ...Array.from({ length: 205 }, () => ({
        ...makeNode('text'),
        parentId: section.id,
        fontFamily: 'Plus Jakarta Sans',
        fontWeight: 600,
      })),
    ];
    const document: DesignDocument = {
      schemaVersion: 3,
      id: crypto.randomUUID(),
      name: 'Imported Contact',
      revision: 0,
      pages: [{ id: crypto.randomUUID(), name: 'Page', nodes }],
      source: {
        kind: 'figma',
        url: 'https://www.figma.com/design/fixture',
        fileKey: 'fixture',
        nodeId: '1:1',
        version: '1',
        importedAt: new Date().toISOString(),
        previewAssetId: preview,
        importedRevision: 0,
        warnings: ['Mixed text styles may differ.'],
      },
    };
    service.importDocument(
      document,
      {},
      [preview, used, hiddenAsset, otherAsset].map((id) => ({
        id,
        mimeType: 'image/png',
        bytes: Buffer.from('fixture'),
        role: id === preview ? 'reference' : 'image',
      })),
    );
    const args = {
      documentId: document.id,
      pageId: document.pages[0].id,
      nodeId: root.id,
      expectedRevision: 0,
    };
    const before = JSON.stringify(service.read());
    const brief = getCodingBrief(service, args);
    assert.equal(brief.readiness.status, 'needs-attention');
    assert.equal(brief.readiness.imageCount, 1);
    assert.equal(brief.readiness.localFontCount, 0);
    assert.ok(
      brief.readiness.issues.some((issue) =>
        issue.includes('Plus Jakarta Sans'),
      ),
    );
    assert.equal(brief.layerCount, 210);
    assert.equal(brief.hiddenLayerCount, 2);
    assert.deepEqual(
      brief.assets.map((asset) => asset.id),
      [used],
    );
    assert.deepEqual(brief.fonts, [
      { family: 'Plus Jakarta Sans', weight: 600, style: 'normal' },
    ]);
    assert.equal(brief.preview.stale, false);
    assert.equal(brief.preview.matchesSelectedSourceNode, true);
    assert.equal(brief.sections.length, 1);
    assert.equal(
      JSON.stringify(service.read()),
      before,
      'Brief must not mutate or switch the document',
    );
    service.execute({
      documentId: document.id,
      pageId: document.pages[0].id,
      expectedRevision: 0,
      command: {
        type: 'update',
        id: root.id,
        patch: { name: 'Edited Contact' },
      },
    });
    assert.throws(() => getCodingBrief(service, args), /design changed/);
    const edited = getCodingBrief(service, { ...args, expectedRevision: 1 });
    assert.equal(edited.selection.name, 'Edited Contact');
    assert.equal(edited.preview.stale, true);
    assert(
      edited.warnings.some((warning) =>
        warning.includes('predates local edits'),
      ),
    );
    assert.throws(
      () =>
        getCodingBrief(service, {
          ...args,
          pageId: crypto.randomUUID(),
          expectedRevision: 1,
        }),
      /Node not found/,
    );
  } finally {
    service.close();
  }
});

test('local designs have a usable brief without an imported preview and report missing assets', () => {
  const service = new DocumentService(':memory:');
  try {
    const { document, activePageId } = service.read();
    const root = document.pages[0].nodes.find((node) => !node.parentId)!;
    service.execute({
      documentId: document.id,
      pageId: activePageId,
      expectedRevision: 0,
      command: {
        type: 'update',
        id: root.id,
        patch: { backgroundAssetId: 'e'.repeat(64) },
      },
    });
    const brief = getCodingBrief(service, {
      documentId: document.id,
      pageId: activePageId,
      nodeId: root.id,
      expectedRevision: 1,
    });
    assert.equal(brief.preview.available, false);
    assert.equal('retrieve' in brief.preview, false);
    assert.deepEqual(brief.missingAssetIds, ['e'.repeat(64)]);
    assert.equal(brief.readiness.status, 'needs-attention');
    assert.ok(
      brief.readiness.issues.includes(`Missing local image: ${'e'.repeat(64)}`),
    );
    assert.equal(brief.context.arguments.expectedRevision, 1);
    assert(
      brief.warnings.some((warning) => warning.includes('missing assets')),
    );
  } finally {
    service.close();
  }
});

test('copied prompts bind exact scope and target without embedding design names or credentials', () => {
  const scope = {
    documentId: crypto.randomUUID(),
    pageId: crypto.randomUUID(),
    nodeId: crypto.randomUUID(),
    expectedRevision: 12,
  };
  for (const target of ['existing', 'react-demo'] as const) {
    const prompt = codingPrompt({ ...scope, target });
    assert(prompt.includes(JSON.stringify(scope)));
    assert(prompt.includes('get_coding_brief'));
    assert(prompt.includes('nextOffset'));
    assert(prompt.includes('get_asset'));
    assert(
      prompt.includes(
        target === 'existing'
          ? 'current project'
          : 'separate responsive React demo',
      ),
    );
    assert(!prompt.includes('Bearer'));
  }
});
