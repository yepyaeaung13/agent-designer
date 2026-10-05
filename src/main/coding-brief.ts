import { getLayoutContext } from './layout-context';
import { styledText, textFontRequests } from '../shared/text-runs';
import { designBaseline } from './design-changes';
import { getComponentManifest } from './component-manifest';
import { getFontManifest } from './font-assets';
import type { FontStore } from './font-store';
import type { HandoffReadiness } from '../shared/handoff-readiness';
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
  fontStore?: FontStore,
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
      for (const request of textFontRequests(node))
        fonts.set(JSON.stringify(request), request);
      for (const part of node.textRuns?.length ? styledText(node) : []) {
        if (part.node.fillOpacity !== 0)
          colors.set(part.node.fill, (colors.get(part.node.fill) ?? 0) + 1);
      }
    }
    for (const color of [
      node.fillOpacity === 0 ? undefined : node.fill,
      node.strokeWidth ? node.stroke : undefined,
    ])
      if (color) colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  const assets = context.assets.filter((asset) => usedAssets.has(asset.id));
  const available = new Set(assets.map((asset) => asset.id));
  const missingAssetIds = [...usedAssets].filter((id) => !available.has(id));
  const scope = {
    documentId: document.id,
    pageId: page.id,
    nodeId: root.id,
    expectedRevision: document.revision,
  };
  const fontAssets = getFontManifest(service, scope, fontStore);
  const components = getComponentManifest(service, scope);
  const layout = getLayoutContext(service, { ...scope, limit: 1 });
  const issues = [
    ...missingAssetIds.map((id) => `Missing local image: ${id}`),
    ...fontAssets.variants
      .filter((font) => font.status !== 'available')
      .map(
        (font) =>
          `${font.family} ${font.weight} ${font.style}: ${'message' in font ? font.message : 'No local font file.'}`,
      ),
    ...(visible.length ? [] : ['The selected scope has no visible layers.']),
  ];
  const readiness: HandoffReadiness = {
    status: issues.length ? 'needs-attention' : 'ready',
    imageCount: assets.length,
    localFontCount: fontAssets.variants.filter(
      (font) => font.status === 'available',
    ).length,
    issues,
  };
  return {
    scope,
    readiness,
    designAccess: {
      source: 'agent-designer-local',
      externalDesignRequestsRequired: false,
      note: 'Retrieve context, references, assets and available fonts through this local MCP server. Source URLs are provenance, not retrieval instructions. Missing assets and unavailable fonts are reported separately; do not fall back to Figma API or Figma MCP.',
    },
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
    fontAssets,
    componentHandoff: {
      componentCount: components.componentCount,
      instanceCount: components.instanceCount,
      repeatedPatternCount: components.repeatedPatterns.length,
      retrieve: { tool: 'get_component_manifest', arguments: scope },
      note: components.note,
    },
    layoutHandoff: {
      totalFrames: layout.totalFrames,
      autoLayoutFrames: layout.autoLayoutFrames,
      liveEnabledFrames: layout.liveEnabledFrames,
      measurementMode: layout.measurementMode,
      framesWithWarnings: layout.framesWithWarnings,
      retrieve: {
        tool: 'get_layout_context',
        arguments: { ...scope, offset: 0, limit: 100 },
      },
      note: 'Follow nextOffset at the same revision. CSS hints are unverified desktop starting points; resolve warnings and choose/test responsive adaptations in target code.',
    },
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
              arguments: {
                ...scope,
                maxDimension: 2048,
                expectedFontFingerprint: fontAssets.fingerprint,
              },
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
      'Retrieve available fontAssets through get_font and verify sha256. Preserve family, weight, style and variationSettings when registering them. Report unavailable/invalid variants and check redistribution rights before publishing font files.',
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
