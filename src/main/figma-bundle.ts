import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  flattenFigma,
  needsRender,
  normalizeFigma,
  type FigmaNode,
  type ImportAsset,
} from './figma-import';
import type { DocumentService } from './document-service';

export const bundleLimit = 100 * 1024 * 1024;
const key = z.string().min(1).max(256);
const schema = z
  .object({
    format: z.literal('agent-designer.figma-bundle'),
    version: z.literal(1),
    exportedAt: z.string().datetime(),
    fileKey: z
      .string()
      .regex(/^[a-zA-Z0-9]*$/)
      .max(256),
    entry: z.object({ document: z.unknown() }).passthrough(),
    preview: key,
    renders: z.record(key, key),
    images: z.record(key, key),
    warnings: z.array(z.string().max(1000)).max(200),
    assets: z
      .array(
        z
          .object({
            key,
            mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif']),
            base64: z.string().max(16 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(161),
  })
  .strict();

export function importFigmaBundle(service: DocumentService, bytes: Buffer) {
  if (bytes.length > bundleLimit)
    throw new Error('Export file exceeds 100 MB. Choose a smaller frame.');
  const bundle = schema.parse(JSON.parse(bytes.toString('utf8')));
  const root = bundle.entry.document as FigmaNode;
  const nodes = flattenFigma(root);
  const assets: ImportAsset[] = [];
  const keys = new Map<string, string>();
  let total = 0;
  for (const item of bundle.assets) {
    if (keys.has(item.key)) throw new Error('Duplicate asset key.');
    const data = Buffer.from(item.base64, 'base64');
    if (!data.length || data.toString('base64') !== item.base64)
      throw new Error('Invalid asset encoding.');
    total += data.length;
    if (data.length > 12 * 1024 * 1024 || total > 64 * 1024 * 1024)
      throw new Error('Export assets exceed the size limit.');
    const valid =
      item.mimeType === 'image/png'
        ? data
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : item.mimeType === 'image/jpeg'
          ? data[0] === 255 && data[1] === 216 && data[2] === 255
          : ['GIF87a', 'GIF89a'].includes(
              data.subarray(0, 6).toString('ascii'),
            );
    if (!valid) throw new Error('Asset content does not match its image type.');
    const id = createHash('sha256').update(data).digest('hex');
    keys.set(item.key, id);
    if (!assets.some((asset) => asset.id === id))
      assets.push({
        id,
        bytes: data,
        mimeType: item.mimeType,
        role: item.key === bundle.preview ? 'reference' : 'image',
      });
  }
  function resolve(value: string) {
    const id = keys.get(value);
    if (!id)
      throw new Error(
        'The export is missing an asset. Export the frame again.',
      );
    return id;
  }
  const renderAssets = Object.fromEntries(
    Object.entries(bundle.renders).map(([id, value]) => [id, resolve(value)]),
  );
  const imageAssets = Object.fromEntries(
    Object.entries(bundle.images).map(([id, value]) => [id, resolve(value)]),
  );
  for (const node of nodes) {
    if (needsRender(node) && !Object.hasOwn(renderAssets, node.id))
      throw new Error('The export is missing a rendered layer.');
    for (const paint of node.fills ?? []) {
      if (
        paint.visible !== false &&
        paint.imageRef &&
        !Object.hasOwn(imageAssets, paint.imageRef)
      )
        throw new Error('The export is missing a source image.');
    }
  }
  const document = normalizeFigma(
    root,
    {
      kind: 'figma',
      fileKey: bundle.fileKey,
      nodeId: root.id,
      url: bundle.fileKey
        ? `https://www.figma.com/design/${bundle.fileKey}?node-id=${encodeURIComponent(root.id)}`
        : '',
      version: `plugin-export:${bundle.exportedAt}`,
      importedAt: new Date().toISOString(),
      previewAssetId: resolve(bundle.preview),
      importedRevision: 0,
    },
    renderAssets,
    imageAssets,
  );
  document.source!.warnings.push(...bundle.warnings);
  return service.importDocument(
    document,
    {
      response: {
        name: root.name,
        version: document.source!.version,
        nodes: { [root.id]: bundle.entry },
      },
      renderAssets,
      imageAssets,
      transport: 'plugin',
    },
    assets,
  );
}
