import {
  fontStatusSchema,
  textOverflowSchema,
  type FontStatus,
  type TextOverflow,
} from '../shared/fonts';
import { z } from 'zod';
import { briefInput } from './coding-brief';
import { designSubtree } from './design-context';
import type { DocumentService } from './document-service';
import type { DesignNode } from '../shared/design';

export const previewInput = briefInput.extend({
  expectedRevision: z.number().int().nonnegative(),
  maxDimension: z.number().int().min(256).max(4096).default(2048),
});
export type PreviewRenderInput = {
  documentId: string;
  root: DesignNode;
  nodes: DesignNode[];
  bounds: { x: number; y: number; width: number; height: number };
  scale: number;
};
export type PreviewRenderer = (
  input: PreviewRenderInput,
) => Promise<
  string | { data: string; fonts: FontStatus[]; textOverflow?: TextOverflow[] }
>;

export async function getCurrentPreview(
  service: DocumentService,
  input: unknown,
  renderer?: PreviewRenderer,
) {
  const request = previewInput.parse(input);
  const { document } = service.read(request.documentId);
  const checkRevision = () => {
    if (
      service.read(request.documentId).document.revision !==
      request.expectedRevision
    )
      throw new Error(
        'The design changed. Read a new coding brief and restart context and preview retrieval.',
      );
  };
  checkRevision();
  const page = document.pages.find((page) => page.id === request.pageId);
  const root = page?.nodes.find((node) => node.id === request.nodeId);
  if (!page || !root) throw new Error('Node not found on this page.');
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  let ancestor: DesignNode | undefined = root;
  while (ancestor) {
    if (!ancestor.visible || ancestor.opacity === 0)
      throw new Error('The selected layer or one of its ancestors is hidden.');
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
  }
  if (!renderer)
    throw new Error(
      'Current preview renderer is unavailable. Keep the editor open and try again.',
    );
  const s = root.shadow;
  const padding = Math.ceil(
    (root.stroke ? (root.strokeWidth ?? 0) / 2 : 0) +
      (s?.enabled
        ? s.blur * 2 + Math.max(Math.abs(s.x), Math.abs(s.y)) + 2
        : 0),
  );
  const bounds = {
    x: -padding,
    y: -padding,
    width: root.width + padding * 2,
    height: root.height + padding * 2,
  };
  const scale = Math.min(
    1,
    request.maxDimension / Math.max(bounds.width, bounds.height),
  );
  const width = Math.ceil(bounds.width * scale),
    height = Math.ceil(bounds.height * scale);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendered:
    | string
    | { data: string; fonts: FontStatus[]; textOverflow?: TextOverflow[] };
  try {
    rendered = await Promise.race([
      renderer({
        documentId: document.id,
        root,
        nodes: designSubtree(page.nodes, root.id),
        bounds,
        scale,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Current preview timed out. Try a smaller frame.'),
            ),
          20000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  checkRevision();
  const data = typeof rendered === 'string' ? rendered : rendered.data;
  const fonts =
    typeof rendered === 'string'
      ? undefined
      : fontStatusSchema.array().parse(rendered.fonts);
  const textOverflow =
    typeof rendered === 'string'
      ? undefined
      : textOverflowSchema.array().parse(rendered.textOverflow ?? []);
  if (
    typeof data !== 'string' ||
    data.length > 32 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
  )
    throw new Error('Invalid preview data.');
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length < 24 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw new Error('Preview dimensions do not match the selected frame.');
  return {
    metadata: {
      kind: 'current-canvas',
      fonts,
      textOverflow,
      documentId: document.id,
      pageId: page.id,
      nodeId: root.id,
      revision: document.revision,
      name: root.name,
      mimeType: 'image/png',
      width,
      height,
      scale,
      bounds,
      coordinateSystem:
        'Selected-layer local coordinates, without editor zoom, pan, guides or selection handles. Root rotation is normalized like layer export.',
      generatedAt: new Date().toISOString(),
      warnings: [
        ...(textOverflow?.length
          ? [
              `${textOverflow.length} text layers exceed their saved height with the currently available fonts. Review font availability and text boxes.`,
            ]
          : []),
        ...(fonts?.some((font) => !['local', 'system'].includes(font.status))
          ? [
              'Some fonts are missing, could not load, or use another variant. Inspect fonts metadata; fallback affects wrapping and clipping.',
            ]
          : []),
        'This is the current neutral canvas appearance, not an original Figma render. Existing canvas limitations for fonts, mixed text, masks, layout and image cropping still apply.',
        ...(scale < 1
          ? [
              'The preview is downscaled; use context geometry for exact design dimensions.',
            ]
          : []),
      ],
    },
    data,
  };
}
