export type HandoffScope = {
  documentId: string;
  pageId: string;
  nodeId: string;
  expectedRevision: number;
};

export type HandoffReadiness = {
  status: 'ready' | 'needs-attention';
  imageCount: number;
  localFontCount: number;
  issues: string[];
};
