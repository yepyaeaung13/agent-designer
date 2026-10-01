import { DocumentService } from '../src/main/document-service';
import { getCurrentPreview } from '../src/main/current-preview';
import { makeNode } from '../src/shared/design';
import { png } from './fixtures/figma.cjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FontStore } from '../src/main/font-store';
import { fontCovers, fontRequestSchema } from '../src/shared/fonts';

const fixture = () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'local-design-fonts-'));
  return {
    folder,
    store: new FontStore(folder),
    close: () => rmSync(folder, { recursive: true, force: true }),
  };
};
// Storage-level tests use a magic-header fixture; actual decoding is covered in Electron.
const bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(24, 1)]);
const request = {
  family: 'Source Font',
  weight: '400',
  style: 'normal' as const,
};

test('local font files persist with exact descriptors and bytes, without original paths', () => {
  const f = fixture();
  try {
    const font = f.store.import(request, bytes);
    assert.equal(f.store.data(font.id), bytes.toString('base64'));
    assert.deepEqual(new FontStore(f.folder).list(), [font]);
    const manifest = readFileSync(
      path.join(f.folder, 'local-fonts/library.json'),
      'utf8',
    );
    assert(!manifest.includes(f.folder));
    assert.equal(f.store.import(request, bytes).id, font.id);
    assert.equal(f.store.list().length, 1);
    f.store.remove(font.id);
    assert.deepEqual(new FontStore(f.folder).list(), []);
    assert.throws(() => f.store.data(font.id), /not found/);
  } finally {
    f.close();
  }
});

test('font loading rejects non-fonts, oversized data, unsafe IDs, invalid descriptors and damaged files', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.import(request, Buffer.alloc(28)), /supported/);
    assert.throws(
      () => f.store.import(request, Buffer.alloc(20 * 1024 * 1024 + 1)),
      /20 MB/,
    );
    assert.throws(() => f.store.data('../../outside'));
    assert.throws(() => f.store.remove('../../outside'));
    assert.throws(() =>
      f.store.import({ ...request, weight: '900 100' }, bytes),
    );
    assert.throws(() =>
      f.store.import({ ...request, family: 'Bad\nFont' }, bytes),
    );
    const font = f.store.import(request, bytes);
    writeFileSync(
      path.join(f.folder, `local-fonts/${font.id}.woff2`),
      Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(24, 2)]),
    );
    assert.throws(() => f.store.data(font.id), /damaged/);
  } finally {
    f.close();
  }
});

test('font variant matching respects family, weight ranges and italic style', () => {
  assert(
    fontCovers(
      { ...request, weight: '100 900' },
      { family: 'source font', weight: 700, style: 'normal' },
    ),
  );
  assert(
    !fontCovers(request, {
      family: request.family,
      weight: 700,
      style: 'normal',
    }),
  );
  assert(
    !fontCovers(request, {
      family: request.family,
      weight: 400,
      style: 'italic',
    }),
  );
  assert(
    !fontCovers(request, { family: 'Other', weight: 400, style: 'normal' }),
  );
  assert.throws(() => fontRequestSchema.parse({ ...request, weight: '1001' }));
});

test('MCP preview metadata reports unavailable fonts and overflowing text without changing revisions', async () => {
  const service = new DocumentService(':memory:');
  try {
    const { document } = service.read(),
      pageId = document.pages[0].id;
    const root = { ...makeNode('frame'), width: 1, height: 1 };
    service.execute({
      documentId: document.id,
      pageId,
      expectedRevision: 0,
      command: { type: 'create', node: root },
    });
    const preview = await getCurrentPreview(
      service,
      { documentId: document.id, pageId, nodeId: root.id, expectedRevision: 1 },
      async () => ({
        data: png.toString('base64'),
        fonts: [
          {
            family: 'Missing Font',
            weight: 700,
            style: 'normal',
            status: 'missing',
          },
        ],
        textOverflow: [
          { nodeId: root.id, requiredHeight: 40, availableHeight: 20 },
        ],
      }),
    );
    assert.equal(preview.metadata.fonts?.[0].status, 'missing');
    assert.equal(preview.metadata.textOverflow?.length, 1);
    assert(
      preview.metadata.warnings.some((warning) => warning.includes('fallback')),
    );
    assert(
      preview.metadata.warnings.some((warning) =>
        warning.includes('saved height'),
      ),
    );
    assert.equal(service.read().document.revision, 1);
  } finally {
    service.close();
  }
});
