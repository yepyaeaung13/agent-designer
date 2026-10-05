import { z } from 'zod';

export const updateExportInput = z
  .object({
    documentId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const applyExportInput = z
  .object({
    reviewId: z.string().uuid(),
    choices: z.record(z.string(), z.enum(['local', 'export'])),
    confirmUnverifiedSource: z.boolean(),
  })
  .strict();
export type ExportConflict = {
  id: string;
  layerName: string;
  field: string;
  local: unknown;
  incoming: unknown;
};
export type ExportReview = {
  reviewId: string;
  documentId: string;
  expectedRevision: number;
  documentName: string;
  frameName: string;
  fileName: string;
  identityVerified: boolean;
  added: number;
  removed: number;
  updated: number;
  conflicts: ExportConflict[];
};
