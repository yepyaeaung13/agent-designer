import { layoutItemSchema } from './layout-item';
import { gridSchema } from './grid';
import { textRunSchema } from './text-runs';
import type { FontImport, LocalFont } from './fonts';
import type { ExportReview } from './figma-update';
import { z } from 'zod';

const nodeBaseSchema = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    type: z.enum(['frame', 'rectangle', 'ellipse', 'text', 'image']),
    name: z.string().trim().min(1).max(120),
    x: z.number().finite().min(-100000).max(100000),
    y: z.number().finite().min(-100000).max(100000),
    width: z.number().finite().min(1).max(10000),
    height: z.number().finite().min(1).max(10000),
    rotation: z.number().finite().min(-360).max(360),
    fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    opacity: z.number().min(0).max(1),
    cornerRadius: z.number().min(0).max(5000),
    text: z.string().max(10000),
    fontSize: z.number().min(1).max(500),
    visible: z.boolean(),
    locked: z.boolean(),
    fontFamily: z.string().max(200).optional(),
    fontWeight: z.number().min(1).max(1000).optional(),
    fontStyle: z.enum(['normal', 'italic']).optional(),
    lineHeight: z.number().positive().optional(),
    letterSpacing: z.number().finite().optional(),
    textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
    textSizing: z.enum(['auto-width', 'auto-height', 'fixed']).optional(),
    textWrap: z.enum(['none', 'word', 'char']).optional(),
    textRuns: z.array(textRunSchema).max(10000).optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    stroke: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    strokeWidth: z.number().nonnegative().optional(),
    shadow: z
      .object({
        enabled: z.boolean(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        opacity: z.number().min(0).max(1),
        blur: z.number().min(0).max(500),
        x: z.number().min(-5000).max(5000),
        y: z.number().min(-5000).max(5000),
      })
      .strict()
      .optional(),
    clipsContent: z.boolean().optional(),
    assetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    backgroundAssetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    layoutItem: layoutItemSchema.optional(),
    layout: z
      .object({
        enabled: z.boolean().optional(),
        grid: gridSchema.optional(),
        direction: z.enum(['none', 'horizontal', 'vertical', 'grid']),
        gap: z.number(),
        padding: z.object({
          top: z.number(),
          right: z.number(),
          bottom: z.number(),
          left: z.number(),
        }),
        align: z.string(),
        justify: z.string(),
        widthMode: z.string(),
        heightMode: z.string(),
        wrap: z.boolean(),
      })
      .optional(),
    source: z
      .object({
        nodeId: z.string(),
        type: z.string(),
        componentId: z.string().optional(),
        imageRefs: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();
export const nodeSchema = nodeBaseSchema.superRefine((node, context) => {
  let end = 0;
  for (const run of node.textRuns ?? []) {
    const splitSurrogate = (index: number) =>
      index > 0 &&
      index < node.text.length &&
      /[\uD800-\uDBFF]/.test(node.text[index - 1]) &&
      /[\uDC00-\uDFFF]/.test(node.text[index]);
    if (
      node.type !== 'text' ||
      run.start < end ||
      run.end <= run.start ||
      run.end > node.text.length ||
      splitSurrogate(run.start) ||
      splitSurrogate(run.end)
    )
      context.addIssue({
        code: 'custom',
        message:
          'Text runs must be ordered, non-overlapping UTF-16 ranges within a text layer.',
        path: ['textRuns'],
      });
    end = run.end;
  }
});

export type DesignNode = z.infer<typeof nodeSchema>;
export const legacyDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    name: z.string().min(1).max(120),
    revision: z.number().int().nonnegative(),
    nodes: z.array(nodeSchema).max(2000),
  })
  .strict();
export const pageSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    nodes: z.array(nodeSchema).max(2000),
  })
  .strict();
export const documentSchema = z
  .object({
    schemaVersion: z.literal(3),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    revision: z.number().int().nonnegative(),
    pages: z.array(pageSchema).min(1).max(100),
    source: z
      .object({
        kind: z.literal('figma'),
        url: z.string(),
        fileKey: z.string(),
        nodeId: z.string(),
        version: z.string(),
        importedAt: z.string(),
        previewAssetId: z.string(),
        importedRevision: z.number().int(),
        warnings: z.array(z.string()),
      })
      .optional(),
  })
  .strict();
export type DesignDocument = z.infer<typeof documentSchema>;
export const patchSchema = nodeBaseSchema
  .omit({ id: true, parentId: true, type: true })
  .partial();
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), node: nodeSchema }),
  z.object({
    type: z.literal('update'),
    id: z.string().uuid(),
    patch: patchSchema,
  }),
  z.object({ type: z.literal('delete'), id: z.string().uuid() }),
  z.object({
    type: z.literal('set_auto_layout'),
    id: z.string().uuid(),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal('recover_layout_metadata'),
    id: z.string().uuid(),
  }),
  z.object({
    type: z.literal('rename'),
    name: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
  z.object({
    type: z.literal('create_page'),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal('rename_page'),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
  }),
  z.object({ type: z.literal('delete_page'), id: z.string().uuid() }),
]);
export type DesignCommand = z.infer<typeof commandSchema>;
export const requestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    documentId: z.string().uuid(),
    pageId: z.string().uuid().optional(),
    command: commandSchema,
  })
  .strict();
export type CommandRequest = z.infer<typeof requestSchema>;
export const workspaceActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_document'),
    name: z.string().trim().min(1).max(120),
    activate: z.boolean().default(false),
  }),
  z.object({ type: z.literal('open_document'), id: z.string().uuid() }),
  z.object({
    type: z.literal('delete_document'),
    id: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('open_page'),
    documentId: z.string().uuid(),
    pageId: z.string().uuid(),
  }),
]);
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export type DocumentSummary = {
  id: string;
  name: string;
  revision: number;
  pageCount: number;
  nodeCount: number;
};
export type Snapshot = {
  document: DesignDocument;
  documents: DocumentSummary[];
  activeDocumentId: string;
  activePageId: string;
  sequence: number;
  canUndo: boolean;
  canRedo: boolean;
};
export type ConnectionInfo = {
  url: string | null;
  token: string | null;
  databasePath: string;
  error?: string;
};
export interface DesignerApi {
  handoffReadiness(
    input: import('./handoff-readiness').HandoffScope,
  ): Promise<import('./handoff-readiness').HandoffReadiness>;
  listFonts(): Promise<LocalFont[]>;
  fontData(id: string): Promise<string>;
  importFont(input: FontImport): Promise<LocalFont | null>;
  removeFont(id: string): Promise<void>;
  saveExport(input: {
    name: string;
    format: 'png' | 'svg';
    data: string;
  }): Promise<boolean>;
  copyText(text: string): Promise<void>;
  importFigma(input: { url: string; token: string }): Promise<Snapshot>;
  importBundle(): Promise<Snapshot | null>;
  reviewExportUpdate(input: {
    documentId: string;
    expectedRevision: number;
  }): Promise<ExportReview | null>;
  applyExportUpdate(input: {
    reviewId: string;
    choices: Record<string, 'local' | 'export'>;
    confirmUnverifiedSource: boolean;
  }): Promise<Snapshot>;
  discardExportUpdate(reviewId: string): Promise<void>;
  asset(documentId: string, assetId: string): Promise<string>;
  read(): Promise<Snapshot>;
  workspace(action: WorkspaceAction): Promise<Snapshot>;
  execute(request: CommandRequest): Promise<Snapshot>;
  connection(): Promise<ConnectionInfo>;
  resetConnection(): Promise<ConnectionInfo>;
  onChanged(listener: (snapshot: Snapshot) => void): () => void;
}

export function makeNode(
  type: DesignNode['type'],
  x = 100,
  y = 100,
): DesignNode {
  return {
    id: crypto.randomUUID(),
    parentId: null,
    type,
    name: type[0].toUpperCase() + type.slice(1),
    x,
    y,
    width: type === 'frame' ? 640 : type === 'text' ? 280 : 160,
    height: type === 'frame' ? 440 : type === 'text' ? 48 : 120,
    rotation: 0,
    fill:
      type === 'frame' ? '#ffffff' : type === 'text' ? '#20242d' : '#7561e8',
    opacity: 1,
    cornerRadius: type === 'rectangle' ? 12 : 0,
    text: type === 'text' ? 'Your next idea' : '',
    fontSize: 32,
    visible: true,
    locked: false,
  };
}

export function validateTree(document: DesignDocument) {
  const allNodes = document.pages.flatMap((page) => page.nodes);
  if (
    new Set(document.pages.map((page) => page.id)).size !==
    document.pages.length
  )
    throw new Error('Duplicate page ID.');
  const nodes = new Map(allNodes.map((node) => [node.id, node]));
  if (nodes.size !== allNodes.length) throw new Error('Duplicate node ID.');
  for (const page of document.pages) {
    const pageNodes = new Map(page.nodes.map((node) => [node.id, node]));
    for (const node of page.nodes) {
      const visited = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (visited.has(parentId)) throw new Error('Circular node hierarchy.');
        visited.add(parentId);
        const parent = pageNodes.get(parentId);
        if (!parent || parent.type !== 'frame')
          throw new Error('Parent must be an existing frame.');
        parentId = parent.parentId;
      }
    }
  }
}
