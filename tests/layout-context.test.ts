import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentService } from '../src/main/document-service';
import { getLayoutContext } from '../src/main/layout-context';
import { getCodingBrief } from '../src/main/coding-brief';
import { makeNode, type DesignCommand } from '../src/shared/design';
const layout = {
  direction: 'horizontal' as const,
  gap: 12,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  align: 'CENTER',
  justify: 'MIN',
  widthMode: 'FIXED',
  heightMode: 'HUG',
  wrap: false,
};
function fixture() {
  const service = new DocumentService(':memory:'),
    { document } = service.read(),
    documentId = document.id,
    pageId = document.pages[0].id;
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
  const root = { ...makeNode('frame'), layout };
  execute({ type: 'create', node: root });
  const child = {
    ...makeNode('frame'),
    parentId: root.id,
    layout: {
      ...layout,
      direction: 'vertical' as const,
      widthMode: 'FILL',
      heightMode: 'FILL',
    },
  };
  execute({ type: 'create', node: child });
  const scope = () => ({
    documentId,
    pageId,
    nodeId: root.id,
    expectedRevision: revision,
  });
  return { service, execute, scope, root, child };
}
test('layout handoff translates only current neutral flex metadata and parent sizing', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.service.read());
    const result = getLayoutContext(f.service, f.scope());
    assert.equal(JSON.stringify(f.service.read()), before);
    assert.equal(result.totalFrames, 2);
    assert.equal(result.frames[0].cssHints.container.display, 'flex');
    assert.equal(result.frames[0].cssHints.container.gap, 12);
    assert.equal(result.frames[0].cssHints.container.alignItems, 'center');
    assert.equal(result.frames[0].cssHints.sizing.width, f.root.width);
    assert.equal(result.frames[1].cssHints.sizing.flexGrow, 1);
    assert.equal(result.frames[1].cssHints.sizing.alignSelf, 'stretch');
    assert.equal(result.frames[1].cssHints.verified, false);
    f.execute({
      type: 'update',
      id: f.root.id,
      patch: { layout: { ...layout, gap: 32 } },
    });
    assert.equal(
      getLayoutContext(f.service, f.scope()).frames[0].cssHints.container.gap,
      32,
    );
    const brief = getCodingBrief(f.service, f.scope());
    assert.equal(brief.layoutHandoff.autoLayoutFrames, 2);
    assert.equal(brief.layoutHandoff.retrieve.tool, 'get_layout_context');
  } finally {
    f.service.close();
  }
});
test('layout pagination excludes hidden ancestors and enforces exact scope/revision', () => {
  const f = fixture();
  try {
    const first = getLayoutContext(f.service, { ...f.scope(), limit: 1 });
    assert.equal(first.nextOffset, 1);
    const second = getLayoutContext(f.service, {
      ...f.scope(),
      offset: first.nextOffset,
      limit: 1,
    });
    assert.equal(second.frames[0].nodeId, f.child.id);
    assert.equal(second.nextOffset, null);
    assert.equal(
      getLayoutContext(f.service, { ...f.scope(), nodeId: f.child.id })
        .totalFrames,
      1,
    );
    assert.throws(
      () => getLayoutContext(f.service, { ...f.scope(), expectedRevision: 0 }),
      /changed/,
    );
    const { expectedRevision: _revision, ...withoutRevision } = f.scope();
    assert.throws(() => getLayoutContext(f.service, withoutRevision));
    assert.throws(() =>
      getLayoutContext(f.service, {
        ...f.scope(),
        pageId: crypto.randomUUID(),
      }),
    );
    f.execute({ type: 'update', id: f.root.id, patch: { visible: false } });
    assert.equal(getLayoutContext(f.service, f.scope()).totalFrames, 0);
  } finally {
    f.service.close();
  }
});
test('missing child metadata, non-flow geometry, overlap and unsafe enums remain explicit gaps', () => {
  const f = fixture();
  try {
    const text = { ...makeNode('text'), parentId: f.root.id, x: 500 };
    f.execute({ type: 'create', node: text });
    const result = getLayoutContext(f.service, f.scope());
    assert(result.frames[0].warnings.some((w) => w.includes('lack neutral')));
    assert(result.frames[0].warnings.some((w) => w.includes('differ')));
    f.execute({
      type: 'update',
      id: f.root.id,
      patch: {
        layout: {
          ...layout,
          gap: -10,
          align: 'constructor',
          justify: 'toString',
          widthMode: 'url(unsafe)',
        },
      },
    });
    const hints = getLayoutContext(f.service, f.scope()).frames[0];
    assert.equal(hints.cssHints.container.gap, undefined);
    assert.equal(hints.cssHints.container.alignItems, undefined);
    assert.equal(hints.cssHints.container.justifyContent, undefined);
    assert.equal(hints.cssHints.sizing.width, undefined);
    assert(hints.warnings.length >= 4);
  } finally {
    f.service.close();
  }
});
test('grid tracks and mobile breakpoints are not fabricated', () => {
  const f = fixture();
  try {
    f.execute({
      type: 'update',
      id: f.root.id,
      patch: { layout: { ...layout, direction: 'grid' } },
    });
    const result = getLayoutContext(f.service, f.scope());
    assert.deepEqual(result.frames[0].cssHints.container, {});
    assert(result.frames[0].warnings.some((w) => w.includes('track')));
    assert(
      result.frames[1].warnings.some((w) =>
        w.includes('without a flex parent'),
      ),
    );
    assert.equal(
      (result as unknown as Record<string, unknown>).breakpoints,
      undefined,
    );
  } finally {
    f.service.close();
  }
});
