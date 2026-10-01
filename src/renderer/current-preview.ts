import { fontStack, resolveFonts, textOverflow } from './font-manager';
import Konva from 'konva';
import { canvasEffects } from './effect-controls';
import type { PreviewRenderInput } from '../main/current-preview';

// Render an immutable subtree separately from the interactive stage.
async function renderCurrentPreview(input: PreviewRenderInput) {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const visible = input.nodes.filter((node) => {
    let current: typeof node | undefined = node;
    while (current) {
      if (!current.visible || current.opacity === 0) return false;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return true;
  });
  const assetIds = new Set(
    visible.flatMap((node) =>
      [node.assetId, node.backgroundAssetId].filter((id): id is string =>
        Boolean(id),
      ),
    ),
  );
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(
    [...assetIds].map(async (id) => {
      const url = await window.designer.asset(input.documentId, id);
      const image = new Image();
      image.src = url;
      await image.decode();
      images.set(id, image);
    }),
  );
  const fonts = await resolveFonts(visible);
  await document.fonts.ready;
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-100000px;top:0;pointer-events:none';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);
  const stage = new Konva.Stage({
    container,
    width: Math.ceil(input.bounds.width * input.scale),
    height: Math.ceil(input.bounds.height * input.scale),
  });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);
  const children = new Map<string, typeof input.nodes>();
  for (const node of input.nodes)
    if (node.parentId) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
  function render(
    node: typeof input.root,
    parent: Konva.Container,
    isRoot = false,
  ) {
    if (!node.visible || node.opacity === 0) return;
    const outer = new Konva.Group({
      x: isRoot ? 0 : node.x,
      y: isRoot ? 0 : node.y,
      rotation: isRoot ? 0 : node.rotation,
      width: node.width,
      height: node.height,
      opacity: node.opacity,
      listening: false,
    });
    parent.add(outer);
    const content = new Konva.Group();
    outer.add(content);
    const effects = canvasEffects(node);
    const properties = {
      ...effects,
      shadowEnabled: node.type === 'frame' ? false : effects.shadowEnabled,
      width: node.width,
      height: node.height,
      fill: node.fill,
      opacity: node.fillOpacity ?? 1,
    };
    if (node.assetId)
      content.add(
        new Konva.Image({
          ...effects,
          width: node.width,
          height: node.height,
          image: images.get(node.assetId)!,
        }),
      );
    else if (node.type === 'ellipse')
      content.add(
        new Konva.Ellipse({
          ...properties,
          x: node.width / 2,
          y: node.height / 2,
          radiusX: node.width / 2,
          radiusY: node.height / 2,
        }),
      );
    else if (node.type === 'text')
      content.add(
        new Konva.Text({
          ...properties,
          text: node.text,
          fontSize: node.fontSize,
          fontFamily: fontStack(node.fontFamily),
          fontStyle: `${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`,
          lineHeight: node.lineHeight ? node.lineHeight / node.fontSize : 1,
          letterSpacing: node.letterSpacing ?? 0,
          align: node.textAlign ?? 'left',
        }),
      );
    else
      content.add(
        new Konva.Rect({ ...properties, cornerRadius: node.cornerRadius }),
      );
    if (node.backgroundAssetId) {
      const image = images.get(node.backgroundAssetId)!;
      const ratio = Math.max(
        node.width / image.width,
        node.height / image.height,
      );
      content.add(
        new Konva.Image({
          width: node.width,
          height: node.height,
          image,
          crop: {
            x: (image.width - node.width / ratio) / 2,
            y: (image.height - node.height / ratio) / 2,
            width: node.width / ratio,
            height: node.height / ratio,
          },
        }),
      );
    }
    if (node.type === 'frame') {
      const nested = new Konva.Group({
        clipWidth: node.clipsContent ? node.width : undefined,
        clipHeight: node.clipsContent ? node.height : undefined,
      });
      content.add(nested);
      for (const child of children.get(node.id) ?? []) render(child, nested);
      if (node.shadow?.enabled) {
        const shadow = node.shadow,
          extent = content.getClientRect({ skipTransform: true });
        if (extent.width && extent.height) {
          const pad = Math.ceil(
            shadow.blur * 2 +
              Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) +
              2,
          );
          const x = extent.x - pad,
            y = extent.y - pad,
            w = extent.width + pad * 2,
            h = extent.height + pad * 2,
            ratio = Math.min(1, 4096 / Math.max(w, h));
          const source = content.toCanvas({
            x,
            y,
            width: w,
            height: h,
            pixelRatio: ratio,
          });
          const canvas = document.createElement('canvas');
          canvas.width = source.width;
          canvas.height = source.height;
          const ctx = canvas.getContext('2d')!;
          ctx.shadowColor = shadow.color;
          ctx.shadowBlur = shadow.blur * ratio;
          ctx.shadowOffsetX = shadow.x * ratio;
          ctx.shadowOffsetY = shadow.y * ratio;
          ctx.drawImage(source, 0, 0);
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(source, 0, 0);
          const raster = new Konva.Image({
            image: canvas,
            x,
            y,
            width: w,
            height: h,
            opacity: shadow.opacity,
            listening: false,
          });
          outer.add(raster);
          raster.moveToBottom();
        }
      }
    }
  }
  try {
    render(input.root, layer, true);
    const data = layer.children[0]
      .toDataURL({
        ...input.bounds,
        width: Math.ceil(input.bounds.width * input.scale) / input.scale,
        height: Math.ceil(input.bounds.height * input.scale) / input.scale,
        pixelRatio: input.scale,
      })
      .replace(/^data:image\/png;base64,/, '');
    return { data, fonts, textOverflow: textOverflow(visible) };
  } finally {
    stage.destroy();
    container.remove();
  }
}
Object.assign(window, { __renderCurrentPreview: renderCurrentPreview });
