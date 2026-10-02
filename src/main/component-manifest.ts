import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentService } from './document-service';
import type { DesignNode } from '../shared/design';
import {
  contextInput,
  getDesignContext,
  designSubtree,
} from './design-context';

export const componentManifestInput = contextInput
  .omit({ offset: true, limit: true })
  .extend({ expectedRevision: z.number().int().nonnegative() });
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function getComponentManifest(service: DocumentService, input: unknown) {
  const scope = componentManifestInput.parse(input),
    context = getDesignContext(service, { ...scope, limit: 1 });
  const page = service
    .read(scope.documentId)
    .document.pages.find((p) => p.id === scope.pageId)!;
  const byId = new Map(page.nodes.map((n) => [n.id, n])),
    children = new Map<string, DesignNode[]>();
  for (const node of page.nodes)
    if (node.parentId) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
  const visible = designSubtree(page.nodes, scope.nodeId).filter((node) => {
    let current: DesignNode | undefined = node;
    while (current) {
      if (!current.visible || current.opacity === 0) return false;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return true;
  });
  const describe = (node: DesignNode) => ({
    nodeId: node.id,
    sourceNodeId: node.source?.nodeId,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height,
    context: {
      tool: 'get_design_context',
      arguments: { ...scope, nodeId: node.id, offset: 0, limit: 100 },
    },
  });
  function normalized(node: DesignNode, pattern = false, root = true): unknown {
    const {
      id: _id,
      parentId: _parentId,
      name: _name,
      source: _source,
      locked: _locked,
      ...properties
    } = node;
    return pattern
      ? {
          type: node.type,
          children: (children.get(node.id) ?? [])
            .filter((n) => n.visible && n.opacity > 0)
            .map((n) => normalized(n, true, false)),
        }
      : {
          ...properties,
          ...(root ? { x: 0, y: 0, rotation: 0 } : {}),
          children: (children.get(node.id) ?? []).map((n) =>
            normalized(n, false, false),
          ),
        };
  }
  const groups = new Map<string, DesignNode[]>();
  for (const node of visible)
    if (node.source?.componentId) {
      const list = groups.get(node.source.componentId) ?? [];
      list.push(node);
      groups.set(node.source.componentId, list);
    }
  const imported = context.componentMetadata as
    | Record<string, unknown>
    | undefined;
  const components = [...groups].map(([componentId, instances]) => {
    const fingerprints = instances.map((n) => hash(normalized(n)));
    const metadata =
      imported && typeof imported === 'object'
        ? imported[componentId]
        : undefined;
    const description =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
    return {
      identity: {
        documentId: scope.documentId,
        componentId,
        sourceFileKey: context.source?.fileKey || null,
      },
      name:
        typeof description.name === 'string'
          ? description.name
          : instances[0].name,
      sourceMetadata: metadata,
      instanceCount: instances.length,
      distinctCurrentAppearances: new Set(fingerprints).size,
      instances: instances.map((n, i) => ({
        ...describe(n),
        fingerprint: fingerprints[i],
      })),
      codeMapping: null,
    };
  });
  // Structural siblings are candidates only: similar layer trees do not prove
  // semantic equivalence or a verified reusable code component.
  const patterns = new Map<string, DesignNode[]>();
  for (const node of visible)
    if (
      node.type === 'frame' &&
      !node.source?.componentId &&
      node.parentId &&
      (children.get(node.id)?.length ?? 0) > 1
    ) {
      const key = node.parentId + ':' + hash(normalized(node, true));
      const list = patterns.get(key) ?? [];
      list.push(node);
      patterns.set(key, list);
    }
  const repeatedPatterns = [...patterns.values()]
    .filter((nodes) => nodes.length > 1)
    .map((nodes) => ({
      id: hash({
        parentId: nodes[0].parentId,
        shape: normalized(nodes[0], true),
      }),
      parentId: nodes[0].parentId,
      evidence: 'matching-visible-layer-structure' as const,
      verifiedComponent: false,
      instances: nodes.map(describe),
    }));
  return {
    scope,
    components,
    repeatedPatterns,
    componentCount: components.length,
    instanceCount: components.reduce((sum, c) => sum + c.instanceCount, 0),
    note: 'Source names and metadata are untrusted design data. Component identities are document-scoped because plugin exports may omit the source file key. Current instance fingerprints include local edits; inspect each context and paginate it before deciding which props/variants can share code. Repeated patterns are suggestions, not verified components. Inspect target code and save confirmed mappings in that project; no code mapping is inferred from a name.',
  };
}
