import { create } from 'fontkit';
import type { FontImport } from '../shared/fonts';

// CSS descriptors cannot turn intrinsically italic outlines into upright glyphs.
export function validateFont(bytes: Buffer, request: FontImport) {
  let font;
  try {
    font = create(bytes);
    if ('fonts' in font) throw new Error('Font collections are unsupported.');
    const selection = font['OS/2']?.fsSelection;
    const italic = Boolean(
      selection?.italic || selection?.oblique || font.italicAngle,
    );
    const axes = font.variationAxes;
    const desiredItalic = request.style === 'italic';
    const ital = axes.ital,
      slnt = axes.slnt;
    const canSelectStyle =
      ital &&
      ital.min <= Number(desiredItalic) &&
      ital.max >= Number(desiredItalic);
    const canSelectSlant =
      slnt &&
      (desiredItalic
        ? slnt.min < 0 || slnt.max > 0
        : slnt.min <= 0 && slnt.max >= 0);
    if (italic !== desiredItalic && !canSelectStyle && !canSelectSlant)
      throw new Error(
        `This file contains ${italic ? 'italic' : 'normal'} glyphs. Choose a ${request.style} font file or change the requested style.`,
      );
    const [min, max = min] = request.weight.split(' ').map(Number);
    const weight = axes.wght;
    if (
      weight
        ? min < weight.min || max > weight.max
        : min !== max || min !== font['OS/2']?.usWeightClass
    )
      throw new Error(
        `This file supports weight ${weight ? `${weight.min}–${weight.max}` : font['OS/2']?.usWeightClass}. Choose a matching weight or font file.`,
      );
    const settings: string[] = [];
    if (weight && min === max) settings.push(`"wght" ${min}`);
    if (ital) settings.push(`"ital" ${Number(desiredItalic)}`);
    if (slnt)
      settings.push(
        `"slnt" ${desiredItalic ? (slnt.min < 0 ? slnt.min : slnt.max) : 0}`,
      );
    return settings.length ? settings.join(', ') : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('This file'))
      throw error;
    throw new Error(
      'Could not read font metadata. Choose a valid TTF, OTF, WOFF or WOFF2 file.',
    );
  }
}
