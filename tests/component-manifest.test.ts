import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { makeNode, type DesignCommand } from '../src/shared/design';
import { getComponentManifest } from '../src/main/component-manifest';
import { getCodingBrief } from '../src/main/coding-brief';

function fixture() {
  const service = new DocumentService(':memory:');
  const { document } = service.read(),
    pageId = document.pages[0].id,
    documentId = document.id;
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
  const root = makeNode('frame');
  execute({ type: 'create', node: root });
  const scope = () => ({
    documentId,
    pageId,
    nodeId: root.id,
    expectedRevision: revision,
  });
  const instance = (text: string, x: number, visible = true) => {
    const frame = {
      ...makeNode('frame'),
      parentId: root.id,
      x,
      visible,
      source: {
        nodeId: `source-${x}`,
        componentId: 'component-1',
        type: 'INSTANCE',
      },
    };
    execute({ type: 'create', node: frame });
    const child = { ...makeNode('text'), parentId: frame.id, text };
    execute({ type: 'create', node: child });
    return { frame, child };
  };
  return { service, root, execute, scope, instance };
}
test('component handoff scopes visible instances, preserves local differences and ignores placement', () => {
  const f = fixture();
  try {
    const a = f.instance('Same', 0),
      b = f.instance('Same', 200);
    f.instance('Hidden', 400, false);
    const before = JSON.stringify(f.service.read());
    let manifest = getComponentManifest(f.service, f.scope());
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.equal(manifest.componentCount, 1);
    assert.equal(manifest.instanceCount, 2);
    assert.equal(manifest.components[0].distinctCurrentAppearances, 1);
    assert.equal(
      manifest.components[0].identity.documentId,
      f.scope().documentId,
    );
    assert.equal(manifest.components[0].identity.sourceFileKey, null);
    assert.equal(manifest.components[0].codeMapping, null);
    f.execute({
      type: 'update',
      id: b.child.id,
      patch: { text: 'Local edit' },
    });
    manifest = getComponentManifest(f.service, f.scope());
    assert.equal(manifest.components[0].distinctCurrentAppearances, 2);
    const instance = manifest.components[0].instances.find(
      (i) => i.nodeId === a.frame.id,
    )!;
    assert.equal(
      instance.context.arguments.expectedRevision,
      f.scope().expectedRevision,
    );
    assert.equal(instance.context.arguments.offset, 0);
    const focused = getComponentManifest(f.service, {
      ...f.scope(),
      nodeId: a.frame.id,
    });
    assert.equal(focused.instanceCount, 1);
    f.execute({ type: 'update', id: f.root.id, patch: { visible: false } });
    assert.equal(getComponentManifest(f.service, f.scope()).instanceCount, 0);
  } finally {
    f.service.close();
  }
});
test('structural siblings are explicit suggestions and retain distinct instance context', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const frame = { ...makeNode('frame'), parentId: f.root.id };
      f.execute({ type: 'create', node: frame });
      for (const type of ['rectangle', 'text'] as const)
        f.execute({
          type: 'create',
          node: { ...makeNode(type), parentId: frame.id, text: `Card ${i}` },
        });
    }
    const manifest = getComponentManifest(f.service, f.scope());
    assert.equal(manifest.componentCount, 0);
    assert.equal(manifest.repeatedPatterns.length, 1);
    const pattern = manifest.repeatedPatterns[0];
    assert.equal(pattern.verifiedComponent, false);
    assert.equal(pattern.instances.length, 2);
    assert.notEqual(pattern.instances[0].nodeId, pattern.instances[1].nodeId);
    const brief = getCodingBrief(f.service, f.scope());
    assert.equal(brief.componentHandoff.repeatedPatternCount, 1);
    assert.deepEqual(brief.componentHandoff.retrieve.arguments, f.scope());
    assert.throws(
      () =>
        getComponentManifest(f.service, { ...f.scope(), expectedRevision: 0 }),
      /newer|changed/,
    );
    assert.throws(() =>
      getComponentManifest(f.service, { ...f.scope(), nodeId: 'missing' }),
    );
  } finally {
    f.service.close();
  }
});
