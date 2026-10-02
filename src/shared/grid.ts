import { z } from 'zod';
export const gridTrackSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('FIXED'),
      value: z.number().finite().min(1).max(10000),
    })
    .strict(),
  z
    .object({
      mode: z.literal('FILL'),
      value: z.number().finite().positive().max(10000),
    })
    .strict(),
  z.object({ mode: z.literal('HUG') }).strict(),
]);
export const gridSchema = z
  .object({
    columns: z.array(gridTrackSchema).min(1).max(64),
    rows: z.array(gridTrackSchema).min(1).max(64),
    columnGap: z.number().finite().min(0).max(10000),
    rowGap: z.number().finite().min(0).max(10000),
  })
  .strict();
export const gridCellSchema = z
  .object({
    row: z.number().int().min(0).max(63),
    column: z.number().int().min(0).max(63),
    rowSpan: z.number().int().min(1).max(64).default(1),
    columnSpan: z.number().int().min(1).max(64).default(1),
    horizontalAlign: z.enum(['MIN', 'CENTER', 'MAX', 'AUTO']).optional(),
    verticalAlign: z.enum(['MIN', 'CENTER', 'MAX', 'AUTO']).optional(),
  })
  .strict();
