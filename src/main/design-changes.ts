import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DocumentService } from './document-service';
import { designSubtree } from './design-context';
import type { DesignNode } from '../shared/design';

const scopeSchema = z.object({
  documentId: z.string().uuid(),
  pageId: z.string().uuid(),
  nodeId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
});
const entrySchema = z
  .object({ id: z.string().uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const baselineSchema = z
  .object({
    version: z.literal(1),
    documentId: z.string().uuid(),
    pageId: z.string().uuid(),
    nodeId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    nodes: z.array(entrySchema).min(1).max(2000),
    ancestors: z.array(entrySchema).max(2000),
  })
  .strict();
export const changesInput = scopeSchema
  .extend({ baseline: baselineSchema })
  .strict();

// Key order is not a design edit. Array order remains significant for paint order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function designBaseline(service: DocumentService, input: unknown) {
  const request = scopeSchema.parse(input);
  const { document } = service.read(request.documentId);
  if (document.revision !== request.expectedRevision)
    throw new Error(
      'The design changed. Retrieve a new brief and restart comparison.',
    );
  const page = document.pages.find((page) => page.id === request.pageId);
  const root = page?.nodes.find((node) => node.id === request.nodeId);
  if (!page || !root) throw new Error('Node not found on this page.');
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  const raw = service.getSource(document.id) as {
    imageAssets?: Record<string, string>;
  } | null;
  const fingerprint = (node: DesignNode, includeChildren: boolean) => ({
    id: node.id,
    hash: hash({
      ...node,
      ...(includeChildren
        ? {
            childIds: page.nodes
              .filter((child) => child.parentId === node.id)
              .map((child) => child.id),
          }
        : {}),
      resolvedImages: (node.source?.imageRefs ?? []).map(
        (ref) => raw?.imageAssets?.[ref] ?? null,
      ),
    }),
  });
  const ancestors: { id: string; hash: string }[] = [];
  let parent = root.parentId ? byId.get(root.parentId) : undefined;
  while (parent) {
    ancestors.push(fingerprint(parent, false));
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return {
    version: 1 as const,
    documentId: document.id,
    pageId: page.id,
    nodeId: root.id,
    revision: document.revision,
    nodes: designSubtree(page.nodes, root.id).map((node) =>
      fingerprint(node, true),
    ),
    ancestors,
  };
}

export function getDesignChanges(service: DocumentService, input: unknown) {
  const request = changesInput.parse(input),
    previous = request.baseline;
  for (const key of ['documentId', 'pageId', 'nodeId'] as const)
    if (request[key] !== previous[key])
      throw new Error('Baseline scope does not match the selected design.');
  if (previous.revision > request.expectedRevision)
    throw new Error('Baseline revision is newer than the requested design.');
  for (const entries of [previous.nodes, previous.ancestors])
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('Duplicate baseline layer IDs.');
  if (!previous.nodes.some((entry) => entry.id === request.nodeId))
    throw new Error('Baseline must include the selected root.');
  const current = designBaseline(service, request);
  const compare = (
    before: typeof current.nodes,
    after: typeof current.nodes,
  ) => {
    const old = new Map(before.map((entry) => [entry.id, entry.hash])),
      now = new Map(after.map((entry) => [entry.id, entry.hash]));
    return {
      added: after
        .filter((entry) => !old.has(entry.id))
        .map((entry) => entry.id),
      removed: before
        .filter((entry) => !now.has(entry.id))
        .map((entry) => entry.id),
      updated: after
        .filter(
          (entry) => old.has(entry.id) && old.get(entry.id) !== entry.hash,
        )
        .map((entry) => entry.id),
    };
  };
  const layers = compare(previous.nodes, current.nodes),
    ancestors = compare(previous.ancestors, current.ancestors);
  const selectedChanged = Object.values(layers).some((ids) => ids.length),
    ancestorChanged = Object.values(ancestors).some((ids) => ids.length);
  return {
    scope: {
      documentId: current.documentId,
      pageId: current.pageId,
      nodeId: current.nodeId,
      expectedRevision: current.revision,
    },
    fromRevision: previous.revision,
    toRevision: current.revision,
    selectedChanged,
    ancestorChanged,
    unchanged: !selectedChanged && !ancestorChanged,
    layers,
    ancestors,
    baseline: current,
    guidance: [
      'This compares client-supplied fingerprints, not server revision history or proof that code matches the design.',
      'Retrieve the complete current context and preview at this revision before editing code. Changed parent fingerprints can indicate child paint-order changes.',
      'Ancestor changes can affect visibility, opacity, clipping or placement; retrieve those ancestor scopes too.',
      'Preserve unrelated code and working controls. Save the returned baseline only after the implementation and verification succeed.',
    ],
  };
}
