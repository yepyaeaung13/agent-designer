import type { DesignNode } from '../shared/design';
import Konva from 'konva';
import { textLayout } from './text-layout';
import { textFontRequests } from '../shared/text-runs';
import { richTextLayout } from './rich-text';
import {
  fontCovers,
  type FontRequest,
  type FontStatus,
  type LocalFont,
  type TextOverflow,
} from '../shared/fonts';

let entries: LocalFont[] = [],
  faces: FontFace[] = [];
let failures = new Set<string>();
let pending: Promise<void> | undefined;
let version = 0;
const listeners = new Set<() => void>();
const system = new Map<string, Promise<boolean>>();
export const fontVersion = () => version;
export const onFontsChanged = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const localFonts = () => entries.map((font) => ({ ...font }));
export const fontLoadFailed = (id: string) => failures.has(id);
// Konva quotes family names; a deterministic fallback avoids browser serif defaults.
export const fontStack = (family = 'Arial') => `${family}, Arial, sans-serif`;
export function textOverflow(nodes: DesignNode[]): TextOverflow[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: TextOverflow[] = [];
  for (const node of nodes)
    if (node.type === 'text' && node.text) {
      let ancestor: DesignNode | undefined = node;
      let hidden = false;
      while (ancestor) {
        if (!ancestor.visible || ancestor.opacity === 0) {
          hidden = true;
          break;
        }
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
      if (hidden) continue;
      const text = new Konva.Text({
        text: node.text,
        ...textLayout(node),
        height: undefined,
        fontSize: node.fontSize,
        fontFamily: fontStack(node.fontFamily),
        fontStyle: `${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`,
        lineHeight: node.lineHeight ? node.lineHeight / node.fontSize : 1,
        letterSpacing: node.letterSpacing ?? 0,
      });
      const requiredHeight = node.textRuns?.length
        ? richTextLayout(node).height
        : text.height();
      text.destroy();
      if (requiredHeight > node.height + 0.1)
        result.push({
          nodeId: node.id,
          requiredHeight,
          availableHeight: node.height,
        });
    }
  return result;
}
export function requestedFonts(nodes: DesignNode[]) {
  const unique = new Map<string, FontRequest>();
  for (const node of nodes)
    if (node.type === 'text') {
      for (const request of textFontRequests(node))
        unique.set(JSON.stringify(request), request);
    }
  return [...unique.values()];
}
export async function refreshFonts() {
  if (pending) return pending;
  pending = (async () => {
    const next = await window.designer.listFonts();
    const loaded: FontFace[] = [],
      errors = new Set<string>();
    await Promise.all(
      next.map(async (entry) => {
        try {
          if (entry.validationError) throw new Error(entry.validationError);
          const bytes = Uint8Array.from(
            atob(await window.designer.fontData(entry.id)),
            (char) => char.charCodeAt(0),
          );
          const face = new FontFace(entry.family, bytes.buffer, {
            weight: entry.weight,
            style: entry.style,
            variationSettings: entry.variationSettings,
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              face.load(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Font loading timed out.')),
                  5000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          loaded.push(face);
        } catch {
          errors.add(entry.id);
        }
      }),
    );
    for (const face of faces) document.fonts.delete(face);
    for (const face of loaded) document.fonts.add(face);
    entries = next;
    faces = loaded;
    failures = errors;
    system.clear();
    await document.fonts.ready;
    version++;
    for (const listener of listeners) listener();
  })();
  try {
    await pending;
  } finally {
    pending = undefined;
  }
}
export async function ensureFonts() {
  if (pending) await pending;
  else if (!version) await refreshFonts();
}
async function installed(family: string) {
  const key = family.toLowerCase();
  if (!system.has(key))
    system.set(
      key,
      (async () => {
        try {
          await new FontFace(
            '__agent_font_probe',
            `local(${JSON.stringify(family)}), local(${JSON.stringify(family + ' Regular')}), local(${JSON.stringify(family.replace(/\s/g, '') + '-Regular')})`,
          ).load();
          return true;
        } catch {
          return false;
        }
      })(),
    );
  return system.get(key)!;
}
export async function resolveFonts(nodes: DesignNode[]): Promise<FontStatus[]> {
  await ensureFonts();
  return Promise.all(
    requestedFonts(nodes).map(async (request) => {
      const matches = entries.filter((entry) => fontCovers(entry, request));
      const exact =
        matches.find((entry) => !failures.has(entry.id)) ?? matches[0];
      if (exact)
        return {
          ...request,
          fontId: exact.id,
          ...(exact.validationError ? { message: exact.validationError } : {}),
          status: failures.has(exact.id)
            ? ('error' as const)
            : ('local' as const),
        };
      if (await installed(request.family))
        return { ...request, status: 'system' as const };
      const other = entries.find(
        (entry) =>
          entry.family.toLowerCase() === request.family.toLowerCase() &&
          !failures.has(entry.id),
      );
      return {
        ...request,
        ...(other ? { fontId: other.id } : {}),
        status: other ? ('substituted' as const) : ('missing' as const),
      };
    }),
  );
}
