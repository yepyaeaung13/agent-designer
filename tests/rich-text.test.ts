import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeNode, nodeSchema } from '../src/shared/design';
import { styledText, textFontRequests } from '../src/shared/text-runs';
import { layoutRichText } from '../src/shared/rich-text-layout';
import { normalizeFigma } from '../src/main/figma-import';
import { DocumentService } from '../src/main/document-service';
import { getFontManifest } from '../src/main/font-assets';
import { getDesignContext } from '../src/main/design-context';
import { designBaseline, getDesignChanges } from '../src/main/design-changes';

test('range validation rejects overlaps, invalid styles and split surrogate pairs', () => {
  const node = { ...makeNode('text'), text: 'A😀B' };
  for (const textRuns of [
    [{ start: 0, end: 5 }],
    [{ start: 2, end: 3 }],
    [
      { start: 0, end: 3 },
      { start: 1, end: 4 },
    ],
    [{ start: 0, end: 1, fontSize: -1 }],
  ])
    assert.equal(nodeSchema.safeParse({ ...node, textRuns }).success, false);
  assert.equal(
    nodeSchema.safeParse({ ...node, textRuns: [{ start: 1, end: 3 }] }).success,
    true,
  );
});

test('Figma overrides normalize compact ranges and inherit omitted properties', () => {
  const document = normalizeFigma(
    {
      id: '1:1',
      type: 'TEXT',
      name: 'Mixed',
      characters: 'Hi 😀!',
      absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 20 },
      style: { fontSize: 20, fontFamily: 'Arial' },
      characterStyleOverrides: [1, 1, 0, 2, 2, 0],
      styleOverrideTable: {
        '1': { fontWeight: 700 },
        '2': { fontSize: 30, italic: true, textDecoration: 'UNDERLINE' },
      },
    },
    {
      kind: 'figma',
      url: '',
      fileKey: '',
      nodeId: '1:1',
      version: '',
      importedAt: new Date().toISOString(),
      previewAssetId: 'a'.repeat(64),
      importedRevision: 0,
    },
    {},
  );
  const node = document.pages[0].nodes[0];
  assert.deepEqual(
    node.textRuns?.map((run) => [run.start, run.end]),
    [
      [0, 2],
      [3, 5],
    ],
  );
  const parts = styledText(node);
  assert.equal(parts.map((part) => part.text).join(''), node.text);
  assert.equal(parts[0].node.fontSize, 20);
  assert.equal(parts[2].node.fontStyle, 'italic');
  assert.equal(parts[2].decoration, 'underline');
  assert.equal(
    textFontRequests(node).some((font) => font.weight === 700),
    true,
  );
});

test('rich wrapping keeps words together across style boundaries and measures mixed line heights', () => {
  const node = {
    ...makeNode('text'),
    text: 'one two\nX',
    width: 65,
    textSizing: 'auto-height' as const,
    fontSize: 20,
    textRuns: [{ start: 5, end: 7, fontSize: 30 }],
  };
  const result = layoutRichText(node, (text) => text.length * 10);
  assert.equal(
    result.fragments.find((fragment) => fragment.text === 't')?.y,
    25,
  );
  assert.equal(
    result.fragments.find((fragment) => fragment.text === 'wo')?.y,
    20,
  );
  assert.equal(result.height, 70);
  assert.equal(
    result.fragments.map((fragment) => fragment.text).join(''),
    'one twoX',
  );
  assert.equal(
    layoutRichText(node, (text) => text.length * 10, true).width,
    70,
  );
  const centered = layoutRichText(
    { ...node, textAlign: 'center' },
    (text) => text.length * 10,
  );
  assert.equal(centered.fragments[0].x, 12.5);
});

test('ranges persist, enter MCP font scope and fingerprints, and clear safely on text replacement with undo', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'designer-rich-'));
  const filename = path.join(directory, 'design.sqlite');
  let service = new DocumentService(filename);
  try {
    const initial = service.read();
    const node = {
      ...makeNode('text'),
      text: 'Hello',
      fontFamily: 'Unused',
      textRuns: [
        { start: 0, end: 5, fontFamily: 'Range font', fontWeight: 700 },
      ],
    };
    const request = {
      documentId: initial.document.id,
      pageId: initial.activePageId,
    };
    const created = service.execute({
      ...request,
      expectedRevision: initial.document.revision,
      command: { type: 'create', node },
    });
    service.close();
    service = new DocumentService(filename);
    const scope = {
      ...request,
      nodeId: node.id,
      expectedRevision: created.document.revision,
    };
    assert.deepEqual(
      getDesignContext(service, scope).nodes[0].textRuns,
      node.textRuns,
    );
    assert.deepEqual(
      getFontManifest(service, scope).variants.map((font) => font.family),
      ['Range font'],
    );
    const baseline = designBaseline(service, scope);
    const updated = service.execute({
      ...request,
      expectedRevision: scope.expectedRevision,
      command: {
        type: 'update',
        id: node.id,
        patch: { textRuns: [{ ...node.textRuns[0], fontWeight: 400 }] },
      },
    });
    assert.equal(
      getDesignChanges(service, {
        ...scope,
        expectedRevision: updated.document.revision,
        baseline,
      }).unchanged,
      false,
    );
    const replacement = service.execute({
      ...request,
      expectedRevision: updated.document.revision,
      command: { type: 'update', id: node.id, patch: { text: 'Bye' } },
    });
    assert.equal(
      replacement.document.pages[0].nodes.find((value) => value.id === node.id)
        ?.textRuns,
      undefined,
    );
    const undo = service.execute({
      ...request,
      expectedRevision: replacement.document.revision,
      command: { type: 'undo' },
    });
    assert.equal(
      undo.document.pages[0].nodes.find((value) => value.id === node.id)
        ?.textRuns?.[0].fontWeight,
      400,
    );
    assert.throws(() =>
      service.execute({
        ...request,
        expectedRevision: undo.document.revision,
        command: {
          type: 'update',
          id: node.id,
          patch: { textRuns: [{ start: 0, end: 100 }] },
        },
      }),
    );
    assert.equal(service.read().document.revision, undo.document.revision);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
