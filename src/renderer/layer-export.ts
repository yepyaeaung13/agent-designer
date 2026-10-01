import { ensureFonts } from './font-manager';
import Konva from 'konva';
import type { DesignNode } from '../shared/design';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );

export function exportExtent(node: DesignNode) {
  const border = node.stroke ? (node.strokeWidth ?? 0) / 2 : 0;
  const s = node.shadow;
  const padding = Math.ceil(
    border +
      (s?.enabled
        ? s.blur * 2 + Math.max(Math.abs(s.x), Math.abs(s.y)) + 2
        : 0),
  );
  return {
    x: -padding,
    y: -padding,
    width: node.width + padding * 2,
    height: node.height + padding * 2,
  };
}

export async function exportSvg(
  root: DesignNode,
  nodes: DesignNode[],
  documentId: string,
  scale: number,
) {
  await ensureFonts();
  await document.fonts.ready;
  const definitions: string[] = [];
  const assets = new Map<string, string>();
  const measure = document.createElement('canvas').getContext('2d')!;
  const image = async (
    id: string,
    width: number,
    height: number,
    cover = false,
  ) => {
    if (!assets.has(id))
      assets.set(id, await window.designer.asset(documentId, id));
    return `<image width="${width}" height="${height}" href="${escape(assets.get(id)!)}" preserveAspectRatio="${cover ? 'xMidYMid slice' : 'none'}"/>`;
  };
  async function render(node: DesignNode, isRoot = false): Promise<string> {
    if (!node.visible) return '';
    const id = `n-${node.id}`;
    const w = node.width,
      h = node.height;
    const stroke =
      node.stroke && node.strokeWidth
        ? ` stroke="${node.stroke}" stroke-width="${node.strokeWidth}"`
        : '';
    const fill = `fill="${node.fill}" fill-opacity="${node.fillOpacity ?? 1}"`;
    let content = '';
    if (node.assetId) {
      content = await image(node.assetId, w, h);
      if (stroke)
        content += `<rect width="${w}" height="${h}" fill="none"${stroke}/>`;
    } else if (node.type === 'ellipse')
      content = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" ${fill}${stroke}/>`;
    else if (node.type === 'text') {
      const fontSize = node.fontSize,
        lineHeight = node.lineHeight ?? fontSize;
      measure.font = `${node.fontStyle ?? 'normal'} ${node.fontWeight ?? 400} ${fontSize}px "${(node.fontFamily ?? 'Arial').replace(/"/g, '')}"`;
      const lines: string[] = [];
      for (const paragraph of node.text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(/(?<=\s)/)) {
          const candidate = line + word;
          if (
            line &&
            measure.measureText(candidate).width +
              candidate.length * (node.letterSpacing ?? 0) >
              w
          ) {
            lines.push(line.trimEnd());
            line = word.trimStart();
          } else line = candidate;
        }
        lines.push(line);
      }
      definitions.push(
        `<clipPath id="${id}-text"><rect width="${w}" height="${h}"/></clipPath>`,
      );
      const align =
        node.textAlign === 'center'
          ? 'middle'
          : node.textAlign === 'right'
            ? 'end'
            : 'start';
      const x = align === 'middle' ? w / 2 : align === 'end' ? w : 0;
      content = `<text clip-path="url(#${id}-text)" ${fill}${stroke} font-family="${escape(node.fontFamily ?? 'Arial')}" font-size="${fontSize}" font-weight="${node.fontWeight ?? 400}" font-style="${node.fontStyle ?? 'normal'}" letter-spacing="${node.letterSpacing ?? 0}" text-anchor="${align}" xml:space="preserve">${lines.map((line, index) => `<tspan x="${x}" y="${(index + 0.5) * lineHeight}" dominant-baseline="central">${escape(line)}</tspan>`).join('')}</text>`;
    } else
      content = `<rect width="${w}" height="${h}" rx="${node.cornerRadius}" ${fill}${stroke}/>`;
    if (node.backgroundAssetId)
      content += await image(node.backgroundAssetId, w, h, true);
    if (node.type === 'frame') {
      let children = (
        await Promise.all(
          nodes
            .filter((child) => child.parentId === node.id)
            .map((child) => render(child)),
        )
      ).join('');
      if (node.clipsContent) {
        definitions.push(
          `<clipPath id="${id}-clip"><rect width="${w}" height="${h}" rx="${node.cornerRadius}"/></clipPath>`,
        );
        children = `<g clip-path="url(#${id}-clip)">${children}</g>`;
      }
      content += children;
    }
    let filter = '';
    if (node.shadow?.enabled) {
      const s = node.shadow;
      const pad = s.blur * 2 + Math.max(Math.abs(s.x), Math.abs(s.y)) + 2;
      definitions.push(
        `<filter id="${id}-shadow" filterUnits="userSpaceOnUse" x="${-pad}" y="${-pad}" width="${w + pad * 2}" height="${h + pad * 2}"><feDropShadow dx="${s.x}" dy="${s.y}" stdDeviation="${s.blur / 2}" flood-color="${s.color}" flood-opacity="${s.opacity}"/></filter>`,
      );
      filter = ` filter="url(#${id}-shadow)"`;
    }
    return `<g${isRoot ? '' : ` transform="translate(${node.x} ${node.y}) rotate(${node.rotation})"`} opacity="${node.opacity}"${filter}>${content}</g>`;
  }
  const content = await render(root, true);
  const bounds = exportExtent(root);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width * scale}" height="${bounds.height * scale}" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}"><defs>${definitions.join('')}</defs>${content}</svg>`;
}

export async function exportPng(
  stage: Konva.Stage,
  root: DesignNode,
  scale: number,
) {
  await ensureFonts();
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const selected = stage.findOne(`#${root.id}`);
  if (!selected) throw new Error('Select a visible layer to export.');
  const copy = selected.clone({
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  });
  try {
    const bounds = exportExtent(root);
    const width = Math.ceil(bounds.width * scale),
      height = Math.ceil(bounds.height * scale);
    if (width > 16384 || height > 16384 || width * height > 64000000)
      throw new Error(
        'Export is too large. Choose a lower scale or a smaller layer.',
      );
    return copy
      .toDataURL({ ...bounds, pixelRatio: scale })
      .replace(/^data:image\/png;base64,/, '');
  } finally {
    copy.destroy();
  }
}
