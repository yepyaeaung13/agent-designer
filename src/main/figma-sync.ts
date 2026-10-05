import {
  documentSchema,
  nodeSchema,
  validateTree,
  type DesignNode,
} from '../shared/design';
import type { ExportConflict, ExportReview } from '../shared/figma-update';
import { normalizeFigma, type FigmaNode } from './figma-import';
import type { parseFigmaBundle } from './figma-bundle';
import type { DocumentService } from './document-service';

type Bundle = ReturnType<typeof parseFigmaBundle>;
type RawSource = {
  baseline?: { pageId: string; nodes: DesignNode[] };
  response?: { nodes?: Record<string, { document: FigmaNode }> };
  renderAssets?: Record<string, string>;
  imageAssets?: Record<string, string>;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function prepareExportUpdate(
  service: DocumentService,
  documentId: string,
  expectedRevision: number,
  bundle: Bundle,
  fileName: string,
) {
  const current = service.read(documentId).document;
  if (current.revision !== expectedRevision)
    throw new Error('The design changed. Review the export again.');
  const source = current.source!;
  const incomingSource = bundle.document.source!;
  if (!source) throw new Error('This document was not imported from Figma.');
  if (source.nodeId !== incomingSource.nodeId)
    throw new Error('Select an export of the same Figma frame.');
  if (
    source.fileKey &&
    incomingSource.fileKey &&
    source.fileKey !== incomingSource.fileKey
  )
    throw new Error('This export belongs to a different Figma file.');
  const raw = service.getSource(documentId) as RawSource | null;
  let baseline = raw?.baseline;
  if (!baseline) {
    const original = raw?.response?.nodes?.[source.nodeId]?.document;
    if (!original)
      throw new Error(
        'The original import is unavailable. Import this export as a new document.',
      );
    const normalized = normalizeFigma(
      original,
      source,
      raw?.renderAssets ?? {},
      raw?.imageAssets ?? {},
    );
    const candidates = current.pages.filter((page) =>
      page.nodes.some((node) => node.source?.nodeId === source.nodeId),
    );
    const page =
      candidates.length === 1
        ? candidates[0]
        : current.pages.length === 1
          ? current.pages[0]
          : undefined;
    if (!page)
      throw new Error(
        'The imported page cannot be identified. Import this export as a new document.',
      );
    baseline = { pageId: page.id, nodes: normalized.pages[0].nodes };
  }
  baseline = {
    pageId: baseline.pageId,
    nodes: baseline.nodes.map((node) => nodeSchema.parse(node)),
  };
  const page = current.pages.find((item) => item.id === baseline!.pageId)!;
  if (!page)
    throw new Error(
      'The imported page was deleted. Import this export as a new document.',
    );
  const base = baseline.nodes;
  const incoming = bundle.document.pages[0].nodes;
  const baseKeys = new Set(base.map((node) => node.source!.nodeId));
  const scopeIds = new Set(
    page.nodes
      .filter((node) => node.source && baseKeys.has(node.source.nodeId))
      .map((node) => node.id),
  );
  let size = -1;
  while (size !== scopeIds.size) {
    size = scopeIds.size;
    for (const node of page.nodes)
      if (node.parentId && scopeIds.has(node.parentId)) scopeIds.add(node.id);
  }
  const local = page.nodes.filter((node) => scopeIds.has(node.id));
  const key = (node: DesignNode) =>
    node.source ? `source:${node.source.nodeId}` : `local:${node.id}`;
  const map = (nodes: DesignNode[]) => {
    const result = new Map(nodes.map((node) => [key(node), node]));
    if (result.size !== nodes.length)
      throw new Error(
        'Duplicate source layer identities prevent a safe update.',
      );
    return result;
  };
  const baseMap = map(base),
    localMap = map(local),
    incomingMap = map(incoming);
  const topology = (nodes: DesignNode[]) => {
    const ids = new Map(nodes.map((node) => [node.id, key(node)]));
    return nodes.map((node) => ({
      key: key(node),
      parent: node.parentId
        ? (ids.get(node.parentId) ?? `external:${node.parentId}`)
        : null,
      type: node.type,
    }));
  };
  const properties = (node: DesignNode) => {
    const { id: _id, parentId: _parent, type: _type, ...rest } = node;
    return rest;
  };
  const baseTopology = topology(base),
    localTopology = topology(local),
    exportTopology = topology(incoming);
  const localStructureChanged = !equal(localTopology, baseTopology);
  const exportStructureChanged = !equal(exportTopology, baseTopology);
  const changedRemovedLayer = base.some(
    (node) =>
      !incomingMap.has(key(node)) &&
      localMap.has(key(node)) &&
      !equal(properties(node), properties(localMap.get(key(node))!)),
  );
  const changedDeletedLayer = base.some(
    (node) =>
      !localMap.has(key(node)) &&
      incomingMap.has(key(node)) &&
      !equal(properties(node), properties(incomingMap.get(key(node))!)),
  );
  const structuralConflict =
    changedDeletedLayer ||
    base.some((node) => {
      const saved = localMap.get(key(node)),
        exported = incomingMap.get(key(node));
      return (
        saved &&
        exported &&
        saved.type !== exported.type &&
        !equal(properties(node), properties(saved))
      );
    }) ||
    (exportStructureChanged &&
      ((localStructureChanged && !equal(localTopology, exportTopology)) ||
        changedRemovedLayer));
  const conflicts: ExportConflict[] = [];
  let currentKey = '';
  const conflict = (
    layerName: string,
    field: string,
    localValue: unknown,
    incomingValue: unknown,
    choices: Record<string, 'local' | 'export'>,
  ) => {
    const id = JSON.stringify([currentKey, field]);
    conflicts.push({
      id,
      layerName,
      field,
      local: localValue,
      incoming: incomingValue,
    });
    return choices[id] === 'export' ? incomingValue : localValue;
  };
  function build(choices: Record<string, 'local' | 'export'>) {
    conflicts.length = 0;
    currentKey = 'structure';
    let useExportStructure = exportStructureChanged && !localStructureChanged;
    if (structuralConflict)
      useExportStructure =
        conflict(
          incoming[0].name,
          'Layer hierarchy and order',
          'local',
          'export',
          choices,
        ) === 'export';
    else if (equal(localTopology, exportTopology)) useExportStructure = true;
    const tree = useExportStructure ? incoming : local;
    const ids = new Map(
      tree.map((node) => [
        key(node),
        localMap.get(key(node))?.id ?? baseMap.get(key(node))?.id ?? node.id,
      ]),
    );
    const treeById = new Map(tree.map((node) => [node.id, key(node)]));
    function merge(
      baseValue: unknown,
      localValue: unknown,
      incomingValue: unknown,
      field: string,
      name: string,
      atomic = false,
    ): unknown {
      if (equal(localValue, incomingValue) || equal(incomingValue, baseValue))
        return localValue;
      if (equal(localValue, baseValue)) return incomingValue;
      if (
        !atomic &&
        plain(baseValue) &&
        plain(localValue) &&
        plain(incomingValue)
      ) {
        const result: Record<string, unknown> = {};
        for (const key of new Set([
          ...Object.keys(baseValue),
          ...Object.keys(localValue),
          ...Object.keys(incomingValue),
        ])) {
          const value = merge(
            baseValue[key],
            localValue[key],
            incomingValue[key],
            `${field}.${key}`,
            name,
          );
          if (value !== undefined) result[key] = value;
        }
        return result;
      }
      return conflict(name, field, localValue, incomingValue, choices);
    }
    const merged = tree.map((node) => {
      const nodeKey = key(node);
      currentKey = nodeKey;
      const original = baseMap.get(nodeKey),
        saved = localMap.get(nodeKey),
        exported = incomingMap.get(nodeKey);
      let result = structuredClone(node);
      if (original && saved && exported && saved.type === exported.type) {
        // Text and its UTF-16 ranges must be selected together.
        const content = merge(
          { text: original.text, textRuns: original.textRuns },
          { text: saved.text, textRuns: saved.textRuns },
          { text: exported.text, textRuns: exported.textRuns },
          'Text and styled ranges',
          node.name,
          true,
        ) as { text: string; textRuns?: DesignNode['textRuns'] };
        const values: Record<string, unknown> = {};
        for (const field of new Set([
          ...Object.keys(properties(original)),
          ...Object.keys(properties(saved)),
          ...Object.keys(properties(exported)),
        ])) {
          if (field === 'text' || field === 'textRuns') continue;
          const value = merge(
            (original as unknown as Record<string, unknown>)[field],
            (saved as unknown as Record<string, unknown>)[field],
            (exported as unknown as Record<string, unknown>)[field],
            field,
            node.name,
          );
          if (value !== undefined) values[field] = value;
        }
        result = {
          ...values,
          ...content,
          id: node.id,
          parentId: node.parentId,
          type: node.type,
        } as DesignNode;
      } else if (
        !original &&
        saved &&
        exported &&
        !equal(properties(saved), properties(exported))
      ) {
        result = structuredClone(
          conflict(
            node.name,
            'Added layer',
            saved,
            exported,
            choices,
          ) as DesignNode,
        );
      }
      result.id = ids.get(nodeKey)!;
      result.parentId = node.parentId
        ? (ids.get(treeById.get(node.parentId)!) ?? node.parentId)
        : null;
      return result;
    });
    const next = structuredClone(current);
    const target = next.pages.find((item) => item.id === page.id)!;
    const first = page.nodes.findIndex((node) => scopeIds.has(node.id));
    const others = target.nodes.filter((node) => !scopeIds.has(node.id));
    others.splice(first < 0 ? others.length : first, 0, ...merged);
    target.nodes = others;
    next.revision++;
    const retainedEdits =
      !equal(
        merged.map((node) => ({ ...properties(node), type: node.type })),
        incoming.map((node) => ({ ...properties(node), type: node.type })),
      ) || !equal(topology(merged), exportTopology);
    next.source = {
      ...incomingSource,
      fileKey: source.fileKey || incomingSource.fileKey,
      url: incomingSource.url || source.url,
      importedRevision: retainedEdits ? expectedRevision : next.revision,
    };
    const parsed = documentSchema.parse(next);
    validateTree(parsed);
    return parsed;
  }
  build({});
  const review: ExportReview = {
    reviewId: crypto.randomUUID(),
    documentId,
    expectedRevision,
    documentName: current.name,
    frameName: incoming[0].name,
    fileName,
    identityVerified: !!source.fileKey && !!incomingSource.fileKey,
    added: incoming.filter((node) => !baseMap.has(key(node))).length,
    removed: base.filter((node) => !incomingMap.has(key(node))).length,
    updated: incoming.filter(
      (node) =>
        baseMap.has(key(node)) &&
        !equal(properties(node), properties(baseMap.get(key(node))!)),
    ).length,
    conflicts: structuredClone(conflicts),
  };
  const conflictIds = new Set(review.conflicts.map((item) => item.id));
  return {
    review,
    resolve(
      choices: Record<string, 'local' | 'export'>,
      confirmUnverifiedSource: boolean,
    ) {
      if (!review.identityVerified && !confirmUnverifiedSource)
        throw new Error('Confirm this export is from the same Figma file.');
      if (Object.keys(choices).some((id) => !conflictIds.has(id)))
        throw new Error('Unknown export conflict.');
      return {
        document: build(choices),
        raw: {
          ...bundle.raw,
          imageAssets: { ...raw?.imageAssets, ...bundle.raw.imageAssets },
          baseline: {
            pageId: page.id,
            nodes: incoming.map((node) => {
              const parent = incoming.find((item) => item.id === node.parentId);
              const stableId = (item: DesignNode) =>
                localMap.get(key(item))?.id ??
                baseMap.get(key(item))?.id ??
                item.id;
              return {
                ...node,
                id: stableId(node),
                parentId: parent ? stableId(parent) : null,
              };
            }),
          },
        },
        assets: bundle.assets,
      };
    },
  };
}
