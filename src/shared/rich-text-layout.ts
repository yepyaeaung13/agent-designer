import type { DesignNode } from './design';
import { styledText } from './text-runs';

export function layoutRichText(
  node: DesignNode,
  measure: (text: string, style: DesignNode) => number,
  natural = false,
) {
  const wrap =
    natural || node.textSizing === 'auto-width'
      ? 'none'
      : (node.textWrap ??
        (node.textSizing ||
        node.text.includes('\n') ||
        node.height >= (node.lineHeight ?? node.fontSize) * 1.5
          ? 'word'
          : 'none'));
  type Fragment = {
    text: string;
    node: DesignNode;
    decoration?: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const lines: { fragments: Fragment[]; width: number; height: number }[] = [];
  let line = {
    fragments: [] as Fragment[],
    width: 0,
    height: node.lineHeight ?? node.fontSize,
  };
  const finish = () => {
    lines.push(line);
    line = {
      fragments: [],
      width: 0,
      height: node.lineHeight ?? node.fontSize,
    };
  };
  let styleOffset = 0;
  const parts = styledText(node).map((part) => {
    const start = styleOffset;
    styleOffset += part.text.length;
    return { ...part, start, end: styleOffset };
  });
  const pieces =
    wrap === 'char'
      ? Array.from(node.text)
      : node.text.split(/(\n|[^\S\n]+|[^\s]+)/).filter(Boolean);
  let offset = 0;
  for (const text of pieces) {
    const start = offset;
    offset += text.length;
    if (text === '\n') {
      finish();
      continue;
    }
    const fragments = parts
      .filter((part) => part.end > start && part.start < offset)
      .map((part) => {
        const value = node.text.slice(
          Math.max(start, part.start),
          Math.min(offset, part.end),
        );
        return { ...part, text: value, width: measure(value, part.node) };
      });
    const width = fragments.reduce(
      (total, fragment) => total + fragment.width,
      0,
    );
    if (
      wrap !== 'none' &&
      line.fragments.length &&
      line.width + width > node.width &&
      !/^\s+$/.test(text)
    )
      finish();
    for (const fragment of fragments) {
      line.fragments.push({
        ...fragment,
        x: line.width,
        y: 0,
        height: fragment.node.lineHeight ?? fragment.node.fontSize,
      });
      line.width += fragment.width;
      line.height = Math.max(
        line.height,
        fragment.node.lineHeight ?? fragment.node.fontSize,
      );
    }
  }
  finish();
  let y = 0;
  const fragments: Fragment[] = [];
  for (const row of lines) {
    const x = natural
      ? 0
      : node.textAlign === 'center'
        ? (node.width - row.width) / 2
        : node.textAlign === 'right'
          ? node.width - row.width
          : 0;
    for (const fragment of row.fragments)
      fragments.push({
        ...fragment,
        x: fragment.x + x,
        y: y + (row.height - fragment.height) / 2,
      });
    y += row.height;
  }
  return {
    fragments,
    width: Math.max(0, ...lines.map((row) => row.width)),
    height: y,
  };
}
