import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import {
  makeNode,
  type DesignNode,
  type DesignCommand,
} from '../src/shared/design';
import { recalculateAutoLayout } from '../src/shared/auto-layout';
const layout = {
  enabled: true,
  direction: 'horizontal' as const,
  gap: 10,
  padding: { top: 10, right: 10, bottom: 10, left: 10 },
  align: 'CENTER',
  justify: 'MIN',
  widthMode: 'FIXED',
  heightMode: 'FIXED',
  wrap: false,
};
function child(parentId: string, width = 50, height = 20): DesignNode {
  return {
    ...makeNode('rectangle'),
    parentId,
    width,
    height,
    x: 99,
    y: 88,
    layoutItem: {
      widthMode: 'FIXED',
      heightMode: 'FIXED',
      positioning: 'flow',
    },
  };
}
test('flow uses visible sibling order, opacity-zero spacing, padding and alignment; overlays stay out', () => {
  const root = { ...makeNode('frame'), width: 300, height: 100, layout },
    a = child(root.id),
    b = { ...child(root.id), opacity: 0 },
    hidden = { ...child(root.id), visible: false },
    overlay = {
      ...child(root.id),
      layoutItem: { positioning: 'absolute' as const },
    };
  const nodes = [root, a, hidden, b, overlay];
  recalculateAutoLayout(nodes);
  assert.equal(a.x, 10);
  assert.equal(a.y, 40);
  assert.equal(b.x, 70);
  assert.equal(hidden.x, 99);
  assert.equal(overlay.x, 99);
  const before = structuredClone(nodes);
  recalculateAutoLayout(nodes);
  assert.deepEqual(nodes, before);
});
test('fill distribution respects max limits, and absolute anchors follow parent resize once', () => {
  const root = { ...makeNode('frame'), width: 320, height: 100, layout },
    a = child(root.id),
    b = child(root.id),
    overlay = {
      ...child(root.id),
      x: 250,
      layoutItem: {
        positioning: 'absolute' as const,
        constraints: { horizontal: 'end' as const },
      },
    };
  a.layoutItem = {
    positioning: 'flow',
    widthMode: 'FILL',
    heightMode: 'FIXED',
    maxWidth: 60,
  };
  b.layoutItem = {
    positioning: 'flow',
    widthMode: 'FILL',
    heightMode: 'FIXED',
  };
  const nodes = [root, a, b, overlay],
    previous = structuredClone(nodes);
  root.width = 420;
  recalculateAutoLayout(nodes, previous);
  assert.equal(a.width, 60);
  assert.equal(b.width, 330);
  assert.equal(b.x, 80);
  assert.equal(overlay.x, 350);
  recalculateAutoLayout(nodes);
  assert.equal(overlay.x, 350);
});
test('wrapped rows hug height; nested vertical frames compute intrinsic child bounds', () => {
  const root = {
    ...makeNode('frame'),
    width: 200,
    height: 200,
    layout: { ...layout, wrap: true, heightMode: 'HUG', align: 'MIN' },
  };
  const nodes = [
    root,
    child(root.id, 80),
    child(root.id, 80),
    child(root.id, 80),
  ];
  recalculateAutoLayout(nodes);
  assert.equal(root.height, 70);
  assert.equal(nodes[3].y, 40);
  assert.equal(nodes[2].x, 100);
  const nested = {
    ...makeNode('frame'),
    parentId: root.id,
    width: 80,
    height: 200,
    layout: {
      ...layout,
      direction: 'vertical' as const,
      widthMode: 'HUG',
      heightMode: 'HUG',
    },
    layoutItem: { positioning: 'flow' as const },
  };
  const a = child(nested.id, 30, 25),
    b = child(nested.id, 40, 15);
  recalculateAutoLayout([nested, a, b]);
  assert.equal(nested.width, 60);
  assert.equal(nested.height, 70);
});
test('activation is explicit, edits reflow in one revision, and undo/redo restore exact geometry', () => {
  const service = new DocumentService(':memory:');
  try {
    const { document } = service.read(),
      pageId = document.pages[0].id;
    let revision = 0;
    const execute = (command: DesignCommand) => {
      const s = service.execute({
        documentId: document.id,
        pageId,
        expectedRevision: revision,
        command,
      });
      revision = s.document.revision;
      return s.document;
    };
    const root = {
        ...makeNode('frame'),
        width: 300,
        height: 100,
        layout: { ...layout, enabled: false },
      },
      a = child(root.id),
      b = child(root.id);
    execute({ type: 'create', node: root });
    execute({ type: 'create', node: a });
    execute({ type: 'create', node: b });
    assert.equal(
      service.read().document.pages[0].nodes.find((n) => n.id === a.id)!.x,
      99,
    );
    const enabled = execute({
      type: 'set_auto_layout',
      id: root.id,
      enabled: true,
    });
    assert.equal(enabled.pages[0].nodes.find((n) => n.id === b.id)!.x, 70);
    const changed = execute({ type: 'update', id: a.id, patch: { width: 80 } });
    assert.equal(changed.pages[0].nodes.find((n) => n.id === b.id)!.x, 100);
    const undone = execute({ type: 'undo' });
    assert.deepEqual(undone.pages, enabled.pages);
    const redone = execute({ type: 'redo' });
    assert.deepEqual(redone.pages, changed.pages);
    const stable = structuredClone(redone);
    assert.throws(() =>
      execute({
        type: 'update',
        id: root.id,
        patch: { layout: { ...layout, align: 'BASELINE' } },
      }),
    );
    assert.deepEqual(service.read().document.pages, stable.pages);
  } finally {
    service.close();
  }
});
test('unsupported cycles, unknown positioning and baseline alignment fail explicitly', () => {
  const root = {
      ...makeNode('frame'),
      layout: { ...layout, widthMode: 'HUG' },
    },
    a = child(root.id);
  a.layoutItem!.widthMode = 'FILL';
  assert.throws(() => recalculateAutoLayout([root, a]), /hug axis/);
  root.layout = { ...layout, align: 'BASELINE' };
  assert.throws(() => recalculateAutoLayout([root, a]), /alignment/);
  root.layout = layout;
  delete a.layoutItem;
  assert.throws(() => recalculateAutoLayout([root, a]), /positioning/);
});

test('unsupported min/max dimensions fail instead of silently violating bounds', () => {
  const root = { ...makeNode('frame'), layout },
    a = child(root.id);
  a.layoutItem!.maxWidth = 0.5;
  assert.throws(() => recalculateAutoLayout([root, a]), /constraints/);
  a.layoutItem!.maxWidth = undefined;
  a.layoutItem!.minWidth = 11000;
  assert.throws(() => recalculateAutoLayout([root, a]), /constraints/);
});
