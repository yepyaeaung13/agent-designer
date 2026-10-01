import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { getCurrentPreview } from '../src/main/current-preview';
import { getCodingBrief } from '../src/main/coding-brief';
import { makeNode } from '../src/shared/design';
import { png } from './fixtures/figma.cjs';

function fixture() {
  const service = new DocumentService(':memory:');
  const activeId = service.read().document.id;
  const draft = service.workspace({
    type: 'create_document',
    name: 'Background preview',
    activate: false,
  });
  const documentId = draft.document.id,
    pageId = draft.document.pages[0].id;
  const root = { ...makeNode('frame'), width: 1, height: 1 };
  service.execute({
    documentId,
    pageId,
    expectedRevision: 0,
    command: { type: 'create', node: root },
  });
  return {
    service,
    activeId,
    root,
    scope: { documentId, pageId, nodeId: root.id, expectedRevision: 1 },
  };
}

test('current preview is revision-bound, scoped, read-only and separate from original reference', async () => {
  const { service, activeId, root, scope } = fixture();
  try {
    const before = JSON.stringify(service.read(scope.documentId));
    const result = await getCurrentPreview(service, scope, async (input) => {
      assert.equal(input.root.id, root.id);
      assert.equal(input.nodes.length, 1);
      assert.equal(input.scale, 1);
      return png.toString('base64');
    });
    assert.equal(result.metadata.kind, 'current-canvas');
    assert.equal(result.metadata.revision, 1);
    assert.equal(result.metadata.width, 1);
    assert.equal(result.metadata.height, 1);
    assert.equal(result.data, png.toString('base64'));
    assert.equal(service.read().document.id, activeId);
    assert.equal(JSON.stringify(service.read(scope.documentId)), before);
    const brief = getCodingBrief(service, scope, true);
    assert.equal(brief.preview.available, false);
    assert.equal(brief.currentPreview.available, true);
    assert.equal(brief.currentPreview.retrieve?.arguments.expectedRevision, 1);
    await assert.rejects(
      getCurrentPreview(service, { ...scope, expectedRevision: 0 }, async () =>
        png.toString('base64'),
      ),
      /design changed/,
    );
    await assert.rejects(
      getCurrentPreview(
        service,
        { ...scope, pageId: crypto.randomUUID() },
        async () => png.toString('base64'),
      ),
      /Node not found/,
    );
    await assert.rejects(
      getCurrentPreview(
        service,
        { ...scope, expectedRevision: undefined },
        async () => png.toString('base64'),
      ),
    );
  } finally {
    service.close();
  }
});

test('an edit while rendering invalidates the preview instead of returning stale image metadata', async () => {
  const { service, scope, root } = fixture();
  try {
    await assert.rejects(
      getCurrentPreview(service, scope, async () => {
        service.execute({
          documentId: scope.documentId,
          pageId: scope.pageId,
          expectedRevision: scope.expectedRevision,
          command: { type: 'update', id: root.id, patch: { fill: '#ff0000' } },
        });
        return png.toString('base64');
      }),
      /design changed/,
    );
  } finally {
    service.close();
  }
});

test('preview fails explicitly for hidden layers, unavailable rendering or malformed image output', async () => {
  const { service, scope, root } = fixture();
  try {
    await assert.rejects(getCurrentPreview(service, scope), /unavailable/);
    await assert.rejects(
      getCurrentPreview(service, scope, async () =>
        Buffer.from('not a PNG').toString('base64'),
      ),
      /dimensions/,
    );
    service.execute({
      documentId: scope.documentId,
      pageId: scope.pageId,
      expectedRevision: scope.expectedRevision,
      command: { type: 'update', id: root.id, patch: { visible: false } },
    });
    await assert.rejects(
      getCurrentPreview(
        service,
        { ...scope, expectedRevision: 2 },
        async () => {
          throw new Error('Renderer must not run');
        },
      ),
      /hidden/,
    );
  } finally {
    service.close();
  }
});

test('large preview scale is bounded, and incorrect image dimensions are rejected', async () => {
  const { service, scope, root } = fixture();
  try {
    service.execute({
      documentId: scope.documentId,
      pageId: scope.pageId,
      expectedRevision: scope.expectedRevision,
      command: {
        type: 'update',
        id: root.id,
        patch: { width: 8000, height: 4000 },
      },
    });
    await assert.rejects(
      getCurrentPreview(
        service,
        { ...scope, expectedRevision: 2, maxDimension: 2048 },
        async (input) => {
          assert.equal(input.scale, 2048 / 8000);
          assert.equal(Math.ceil(input.bounds.height * input.scale), 1024);
          return png.toString('base64');
        },
      ),
      /dimensions/,
    );
  } finally {
    service.close();
  }
});
