import { z } from 'zod';
import { gridCellSchema } from './grid';
export const layoutItemSchema = z
  .object({
    grid: gridCellSchema.optional(),
    widthMode: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
    heightMode: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
    positioning: z.enum(['flow', 'absolute']).optional(),
    align: z.enum(['INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX']).optional(),
    grow: z.number().finite().min(0).max(1).optional(),
    minWidth: z.number().finite().nonnegative().optional(),
    maxWidth: z.number().finite().nonnegative().optional(),
    minHeight: z.number().finite().nonnegative().optional(),
    maxHeight: z.number().finite().nonnegative().optional(),
    constraints: z
      .object({
        horizontal: z
          .enum(['start', 'end', 'center', 'stretch', 'scale'])
          .optional(),
        vertical: z
          .enum(['start', 'end', 'center', 'stretch', 'scale'])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (item) =>
      (item.minWidth === undefined ||
        item.maxWidth === undefined ||
        item.minWidth <= item.maxWidth) &&
      (item.minHeight === undefined ||
        item.maxHeight === undefined ||
        item.minHeight <= item.maxHeight),
    'Minimum size exceeds maximum size',
  );
export type LayoutItem = z.infer<typeof layoutItemSchema>;
