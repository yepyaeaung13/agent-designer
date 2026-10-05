const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const {
  retrieveHandoff,
  writeHandoff,
} = require('../scripts/design-handoff.cjs');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const text = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const scope = {
  documentId: 'doc',
  pageId: 'page',
  nodeId: 'frame',
  expectedRevision: 0,
};
const image = Buffer.from('image'),
  font = Buffer.from('font');
function fixture(options = {}) {
  const calls = [];
  let generation = 0,
    briefCount = 0;
  const brief = () => {
    const s = {
        ...scope,
        expectedRevision: options.fontChange ? 0 : generation,
      },
      retrieve = (tool) => ({ tool, arguments: s });
    return {
      scope: s,
      context: retrieve('get_design_context'),
      componentHandoff: { retrieve: retrieve('get_component_manifest') },
      layoutHandoff: { retrieve: retrieve('get_layout_context') },
      changeTracking: { baseline: { ...s, revision: generation } },
      assets: [
        {
          id: hash(image),
          retrieve: {
            tool: 'get_asset',
            arguments: { documentId: s.documentId, assetId: hash(image) },
          },
        },
      ],
      fontAssets: {
        fingerprint: 'fonts-' + generation,
        variants: [
          {
            family: 'Available',
            asset: {
              filename: hash(font) + '.ttf',
              sha256: hash(font),
              byteLength: font.length,
              retrieve: retrieve('get_font'),
            },
          },
          { family: 'Missing', status: 'unavailable' },
        ],
      },
      currentPreview: {
        available: true,
        retrieve: retrieve('get_current_preview'),
      },
      preview: { available: false },
    };
  };
  return {
    calls,
    client: {
      async callTool({ name, arguments: args }) {
        calls.push({ name, args });
        if (name === 'get_coding_brief') {
          briefCount++;
          if (options.fontChange && briefCount === 2) generation++;
          return text(brief());
        }
        if (name === 'get_design_changes') return text({ unchanged: true });
        if (name === 'get_design_context') {
          if (
            options.revisionChange &&
            generation === 0 &&
            args.offset === 100
          ) {
            generation++;
            return {
              isError: true,
              content: [
                { type: 'text', text: 'The design changed. Read again.' },
              ],
            };
          }
          return text({
            revision: generation,
            nodes: [{ id: args.nodeId + '-' + args.offset, generation }],
            nextOffset: args.offset === 0 ? 100 : null,
          });
        }
        if (name === 'get_component_manifest')
          return text({
            components: [
              {
                instances: [
                  {
                    nodeId: 'instance',
                    context: {
                      tool: 'get_design_context',
                      arguments: { ...args, nodeId: 'instance' },
                    },
                  },
                ],
              },
            ],
            repeatedPatterns: [],
            nextOffset: null,
          });
        if (name === 'get_layout_context')
          return text({ frames: [], nextOffset: null });
        if (name === 'get_asset')
          return {
            content: [
              {
                type: 'resource',
                resource: {
                  mimeType: 'image/png',
                  blob: (options.corrupt
                    ? Buffer.from('wrong')
                    : image
                  ).toString('base64'),
                },
              },
            ],
          };
        if (name === 'get_font')
          return {
            content: [
              ...text({ fontFingerprint: 'fonts-' + generation }).content,
              {
                type: 'resource',
                resource: {
                  mimeType: 'font/ttf',
                  blob: font.toString('base64'),
                },
              },
            ],
          };
        if (name === 'get_current_preview')
          return {
            content: [
              ...text({
                revision: generation,
                fontFingerprint: 'fonts-' + generation,
              }).content,
              {
                type: 'image',
                mimeType: 'image/png',
                data: image.toString('base64'),
              },
            ],
          };
        throw Error(name);
      },
    },
  };
}
test('handoff retrieves embedded fonts, all context/instances and matching baseline; output does not promote baseline', async () => {
  const { client, calls } = fixture();
  const baseline = { ...scope, revision: 0 };
  const result = await retrieveHandoff(client, scope, baseline);
  assert.deepEqual(calls[0], { name: 'get_coding_brief', args: scope });
  assert.equal(result.receipts.context.length, 2);
  assert.equal(result.receipts.instances.length, 2);
  assert(calls.some((c) => c.name === 'get_design_changes'));
  assert.deepEqual(
    result.files.get('public/fonts/' + hash(font) + '.ttf'),
    font,
  );
  assert.equal(result.receipts.fonts.variants[1].status, 'unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-output-'));
  try {
    fs.writeFileSync(path.join(dir, 'baseline.json'), 'verified-baseline');
    const snapshot = writeHandoff(dir, result);
    assert.equal(
      fs.readFileSync(path.join(dir, 'baseline.json'), 'utf8'),
      'verified-baseline',
    );
    assert.deepEqual(
      fs.readFileSync(path.join(snapshot, 'public/fonts', hash(font) + '.ttf')),
      font,
    );
    assert(
      fs.existsSync(path.join(snapshot, 'design/baseline-candidate.json')),
    );
    assert(
      !fs
        .readFileSync(path.join(snapshot, 'design/brief.json'), 'utf8')
        .includes('Authorization'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('different document baseline is ignored', async () => {
  const { client, calls } = fixture();
  await retrieveHandoff(client, scope, { ...scope, documentId: 'other' });
  assert(!calls.some((c) => c.name === 'get_design_changes'));
});
test('revision drift restarts at offset zero and discards prior pages', async () => {
  const { client, calls } = fixture({ revisionChange: true });
  const result = await retrieveHandoff(client, scope);
  assert.equal(result.receipts.brief.scope.expectedRevision, 1);
  assert(
    result.receipts.context.every((p) =>
      p.nodes.every((n) => n.generation === 1),
    ),
  );
  assert(
    calls.some(
      (c) =>
        c.name === 'get_design_context' &&
        c.args.offset === 0 &&
        c.args.expectedRevision === 1,
    ),
  );
});
test('font fingerprint drift restarts fonts and preview, even without a revision error', async () => {
  const { client, calls } = fixture({ fontChange: true });
  const result = await retrieveHandoff(client, scope);
  assert.equal(result.receipts.fonts.fingerprint, 'fonts-1');
  assert.equal(calls.filter((c) => c.name === 'get_font').length, 2);
  assert.equal(result.receipts.current.fontFingerprint, 'fonts-1');
});
test('corrupted asset bytes fail before any snapshot or candidate can be returned', async () => {
  const { client } = fixture({ corrupt: true });
  await assert.rejects(retrieveHandoff(client, scope), /checksum/);
});
