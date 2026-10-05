import { z } from 'zod';
import type { DesignNode } from './design';

export const textRunSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    fontFamily: z.string().min(1).max(200).optional(),
    fontSize: z.number().min(1).max(500).optional(),
    fontWeight: z.number().min(1).max(1000).optional(),
    fontStyle: z.enum(['normal', 'italic']).optional(),
    lineHeight: z.number().finite().positive().optional(),
    letterSpacing: z.number().finite().optional(),
    fill: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    decoration: z.enum(['none', 'underline', 'line-through']).optional(),
  })
  .strict();
export type TextRun = z.infer<typeof textRunSchema>;

export function styledText(node: DesignNode) {
  const result: {
    text: string;
    node: DesignNode;
    decoration?: TextRun['decoration'];
  }[] = [];
  let offset = 0;
  for (const run of node.textRuns ?? []) {
    if (run.start > offset)
      result.push({ text: node.text.slice(offset, run.start), node });
    const { start, end, decoration, ...style } = run;
    result.push({
      text: node.text.slice(start, end),
      node: {
        ...node,
        ...Object.fromEntries(
          Object.entries(style).filter(([, value]) => value !== undefined),
        ),
      },
      decoration,
    });
    offset = end;
  }
  if (offset < node.text.length)
    result.push({ text: node.text.slice(offset), node });
  return result;
}

export function textFontRequests(node: DesignNode) {
  return styledText(node)
    .filter((part) => part.text)
    .map(({ node: style }) => ({
      family: (style.fontFamily ?? 'Arial').trim(),
      weight: style.fontWeight ?? 400,
      style: style.fontStyle ?? 'normal',
    }));
}
