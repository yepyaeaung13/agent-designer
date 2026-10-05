import Konva from 'konva';
import { Group, Text } from 'react-konva';
import type { DesignNode } from '../shared/design';
import { layoutRichText } from '../shared/rich-text-layout';
import { canvasEffects } from './effect-controls';

export function richTextLayout(node: DesignNode, natural = false) {
  return layoutRichText(
    node,
    (text, style) => {
      const probe = new Konva.Text({ ...richTextProperties(style), text });
      const width = probe.width();
      probe.destroy();
      return width;
    },
    natural,
  );
}
export function richTextProperties(node: DesignNode) {
  return {
    fontFamily: `${node.fontFamily ?? 'Arial'}, Arial, sans-serif`,
    fontSize: node.fontSize,
    fontStyle: `${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`,
    letterSpacing: node.letterSpacing ?? 0,
    lineHeight: (node.lineHeight ?? node.fontSize) / node.fontSize,
    fill: node.fill,
    opacity: node.fillOpacity ?? 1,
    wrap: 'none' as const,
  };
}
export function richTextGroup(node: DesignNode) {
  const group = new Konva.Group({
    clipWidth: node.textSizing === 'fixed' ? node.width : undefined,
    clipHeight: node.textSizing === 'fixed' ? node.height : undefined,
  });
  for (const fragment of richTextLayout(node).fragments)
    group.add(
      new Konva.Text({
        ...canvasEffects(node),
        ...richTextProperties(fragment.node),
        text: fragment.text,
        x: fragment.x,
        y: fragment.y,
        textDecoration: fragment.decoration,
      }),
    );
  return group;
}
export function RichText({ node }: { node: DesignNode }) {
  return (
    <Group
      clipWidth={node.textSizing === 'fixed' ? node.width : undefined}
      clipHeight={node.textSizing === 'fixed' ? node.height : undefined}
    >
      {richTextLayout(node).fragments.map((fragment, index) => (
        <Text
          key={index}
          {...canvasEffects(node)}
          {...richTextProperties(fragment.node)}
          text={fragment.text}
          x={fragment.x}
          y={fragment.y}
          textDecoration={fragment.decoration}
        />
      ))}
    </Group>
  );
}
