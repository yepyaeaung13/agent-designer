import { z } from 'zod';

export const fontRequestSchema = z
  .object({
    family: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) => [...value].every((char) => char.charCodeAt(0) >= 32),
        'Font family contains control characters.',
      ),
    weight: z
      .string()
      .trim()
      .regex(/^(?:[1-9]\d{0,2}|1000)(?: (?:[1-9]\d{0,2}|1000))?$/)
      .refine((value) => {
        const numbers = value.split(' ').map(Number);
        return numbers.length === 1 || numbers[0] <= numbers[1];
      }, 'Weight range must be in ascending order.'),
    style: z.enum(['normal', 'italic']),
  })
  .strict();
export const localFontSchema = fontRequestSchema
  .extend({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    format: z.enum(['ttf', 'otf', 'woff', 'woff2']),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
  })
  .strict();
export const fontStatusSchema = z
  .object({
    family: z.string(),
    weight: z.number(),
    style: z.enum(['normal', 'italic']),
    status: z.enum(['local', 'system', 'substituted', 'missing', 'error']),
    fontId: z.string().optional(),
  })
  .strict();
export type FontImport = z.infer<typeof fontRequestSchema>;
export type LocalFont = z.infer<typeof localFontSchema>;
export type FontStatus = z.infer<typeof fontStatusSchema>;
export type FontRequest = Pick<FontStatus, 'family' | 'weight' | 'style'>;
export const textOverflowSchema = z
  .object({
    nodeId: z.string().uuid(),
    requiredHeight: z.number().finite().positive(),
    availableHeight: z.number().finite().positive(),
  })
  .strict();
export type TextOverflow = z.infer<typeof textOverflowSchema>;
export function fontCovers(font: FontImport, request: FontRequest) {
  const [min, max = min] = font.weight.split(' ').map(Number);
  return (
    font.family.toLowerCase() === request.family.toLowerCase() &&
    font.style === request.style &&
    request.weight >= min &&
    request.weight <= max
  );
}
