import { importedLayoutItem, importedGrid } from './layout-item-import';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { textRunSchema, type TextRun } from '../shared/text-runs';
import {
  makeNode,
  type DesignDocument,
  type DesignNode,
} from '../shared/design';
import type { DocumentService } from './document-service';
import { downloadFigmaAsset, rateLimitMessage } from './figma-network';

type Bounds = { x: number; y: number; width: number; height: number };
type Paint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  imageRef?: string;
};
export type FigmaNode = {
  id: string;
  type: string;
  name: string;
  children?: FigmaNode[];
  absoluteBoundingBox?: Bounds;
  relativeTransform?: number[][];
  size?: { x: number; y: number };
  fills?: Paint[];
  strokes?: Paint[];
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    italic?: boolean;
    lineHeightPx?: number;
    letterSpacing?: number;
    textAlignHorizontal?: string;
  };
  characters?: string;
  textAutoResize?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  cornerRadius?: number;
  strokeWeight?: number;
  clipsContent?: boolean;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  counterAxisAlignItems?: string;
  primaryAxisAlignItems?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutWrap?: string;
  componentId?: string;
  effects?: {
    type: string;
    visible?: boolean;
    radius?: number;
    offset?: { x: number; y: number };
    color?: { r: number; g: number; b: number; a?: number };
  }[];
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<
    string,
    NonNullable<FigmaNode['style']> & {
      fills?: Paint[];
      textDecoration?: string;
    }
  >;
  [key: string]: unknown;
};
export type ImportAsset = {
  id: string;
  mimeType: string;
  bytes: Buffer;
  role: string;
};
export const importInput = z
  .object({
    url: z.string().max(2048),
    token: z.string().trim().min(1).max(1024),
  })
  .strict();
export function parseFigmaUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Paste a Figma frame link, including node-id.');
  }
  const match = url.pathname.match(
    /^\/(?:design|file)\/([a-zA-Z0-9]+)(?:\/|$)/,
  );
  const nodeId = url.searchParams.get('node-id')?.replace(/-/g, ':');
  if (
    url.protocol !== 'https:' ||
    !['www.figma.com', 'figma.com'].includes(url.hostname) ||
    !match ||
    !nodeId ||
    !/^\d+:\d+$/.test(nodeId)
  )
    throw new Error(
      'Use an https://www.figma.com/design/… frame link with node-id.',
    );
  return {
    fileKey: match[1],
    nodeId,
    url: `https://www.figma.com/design/${match[1]}?node-id=${nodeId.replace(':', '-')}`,
  };
}
function color(paint?: Paint) {
  const value = paint?.color;
  return value
    ? '#' +
        [value.r, value.g, value.b]
          .map((part) =>
            Math.round(Math.max(0, Math.min(1, part)) * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('')
    : '#000000';
}
export function flattenFigma(root: FigmaNode): FigmaNode[] {
  const nodes: FigmaNode[] = [];
  const ids = new Set<string>();
  function visit(node: FigmaNode, depth: number) {
    if (
      !node ||
      typeof node.id !== 'string' ||
      typeof node.type !== 'string' ||
      typeof node.name !== 'string'
    )
      throw new Error('Figma returned an invalid node.');
    if (ids.has(node.id)) throw new Error('Duplicate Figma node ID.');
    if (depth > 64 || nodes.length >= 2000)
      throw new Error(
        'Choose a smaller frame (up to 2,000 layers and 64 nesting levels).',
      );
    ids.add(node.id);
    nodes.push(node);
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  visit(root, 0);
  return nodes;
}
const containers = new Set([
  'FRAME',
  'GROUP',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'SECTION',
]);
export function needsRender(node: FigmaNode) {
  if (containers.has(node.type)) return false;
  return (
    !['TEXT', 'RECTANGLE', 'ELLIPSE'].includes(node.type) ||
    (node.fills ?? []).some(
      (paint) => paint.visible !== false && paint.type !== 'SOLID',
    ) ||
    (node.fills ?? []).filter((paint) => paint.visible !== false).length > 1
  );
}
export function normalizeFigma(
  root: FigmaNode,
  source: Omit<NonNullable<DesignDocument['source']>, 'warnings'>,
  renderAssets: Record<string, string>,
  imageAssets: Record<string, string> = {},
) {
  const sourceNodes = flattenFigma(root);
  const ids = new Map(
    sourceNodes.map((node) => [node.id, crypto.randomUUID()]),
  );
  const nodes: DesignNode[] = [];
  const warnings = new Set<string>();
  warnings.add(
    'The canvas uses imported positions. Auto-layout rules are preserved for coding but are not recalculated by the editor.',
  );
  warnings.add(
    'Fonts are not downloaded. Install the source fonts locally for an accurate editable canvas. The Figma reference preserves the original appearance.',
  );
  function visit(raw: FigmaNode, parent: FigmaNode | null) {
    const box = raw.absoluteBoundingBox;
    if (!box)
      throw new Error(
        `Layer ${raw.name} has no geometry; select a visual frame.`,
      );
    const container = containers.has(raw.type);
    const type = container
      ? 'frame'
      : needsRender(raw)
        ? 'image'
        : raw.type === 'TEXT'
          ? 'text'
          : raw.type === 'RECTANGLE'
            ? 'rectangle'
            : raw.type === 'ELLIPSE'
              ? 'ellipse'
              : 'image';
    const paint = raw.fills?.find((item) => item.visible !== false);
    const stroke = raw.strokes?.find(
      (item) => item.visible !== false && item.type === 'SOLID',
    );
    const transform = raw.relativeTransform;
    const rotation = transform
      ? (Math.atan2(transform[1][0], transform[0][0]) * 180) / Math.PI
      : 0;
    const parentBox = parent?.absoluteBoundingBox;
    const shadow = !renderAssets[raw.id]
      ? raw.effects?.find(
          (effect) => effect.type === 'DROP_SHADOW' && effect.visible !== false,
        )
      : undefined;
    const node: DesignNode = {
      ...makeNode(type),
      id: ids.get(raw.id)!,
      parentId: parent ? ids.get(parent.id)! : null,
      name: raw.name.trim().slice(0, 120) || raw.type,
      x: parent ? (transform?.[0]?.[2] ?? box.x - (parentBox?.x ?? 0)) : 80,
      y: parent ? (transform?.[1]?.[2] ?? box.y - (parentBox?.y ?? 0)) : 80,
      width: Math.max(1, raw.size?.x ?? box.width),
      height: Math.max(1, raw.size?.y ?? box.height),
      rotation,
      fill: color(paint),
      fillOpacity:
        paint?.type === 'SOLID'
          ? (paint.opacity ?? 1) * (paint.color?.a ?? 1)
          : 0,
      opacity: raw.opacity ?? 1,
      // Figma uses large radii (e.g. 9999) for pills. Store the equivalent
      // visible radius; preserve the original value in the source document.
      cornerRadius: Math.max(
        0,
        Math.min(
          raw.cornerRadius ?? 0,
          Math.max(1, raw.size?.x ?? box.width) / 2,
          Math.max(1, raw.size?.y ?? box.height) / 2,
        ),
      ),
      text: raw.characters ?? '',
      ...(raw.type === 'TEXT' &&
      ['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE', 'TRUNCATE'].includes(
        raw.textAutoResize ?? '',
      )
        ? {
            textSizing: (raw.textAutoResize === 'WIDTH_AND_HEIGHT'
              ? 'auto-width'
              : raw.textAutoResize === 'HEIGHT'
                ? 'auto-height'
                : 'fixed') as DesignNode['textSizing'],
            textWrap: (raw.textAutoResize === 'WIDTH_AND_HEIGHT'
              ? 'none'
              : 'word') as DesignNode['textWrap'],
          }
        : {}),
      fontSize: raw.style?.fontSize ?? 16,
      fontFamily: raw.style?.fontFamily,
      fontWeight: raw.style?.fontWeight,
      fontStyle: raw.style?.italic ? 'italic' : 'normal',
      lineHeight:
        raw.style?.lineHeightPx && raw.style.lineHeightPx > 0
          ? raw.style.lineHeightPx
          : undefined,
      letterSpacing: raw.style?.letterSpacing,
      textAlign: (raw.style?.textAlignHorizontal === 'JUSTIFIED'
        ? 'justify'
        : (raw.style?.textAlignHorizontal?.toLowerCase() ??
          'left')) as DesignNode['textAlign'],
      visible: raw.visible !== false,
      locked: raw.locked ?? false,
      stroke: stroke ? color(stroke) : undefined,
      strokeWidth: stroke ? (raw.strokeWeight ?? 1) : undefined,
      shadow: shadow
        ? {
            enabled: true,
            color: color({ type: 'SOLID', color: shadow.color }),
            opacity: shadow.color?.a ?? 1,
            blur: Math.min(500, Math.max(0, shadow.radius ?? 0)),
            x: Math.max(-5000, Math.min(5000, shadow.offset?.x ?? 0)),
            y: Math.max(-5000, Math.min(5000, shadow.offset?.y ?? 0)),
          }
        : undefined,
      clipsContent: raw.clipsContent ?? false,
      assetId: renderAssets[raw.id],
      backgroundAssetId:
        container &&
        raw.fills?.some((item) => item.visible !== false && item.imageRef)
          ? imageAssets[
              raw.fills.find((item) => item.visible !== false && item.imageRef)!
                .imageRef!
            ]
          : undefined,
      source: {
        nodeId: raw.id,
        type: raw.type,
        componentId: raw.componentId,
        imageRefs: raw.fills?.flatMap((item) =>
          item.imageRef ? [item.imageRef] : [],
        ),
      },
      layoutItem: importedLayoutItem(raw, parent, type === 'frame'),
      layout: container
        ? {
            grid: importedGrid(raw),
            direction:
              raw.layoutMode === 'HORIZONTAL'
                ? 'horizontal'
                : raw.layoutMode === 'VERTICAL'
                  ? 'vertical'
                  : raw.layoutMode === 'GRID'
                    ? 'grid'
                    : 'none',
            gap: raw.itemSpacing ?? 0,
            padding: {
              top: raw.paddingTop ?? 0,
              right: raw.paddingRight ?? 0,
              bottom: raw.paddingBottom ?? 0,
              left: raw.paddingLeft ?? 0,
            },
            align: raw.counterAxisAlignItems ?? 'MIN',
            justify: raw.primaryAxisAlignItems ?? 'MIN',
            widthMode: raw.layoutSizingHorizontal ?? 'FIXED',
            heightMode: raw.layoutSizingVertical ?? 'FIXED',
            wrap: raw.layoutWrap === 'WRAP',
          }
        : undefined,
    };
    if (type === 'text' && raw.characterStyleOverrides) {
      const runs: TextRun[] = [];
      let offset = 0;
      for (const character of node.text) {
        const start = offset;
        offset += character.length;
        const key = raw.characterStyleOverrides[start] ?? 0;
        if (!key) continue;
        const style = raw.styleOverrideTable?.[String(key)];
        if (!style) {
          warnings.add(`${raw.name}: a text style override is unavailable.`);
          continue;
        }
        const fill = style.fills?.find(
          (p) => p.visible !== false && p.type === 'SOLID',
        );
        const parsed = textRunSchema.safeParse({
          start,
          end: offset,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          fontStyle:
            style.italic === undefined
              ? undefined
              : style.italic
                ? 'italic'
                : 'normal',
          lineHeight:
            style.lineHeightPx && style.lineHeightPx > 0
              ? style.lineHeightPx
              : undefined,
          letterSpacing: style.letterSpacing,
          ...(fill
            ? {
                fill: color(fill),
                fillOpacity: (fill.opacity ?? 1) * (fill.color?.a ?? 1),
              }
            : {}),
          decoration:
            style.textDecoration === 'UNDERLINE'
              ? 'underline'
              : style.textDecoration === 'STRIKETHROUGH'
                ? 'line-through'
                : undefined,
        });
        if (!parsed.success) {
          warnings.add(
            `${raw.name}: an invalid text style override was skipped.`,
          );
          continue;
        }
        const last = runs[runs.length - 1];
        const {
          start: _ignoredStart,
          end: _ignoredEnd,
          ...properties
        } = parsed.data;
        const {
          start: _previousStart,
          end: _previousEnd,
          ...previousProperties
        } = last ?? {};
        if (
          last &&
          last.end === start &&
          JSON.stringify(properties) === JSON.stringify(previousProperties)
        )
          last.end = offset;
        else runs.push(parsed.data);
      }
      if (runs.length) node.textRuns = runs;
    }
    if (needsRender(raw)) {
      warnings.add(
        `${raw.name}: complex appearance is shown using a saved Figma export; source properties remain available to the agent.`,
      );
      if (!node.assetId && raw.visible !== false)
        warnings.add(
          `${raw.name}: no render was available; consult the source reference.`,
        );
    }
    if (
      (raw.effects?.length ?? 0) ||
      raw.isMask ||
      raw.rectangleCornerRadii ||
      raw.characterStyleOverrides?.some((value) => value !== 0)
    )
      warnings.add(
        `${raw.name}: effects, masks, individual corners or mixed text styling may differ on the editable canvas; original properties are retained.`,
      );
    if (container && (raw.fills ?? []).some((item) => item.type !== 'SOLID'))
      warnings.add(
        `${raw.name}: complex frame background is retained in source data and the reference preview.`,
      );
    nodes.push(node);
    if (container) for (const child of raw.children ?? []) visit(child, raw);
    else if (raw.children?.length)
      warnings.add(
        `${raw.name}: this subtree is a visual asset; its full structure is retained in source data.`,
      );
  }
  visit(root, null);
  const document: DesignDocument = {
    schemaVersion: 3,
    id: crypto.randomUUID(),
    name: root.name.trim().slice(0, 120) || 'Figma import',
    revision: 0,
    pages: [{ id: crypto.randomUUID(), name: 'Imported frame', nodes }],
    source: { ...source, warnings: [...warnings] },
  };
  return document;
}

export type Fetcher = typeof fetch;
function allowedAsset(url: URL) {
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (!url.port || url.port === '443') &&
    (url.hostname === 'figma.com' ||
      url.hostname.endsWith('.figma.com') ||
      /^figma-alpha-api\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
        url.hostname,
      ))
  );
}
async function bounded(response: Response, limit: number) {
  if (Number(response.headers.get('content-length') ?? 0) > limit)
    throw new Error('Figma response is too large. Choose a smaller frame.');
  if (!response.body) throw new Error('Figma returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw new Error('Figma response is too large. Choose a smaller frame.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export class FigmaImporter {
  private retryCache?: {
    key: string;
    expires: number;
    api: Map<string, Record<string, any>>;
    downloads: Map<string, Buffer>;
  };
  constructor(
    private service: DocumentService,
    private fetcher: Fetcher = fetch,
  ) {}
  async import(input: unknown) {
    const { url, token } = importInput.parse(input);
    const target = parseFigmaUrl(url);
    const key = createHash('sha256')
      .update(token)
      .update(target.url)
      .digest('hex');
    if (
      !this.retryCache ||
      this.retryCache.key !== key ||
      this.retryCache.expires < Date.now()
    )
      this.retryCache = {
        key,
        expires: Date.now() + 5 * 60 * 1000,
        api: new Map(),
        downloads: new Map(),
      };
    const cache = this.retryCache;
    const api = async (pathname: string) => {
      const cached = cache.api.get(pathname);
      if (cached) return cached;
      let response: Response;
      try {
        response = await this.fetcher(`https://api.figma.com/v1/${pathname}`, {
          headers: { 'X-Figma-Token': token },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw new Error(
          'Cannot reach Figma. Check your connection and try again.',
        );
      }
      if (!response.ok) {
        if (response.status === 429)
          throw new Error(
            rateLimitMessage(response.headers.get('retry-after')),
          );
        if (response.status === 401 || response.status === 403)
          throw new Error(
            'Figma denied access. Check the token, file permissions, and file_content:read scope.',
          );
        throw new Error(
          `Figma request failed (${response.status}). Check the frame link.`,
        );
      }
      const data = JSON.parse(
        (await bounded(response, 32 * 1024 * 1024)).toString(),
      ) as Record<string, any>;
      cache.api.set(pathname, data);
      return data;
    };
    const response = await api(
      `files/${target.fileKey}/nodes?ids=${encodeURIComponent(target.nodeId)}&geometry=paths`,
    );
    const entry = response.nodes?.[target.nodeId];
    const root = entry?.document as FigmaNode | undefined;
    if (!root || !containers.has(root.type))
      throw new Error(
        'Select a frame, group, or component and copy its Figma link.',
      );
    const all = flattenFigma(root);
    const assets: ImportAsset[] = [];
    let totalBytes = 0;
    const download = async (address: string, role: string) => {
      const bytes =
        cache.downloads.get(address) ??
        (await downloadFigmaAsset(address, this.fetcher, allowedAsset));
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024)
        throw new Error('Assets exceed 64 MB. Choose a smaller frame.');
      cache.downloads.set(address, bytes);
      const isPng = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const isSvg = /<(?:svg)(?:\s|>)/i.test(
        bytes.subarray(0, 2048).toString(),
      );
      const mimeType = isPng
        ? 'image/png'
        : isJpeg
          ? 'image/jpeg'
          : isSvg
            ? 'image/svg+xml'
            : '';
      if (!mimeType)
        throw new Error('Unsupported image format returned by Figma.');
      if (
        isSvg &&
        /<!DOCTYPE|<!ENTITY|<script|<foreignObject|\bon\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|file:)/i.test(
          bytes.toString(),
        )
      )
        throw new Error('Figma SVG contains external or active content.');
      const id = createHash('sha256').update(bytes).digest('hex');
      if (!assets.some((item) => item.id === id))
        assets.push({ id, bytes, mimeType, role });
      return id;
    };
    const version = String(response.version ?? '');
    const versionQuery = version
      ? `&version=${encodeURIComponent(version)}`
      : '';
    const renderable = all.filter(
      (node) => needsRender(node) && node.visible !== false,
    );
    if (renderable.length > 80)
      throw new Error(
        'Choose a frame with fewer than 80 complex visual layers.',
      );
    const vectorTypes = new Set([
      'VECTOR',
      'BOOLEAN_OPERATION',
      'LINE',
      'REGULAR_POLYGON',
      'STAR',
    ]);
    const pngIds = [
      target.nodeId,
      ...renderable
        .filter((node) => !vectorTypes.has(node.type))
        .map((node) => node.id),
    ];
    const preview = await api(
      `images/${target.fileKey}?ids=${encodeURIComponent(pngIds.join(','))}&format=png&scale=1&use_absolute_bounds=true${versionQuery}`,
    );
    const previewUrl = preview.images?.[target.nodeId];
    if (typeof previewUrl !== 'string')
      throw new Error(
        'Figma could not render this frame. Choose a visible frame.',
      );
    const previewAssetId = await download(previewUrl, 'reference');
    const renderAssets: Record<string, string> = {};
    for (const format of ['png', 'svg'] as const) {
      const batch = renderable.filter(
        (node) =>
          ([
            'VECTOR',
            'BOOLEAN_OPERATION',
            'LINE',
            'REGULAR_POLYGON',
            'STAR',
          ].includes(node.type)
            ? 'svg'
            : 'png') === format,
      );
      if (!batch.length) continue;
      const exported =
        format === 'png'
          ? preview
          : await api(
              `images/${target.fileKey}?ids=${encodeURIComponent(batch.map((node) => node.id).join(','))}&format=${format}&use_absolute_bounds=true${versionQuery}`,
            );
      for (const node of batch)
        if (typeof exported.images?.[node.id] === 'string')
          renderAssets[node.id] = await download(
            exported.images[node.id],
            format === 'svg' ? 'vector' : 'layer',
          );
    }
    const imageRefs = [
      ...new Set(
        all.flatMap((node) =>
          (node.fills ?? []).flatMap((paint) =>
            paint.imageRef ? [paint.imageRef] : [],
          ),
        ),
      ),
    ];
    if (imageRefs.length > 80)
      throw new Error('Choose a frame with fewer than 80 source images.');
    const imageAssets: Record<string, string> = {};
    const extraWarnings: string[] = [];
    if (imageRefs.length) {
      const images = await api(`files/${target.fileKey}/images`);
      for (const ref of imageRefs) {
        const address = images.meta?.images?.[ref];
        if (typeof address === 'string')
          imageAssets[ref] = await download(address, 'image');
        else
          extraWarnings.push(
            `Source image ${ref} was unavailable; use its saved layer export where available.`,
          );
      }
    }
    const document = normalizeFigma(
      root,
      {
        kind: 'figma',
        ...target,
        version,
        importedAt: new Date().toISOString(),
        previewAssetId,
        importedRevision: 0,
      },
      renderAssets,
      imageAssets,
    );
    document.source!.warnings.push(...extraWarnings);
    const snapshot = this.service.importDocument(
      document,
      { response, imageAssets, renderAssets },
      assets,
    );
    this.retryCache = undefined;
    return snapshot;
  }
}
