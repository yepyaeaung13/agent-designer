import type { DesignNode } from '../shared/design';
import { recalculateAutoLayout } from '../shared/auto-layout';
import Konva from 'konva';
import { fontStack, resolveFonts } from './font-manager';

export async function recalculateLiveLayout(
  nodes: DesignNode[],
  previous: DesignNode[],
) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const measured = nodes.filter(
    (n) =>
      n.visible &&
      n.type === 'text' &&
      (n.layoutItem?.widthMode === 'HUG' ||
        n.layoutItem?.heightMode === 'HUG') &&
      n.layoutItem?.positioning === 'flow' &&
      n.parentId &&
      byId.get(n.parentId)?.layout?.enabled &&
      (() => {
        let parent = byId.get(n.parentId!);
        while (parent) {
          if (!parent.visible) return false;
          parent = parent.parentId ? byId.get(parent.parentId) : undefined;
        }
        return true;
      })(),
  );
  const fonts = await resolveFonts(measured);
  if (fonts.some((f) => f.status !== 'local' && f.status !== 'system'))
    throw Error(
      'Live text sizing needs the requested fonts. Load the missing font or choose an available family before recalculating.',
    );
  await document.fonts.ready;
  const cache = new Map<string, { width: number; height: number }>();
  recalculateAutoLayout(nodes, previous, (node, axis) => {
    const natural = axis === 'width';
    const key = JSON.stringify([
      node.text,
      node.width,
      node.fontFamily,
      node.fontWeight,
      node.fontStyle,
      node.fontSize,
      node.lineHeight,
      node.letterSpacing,
      natural,
    ]);
    const saved = cache.get(key);
    if (saved) return saved;
    const probe = new Konva.Text({
      text: node.text,
      width: natural ? undefined : node.width,
      wrap: natural ? 'none' : 'word',
      fontFamily: fontStack(node.fontFamily),
      fontStyle: `${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`,
      fontSize: node.fontSize,
      lineHeight: (node.lineHeight ?? node.fontSize) / node.fontSize,
      letterSpacing: node.letterSpacing ?? 0,
    });
    const result = { width: probe.width(), height: probe.height() };
    probe.destroy();
    cache.set(key, result);
    return result;
  });
  return nodes;
}
Object.assign(window, { __recalculateLiveLayout: recalculateLiveLayout });
