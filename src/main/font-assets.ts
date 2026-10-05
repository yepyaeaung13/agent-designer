import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  contextInput,
  designSubtree,
  getDesignContext,
} from './design-context';
import type { DocumentService } from './document-service';
import type { FontStore } from './font-store';
import { fontCovers, type FontRequest } from '../shared/fonts';
import { textFontRequests } from '../shared/text-runs';

export const fontManifestInput = contextInput
  .omit({ offset: true, limit: true })
  .extend({ expectedRevision: z.number().int().nonnegative() });
export const fontAssetInput = fontManifestInput.extend({
  fontId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedFontFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const fontMimeType = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
} as const;

export function getFontManifest(
  service: DocumentService,
  input: unknown,
  store?: FontStore,
) {
  const scope = fontManifestInput.parse(input);
  getDesignContext(service, { ...scope, limit: 1 });
  const page = service
    .read(scope.documentId)
    .document.pages.find((p) => p.id === scope.pageId)!;
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const requested = new Map<string, FontRequest>();
  for (const node of designSubtree(page.nodes, scope.nodeId)) {
    if (node.type !== 'text' || !node.text) continue;
    let current: typeof node | undefined = node,
      visible = true;
    while (current) {
      if (!current.visible || current.opacity === 0) {
        visible = false;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!visible) continue;
    for (const request of textFontRequests(node))
      requested.set(JSON.stringify(request), request);
  }
  const library = store?.list() ?? [];
  const variants = [...requested.values()].map((request) => {
    const matches = library.filter((f) => fontCovers(f, request));
    const font = matches.find((f) => !f.validationError) ?? matches[0];
    if (!font)
      return {
        ...request,
        status: 'unavailable' as const,
        message:
          'No matching local font file is available. Installed fonts are not exported.',
      };
    if (font.validationError)
      return {
        ...request,
        status: 'invalid' as const,
        message: font.validationError,
      };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(store!.data(font.id), 'base64');
    } catch {
      return {
        ...request,
        status: 'invalid' as const,
        message:
          'The local font file cannot be read. Reload it using Manage fonts.',
      };
    }
    return {
      ...request,
      status: 'available' as const,
      asset: {
        id: font.id,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        filename: `${font.id}.${font.format}`,
        mimeType: fontMimeType[font.format],
        byteLength: bytes.length,
        family: font.family,
        weight: font.weight,
        style: font.style,
        variationSettings: font.variationSettings,
      },
    };
  });
  // Library changes do not bump design revisions; a separate fingerprint binds
  // retrieved bytes and previews to the font state used by the coding brief.
  const families = new Set(
    [...requested.values()].map((f) => f.family.toLowerCase()),
  );
  const relatedFonts = library
    .filter((f) => families.has(f.family.toLowerCase()))
    .map((f) => ({
      id: f.id,
      weight: f.weight,
      style: f.style,
      error: f.validationError,
    }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ variants, relatedFonts }))
    .digest('hex');
  return {
    scope,
    fingerprint,
    variants: variants.map((variant) => ({
      ...variant,
      ...('asset' in variant
        ? {
            asset: {
              ...variant.asset,
              retrieve: {
                tool: 'get_font',
                arguments: {
                  ...scope,
                  fontId: variant.asset!.id,
                  expectedFontFingerprint: fingerprint,
                },
              },
            },
          }
        : {}),
    })),
    note: 'Only validated local files used by visible text in this scope are retrievable. Font library changes require a fresh brief even if the design revision is unchanged. Local availability does not grant font redistribution rights.',
  };
}

export function getFontAsset(
  service: DocumentService,
  input: unknown,
  store?: FontStore,
) {
  const request = fontAssetInput.parse(input);
  const manifest = getFontManifest(service, request, store);
  if (manifest.fingerprint !== request.expectedFontFingerprint)
    throw new Error(
      'The font library changed. Retrieve a new coding brief and font manifest.',
    );
  const variant = manifest.variants.find(
    (v) => 'asset' in v && v.asset?.id === request.fontId,
  );
  if (!variant || !('asset' in variant) || !variant.asset)
    throw new Error('Font is not available in the selected scope.');
  const bytes = Buffer.from(store!.data(request.fontId), 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== variant.asset.sha256)
    throw new Error('The font file changed during retrieval.');
  const asset = variant.asset;
  return {
    metadata: {
      ...asset,
      fontFingerprint: manifest.fingerprint,
      scope: manifest.scope,
    },
    data: bytes.toString('base64'),
  };
}
