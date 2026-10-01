import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { makeNode, type DesignCommand } from '../src/shared/design';
import { designBaseline, getDesignChanges } from '../src/main/design-changes';
import { getCodingBrief } from '../src/main/coding-brief';

function fixture(filename = ':memory:') {
  const service = new DocumentService(filename);
  const { document } = service.read();
  const pageId = document.pages[0].id,
    documentId = document.id;
  const parent = makeNode('frame'),
    root = { ...makeNode('frame'), parentId: parent.id };
  const child = { ...makeNode('text'), parentId: root.id, text: 'Before' },
    outside = makeNode('rectangle');
  let revision = document.revision;
  const execute = (command: DesignCommand) => {
    service.execute({
      documentId,
      pageId,
      expectedRevision: revision,
      command,
    });
    revision++;
  };
  for (const node of [parent, root, child, outside])
    execute({ type: 'create', node });
  const scope = () => ({
    documentId,
    pageId,
    nodeId: root.id,
    expectedRevision: revision,
  });
  return { service, root, parent, child, outside, execute, scope };
}

test('revision comparison ignores edits outside scope and detects text, geometry, assets and deletions', () => {
  const f = fixture();
  try {
    const baseline = getCodingBrief(f.service, f.scope()).changeTracking
      .baseline;
    f.execute({ type: 'update', id: f.outside.id, patch: { fill: '#123456' } });
    const unrelated = getDesignChanges(f.service, { ...f.scope(), baseline });
    assert.equal(unrelated.unchanged, true);
    assert(unrelated.toRevision > unrelated.fromRevision);
    f.execute({
      type: 'update',
      id: f.child.id,
      patch: { text: 'After', x: 40, assetId: 'a'.repeat(64) },
    });
    const changed = getDesignChanges(f.service, { ...f.scope(), baseline });
    assert.deepEqual(changed.layers.updated, [f.child.id]);
    assert.equal(changed.ancestorChanged, false);
    const added = { ...makeNode('rectangle'), parentId: f.root.id };
    f.execute({ type: 'create', node: added });
    f.execute({ type: 'delete', id: f.child.id });
    const structural = getDesignChanges(f.service, {
      ...f.scope(),
      baseline: changed.baseline,
    });
    assert.deepEqual(structural.layers.added, [added.id]);
    assert.deepEqual(structural.layers.removed, [f.child.id]);
    assert(
      structural.layers.updated.includes(f.root.id),
      'Parent paint order/child list changes',
    );
    const before = JSON.stringify(f.service.read());
    getDesignChanges(f.service, {
      ...f.scope(),
      baseline: structural.baseline,
    });
    assert.equal(JSON.stringify(f.service.read()), before);
  } finally {
    f.service.close();
  }
});

test('ancestor opacity changes and undo are reported without changing selected nodes', () => {
  const f = fixture();
  try {
    const baseline = designBaseline(f.service, f.scope());
    f.execute({ type: 'update', id: f.parent.id, patch: { opacity: 0.5 } });
    const result = getDesignChanges(f.service, { ...f.scope(), baseline });
    assert.equal(result.selectedChanged, false);
    assert.equal(result.ancestorChanged, true);
    assert.deepEqual(result.ancestors.updated, [f.parent.id]);
    f.execute({ type: 'undo' });
    assert.equal(
      getDesignChanges(f.service, { ...f.scope(), baseline }).unchanged,
      true,
    );
  } finally {
    f.service.close();
  }
});

test('comparisons reject stale revisions, mismatched scopes and malformed baselines', () => {
  const f = fixture();
  try {
    const scope = f.scope(),
      baseline = designBaseline(f.service, scope);
    assert.throws(
      () =>
        getDesignChanges(f.service, {
          ...scope,
          expectedRevision: 0,
          baseline,
        }),
      /newer/,
    );
    assert.throws(
      () =>
        getDesignChanges(f.service, {
          ...scope,
          baseline: { ...baseline, pageId: crypto.randomUUID() },
        }),
      /scope/,
    );
    assert.throws(
      () =>
        getDesignChanges(f.service, {
          ...scope,
          baseline: {
            ...baseline,
            nodes: [...baseline.nodes, baseline.nodes[0]],
          },
        }),
      /Duplicate/,
    );
    assert.throws(
      () =>
        getDesignChanges(f.service, {
          ...scope,
          baseline: { ...baseline, nodes: baseline.nodes.slice(1) },
        }),
      /root/,
    );
    f.execute({
      type: 'update',
      id: f.child.id,
      patch: { text: 'new revision' },
    });
    assert.throws(
      () => getDesignChanges(f.service, { ...scope, baseline }),
      /design changed/,
    );
  } finally {
    f.service.close();
  }
});

test('stored client baseline remains usable after SQLite close and reopen', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'design-changes-'));
  const f = fixture(join(folder, 'design.db'));
  const scope = f.scope(),
    baseline = JSON.parse(JSON.stringify(designBaseline(f.service, scope)));
  f.service.close();
  const reopened = new DocumentService(join(folder, 'design.db'));
  try {
    assert.equal(
      getDesignChanges(reopened, { ...scope, baseline }).unchanged,
      true,
    );
  } finally {
    reopened.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
