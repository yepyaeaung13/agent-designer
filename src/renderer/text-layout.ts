import type { DesignNode } from '../shared/design';
import Konva from 'konva';
// Saved geometry still controls selection and parent clipping. Text itself may
// overflow, like Figma text layers, rather than silently discarding whole lines.
export function textLayout(node: DesignNode) {
  const lineHeight = node.lineHeight ?? node.fontSize;
  const singleLine =
    !node.text.includes('\n') && node.height < lineHeight * 1.5;
  let x = 0;
  if (
    singleLine &&
    (node.textAlign === 'center' || node.textAlign === 'right')
  ) {
    const probe = new Konva.Text({
      text: node.text,
      fontSize: node.fontSize,
      fontFamily: `${node.fontFamily ?? 'Arial'}, Arial, sans-serif`,
      fontStyle: `${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`,
      letterSpacing: node.letterSpacing ?? 0,
    });
    x = (node.width - probe.width()) / (node.textAlign === 'center' ? 2 : 1);
    probe.destroy();
  }
  return {
    width: singleLine ? undefined : node.width,
    height: undefined,
    x,
    wrap: singleLine ? 'none' : 'word',
    lineHeight: lineHeight / node.fontSize,
  };
}
