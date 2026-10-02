import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { validateFont } from './font-metadata';
import {
  fontRequestSchema,
  localFontSchema,
  type LocalFont,
} from '../shared/fonts';

const librarySchema = z
  .object({ version: z.literal(1), fonts: z.array(localFontSchema).max(128) })
  .strict();
export class FontStore {
  private directory: string;
  private manifest: string;
  private fonts: LocalFont[] = [];
  constructor(userData: string) {
    this.directory = path.join(userData, 'local-fonts');
    this.manifest = path.join(this.directory, 'library.json');
    mkdirSync(this.directory, { recursive: true });
    if (existsSync(this.manifest))
      this.fonts = librarySchema.parse(
        JSON.parse(readFileSync(this.manifest, 'utf8')),
      ).fonts;
  }
  list() {
    return this.fonts.map((font) => {
      try {
        return {
          ...font,
          variationSettings: validateFont(
            Buffer.from(this.data(font.id), 'base64'),
            font,
          ),
        };
      } catch (error) {
        return {
          ...font,
          validationError:
            error instanceof Error ? error.message : 'Font validation failed.',
        };
      }
    });
  }
  private file(font: LocalFont) {
    return path.join(this.directory, `${font.id}.${font.format}`);
  }
  private save(fonts: LocalFont[]) {
    const content = librarySchema.parse({ version: 1, fonts });
    const temporary = `${this.manifest}.tmp`;
    writeFileSync(temporary, JSON.stringify(content));
    renameSync(temporary, this.manifest);
    this.fonts = fonts;
  }
  import(input: unknown, bytes: Buffer) {
    const request = fontRequestSchema.parse(input);
    if (bytes.length < 12 || bytes.length > 20 * 1024 * 1024)
      throw new Error('Choose a font file smaller than 20 MB.');
    const signature = bytes.toString('ascii', 0, 4);
    const format =
      signature === 'OTTO'
        ? 'otf'
        : signature === 'wOFF'
          ? 'woff'
          : signature === 'wOF2'
            ? 'woff2'
            : bytes.readUInt32BE(0) === 0x00010000 || signature === 'true'
              ? 'ttf'
              : null;
    if (!format)
      throw new Error(
        'This is not a supported TTF, OTF, WOFF or WOFF2 font. Font collections are not supported.',
      );
    validateFont(bytes, request);
    const id = createHash('sha256')
      .update(bytes)
      .update(JSON.stringify(request))
      .digest('hex');
    const font: LocalFont = {
      ...request,
      id,
      format,
      byteLength: bytes.length,
    };
    const retained = this.fonts.filter(
      (font) =>
        !(
          font.family.toLowerCase() === request.family.toLowerCase() &&
          font.weight === request.weight &&
          font.style === request.style
        ),
    );
    if (
      retained.reduce((sum, font) => sum + font.byteLength, bytes.length) >
      200 * 1024 * 1024
    )
      throw new Error(
        'The local font library is full. Remove unused fonts before adding more.',
      );
    if (retained.length >= 128)
      throw new Error('The local font library is full.');
    writeFileSync(this.file(font), bytes);
    const replaced = this.fonts.filter(
      (old) => !retained.includes(old) && old.id !== font.id,
    );
    this.save([...retained, font]);
    for (const old of replaced) {
      try {
        if (existsSync(this.file(old))) unlinkSync(this.file(old));
      } catch {
        /* Active manifest and new file remain valid if old-file cleanup fails. */
      }
    }
    return { ...font, variationSettings: validateFont(bytes, request) };
  }
  data(input: unknown) {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input);
    const font = this.fonts.find((font) => font.id === id);
    if (!font) throw new Error('Local font not found.');
    if (statSync(this.file(font)).size !== font.byteLength)
      throw new Error(
        'The saved font file is damaged. Load the original font again.',
      );
    const bytes = readFileSync(this.file(font));
    const { family, weight, style } = font;
    if (
      bytes.length !== font.byteLength ||
      createHash('sha256')
        .update(bytes)
        .update(JSON.stringify({ family, weight, style }))
        .digest('hex') !== font.id
    )
      throw new Error(
        'The saved font file is damaged. Load the original font again.',
      );
    validateFont(bytes, font);
    return bytes.toString('base64');
  }
  remove(input: unknown) {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input);
    const font = this.fonts.find((font) => font.id === id);
    if (!font) throw new Error('Local font not found.');
    this.save(this.fonts.filter((font) => font.id !== id));
    if (existsSync(this.file(font))) unlinkSync(this.file(font));
  }
}
