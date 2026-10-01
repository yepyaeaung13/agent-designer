import { designBaseline } from './design-changes';
import type { DocumentService } from './document-service';
import {
  contextInput,
  designSubtree,
  getDesignContext,
} from './design-context';

export const briefInput = contextInput.omit({ offset: true, limit: true });

export function getCodingBrief(
  service: DocumentService,
  input: unknown,
  currentPreviewAvailable = false,
) {
  const request = briefInput.parse(input);
  const context = getDesignContext(service, {
    ...request,
    offset: 0,
    limit: 1,
  });
  const { document } = service.read(request.documentId);
  const page = document.pages.find((item) => item.id === request.pageId)!;
  const root = page.nodes.find((item) => item.id === request.nodeId)!;
  const subtree = designSubtree(page.nodes, root.id);
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  // A visible child of a hidden ancestor is still hidden in the rendered design.
  const visible = subtree.filter((node) => {
    let current = node;
    for (;;) {
      if (!current.visible || current.opacity === 0) return false;
      if (!current.parentId) return true;
      const parent = byId.get(current.parentId);
      if (!parent) return false;
      current = parent;
    }
  });
  const usedAssets = new Set<string>();
  const fonts = new Map<
    string,
    { family: string; weight: number; style: string }
  >();
  const colors = new Map<string, number>();
  for (const node of visible) {
    for (const id of [node.assetId, node.backgroundAssetId])
      if (id) usedAssets.add(id);
    for (const ref of node.source?.imageRefs ?? []) {
      const id = context.imageRefToAssetId[ref];
      if (id) usedAssets.add(id);
    }
    if (node.type === 'text') {
      const font = {
        family: node.fontFamily ?? 'Arial',
        weight: node.fontWeight ?? 400,
        style: node.fontStyle ?? 'normal',
      };
      fonts.set(JSON.stringify(font), font);
    }
    for (const color of [
      node.fillOpacity === 0 ? undefined : node.fill,
      node.strokeWidth ? node.stroke : undefined,
    ])
      if (color) colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  const assets = context.assets.filter(
    (asset) => usedAssets.has(asset.id) && asset.role !== 'reference',
  );
  const available = new Set(assets.map((asset) => asset.id));
  const missingAssetIds = [...usedAssets].filter((id) => !available.has(id));
  const scope = {
    documentId: document.id,
    pageId: page.id,
    nodeId: root.id,
    expectedRevision: document.revision,
  };
  return {
    scope,
    changeTracking: {
      baseline: designBaseline(service, scope),
      tool: 'get_design_changes',
      note: 'Save this baseline with the code after successful verification. On the next handoff compare it against the new expectedRevision; it is a fingerprint manifest, not historical node values.',
    },
    documentName: document.name,
    pageName: page.name,
    selection: {
      name: root.name,
      type: root.type,
      width: root.width,
      height: root.height,
      sourceNodeId: root.source?.nodeId,
    },
    layerCount: subtree.length,
    visibleLayerCount: visible.length,
    hiddenLayerCount: subtree.length - visible.length,
    sections: visible
      .filter((node) => node.parentId === root.id)
      .map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      })),
    fonts: [...fonts.values()],
    colors: [...colors]
      .sort((a, b) => b[1] - a[1])
      .map(([value, layerUses]) => ({ value, layerUses })),
    assets: assets.map((asset) => ({
      ...asset,
      retrieve: {
        tool: 'get_asset',
        arguments: { documentId: document.id, assetId: asset.id },
      },
    })),
    missingAssetIds,
    currentPreview: {
      available: currentPreviewAvailable,
      kind: 'current-canvas',
      revision: document.revision,
      ...(currentPreviewAvailable
        ? {
            retrieve: {
              tool: 'get_current_preview',
              arguments: { ...scope, maxDimension: 2048 },
            },
          }
        : {}),
      note: 'Current neutral canvas appearance with local edits. Canvas fidelity limits still apply; original Figma evidence remains separate.',
    },
    preview: {
      available: Boolean(document.source),
      kind: 'imported-full-frame-reference',
      stale: context.referenceIsStale,
      sourceNodeId: document.source?.nodeId,
      matchesSelectedSourceNode: Boolean(
        root.source &&
        document.source &&
        root.source.nodeId === document.source.nodeId,
      ),
      ...(document.source
        ? {
            retrieve: {
              tool: 'get_preview',
              arguments: { documentId: document.id },
            },
          }
        : {}),
    },
    warnings: [
      ...(document.source?.warnings ?? []),
      ...(context.referenceIsStale
        ? [
            'The reference predates local edits. Current node fields are authoritative; do not copy stale geometry or text from the reference.',
          ]
        : []),
      ...(!document.source
        ? [
            'No imported visual reference is available for this design. Verify against current node context.',
          ]
        : []),
      ...(missingAssetIds.length
        ? [
            'Some visible layers reference missing assets. Report them rather than substituting unrelated imagery.',
          ]
        : []),
      'Font families are design requirements, not bundled font files. Check font availability and licensing in the target project.',
      'Auto-layout and component metadata do not imply a live layout engine or verified code component mappings.',
    ],
    context: {
      tool: 'get_design_context',
      arguments: { ...scope, offset: 0, limit: 100 },
      paginate: 'Follow nextOffset at expectedRevision until null.',
    },
    guidance: context.guidance,
    acceptance: [
      'Implement the selected scope with semantic, responsive UI; preserve hierarchy, typography and supplied imagery.',
      'Inspect existing project conventions and reuse appropriate components.',
      'Retrieve all context pages at the same revision and all required local assets.',
      'Validate desktop and mobile layout, input behavior and image loading; run project checks.',
      'Retrieve the current preview at the same revision as context. Compare implementation screenshots to it for local edits; retain the original Figma reference separately for source fidelity.',
      'Report missing interactions, unsupported features and font substitutions without pretending they are implemented.',
    ],
  };
}
