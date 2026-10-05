const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decode = (result) =>
  JSON.parse(result.content.find((c) => c.type === 'text').text);
const sameScope = (a, b) =>
  ['documentId', 'pageId', 'nodeId'].every((k) => a?.[k] === b?.[k]);

// Read-only retrieval. No disk writes or baseline promotion until all guards pass.
async function retrieveHandoff(client, requestedScope, baseline) {
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
      throw new Error(
        result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      );
    return result;
  };
  const pages = async (tool, args) => {
    const results = [],
      offsets = new Set();
    let offset = 0;
    do {
      if (offsets.has(offset))
        throw new Error('Invalid pagination: repeated offset.');
      offsets.add(offset);
      const page = decode(await call(tool, { ...args, offset, limit: 100 }));
      results.push(page);
      offset = page.nextOffset ?? null;
      if (
        offset !== null &&
        (!Number.isInteger(offset) || offset <= [...offsets].at(-1))
      )
        throw new Error('Invalid pagination offset.');
    } while (offset !== null);
    return results;
  };
  let scope = { ...requestedScope };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const brief = decode(await call('get_coding_brief', scope));
      /** @type {Record<string, any>} */
      const receipts = { brief };
      const files = new Map();
      if (baseline && sameScope(baseline, brief.scope))
        receipts.changes = decode(
          await call('get_design_changes', { ...brief.scope, baseline }),
        );
      receipts.context = await pages(
        brief.context.tool,
        brief.context.arguments,
      );
      for (const [key, name] of [
        ['componentHandoff', 'components'],
        ['layoutHandoff', 'layout'],
      ]) {
        if (brief[key]?.retrieve)
          receipts[name] = await pages(
            brief[key].retrieve.tool,
            brief[key].retrieve.arguments,
          );
      }
      receipts.instances = [];
      const instances = (receipts.components ?? []).flatMap((p) => [
        ...(p.components ?? []).flatMap((c) => c.instances),
        ...(p.repeatedPatterns ?? []).flatMap((p) => p.instances),
      ]);
      const seen = new Set();
      for (const instance of instances) {
        if (!instance.context || seen.has(instance.nodeId)) continue;
        seen.add(instance.nodeId);
        receipts.instances.push(
          ...(await pages(instance.context.tool, instance.context.arguments)),
        );
      }
      const bytesFrom = (result) => {
        const resource = result.content.find(
          (c) => c.type === 'resource',
        )?.resource;
        if (!resource?.blob)
          throw new Error('Missing embedded resource bytes.');
        return Buffer.from(resource.blob, 'base64');
      };
      for (const asset of brief.assets) {
        if (!/^[a-f0-9]{64}$/.test(asset.id))
          throw new Error('Invalid asset identity.');
        const result = await call(
          asset.retrieve.tool,
          asset.retrieve.arguments,
        );
        const bytes = bytesFrom(result);
        if (hash(bytes) !== asset.id)
          throw new Error('Asset checksum mismatch.');
        const mime = result.content.find((c) => c.type === 'resource').resource
          .mimeType;
        const extension = {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/svg+xml': 'svg',
          'image/webp': 'webp',
        }[mime];
        if (!extension) throw new Error('Unsupported asset format.');
        files.set(`public/assets/${asset.id}.${extension}`, bytes);
      }
      receipts.fonts = brief.fontAssets;
      for (const variant of brief.fontAssets.variants.filter((v) => v.asset)) {
        const asset = variant.asset;
        if (!/^[a-f0-9]{64}\.(ttf|otf|woff|woff2)$/.test(asset.filename))
          throw new Error('Unsafe font filename.');
        const result = await call(
          asset.retrieve.tool,
          asset.retrieve.arguments,
        );
        const bytes = bytesFrom(result),
          metadata = decode(result);
        if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength)
          throw new Error('Font checksum or byte length mismatch.');
        if (metadata.fontFingerprint !== brief.fontAssets.fingerprint)
          throw new Error('The font library changed during retrieval.');
        files.set(`public/fonts/${asset.filename}`, bytes);
      }
      for (const [name, preview] of [
        ['current', brief.currentPreview],
        ['reference', brief.preview],
      ]) {
        if (!preview?.available) continue;
        const result = await call(
          preview.retrieve.tool,
          preview.retrieve.arguments,
        );
        receipts[name] = decode(result);
        const bitmap = result.content.find((c) => c.type === 'image');
        if (!bitmap) throw new Error('Missing preview image.');
        if (
          name === 'current' &&
          receipts[name].fontFingerprint !== brief.fontAssets.fingerprint
        )
          throw new Error('The font library changed during preview retrieval.');
        files.set(`design/${name}.png`, Buffer.from(bitmap.data, 'base64'));
      }
      const fresh = decode(await call('get_coding_brief', brief.scope));
      if (
        JSON.stringify(fresh.changeTracking.baseline) !==
        JSON.stringify(brief.changeTracking.baseline)
      )
        throw new Error('The design changed during retrieval.');
      if (fresh.fontAssets.fingerprint !== brief.fontAssets.fingerprint)
        throw new Error('The font library changed during retrieval.');
      // A candidate is evidence, not proof that target code has been implemented.
      receipts['baseline-candidate'] = fresh.changeTracking.baseline;
      return { receipts, files };
    } catch (error) {
      if (
        !/The design changed|The font (library|file) changed/.test(
          error.message,
        ) ||
        attempt === 2
      )
        throw error;
      scope = { ...requestedScope };
      delete scope.expectedRevision;
    }
  }
  throw new Error('The design changed throughout retrieval.');
}

function writeHandoff(destination, handoff) {
  const target = path.resolve(destination);
  fs.mkdirSync(target, { recursive: true });
  // Separate snapshots preserve prior evidence and the verified baseline.
  const stage = fs.mkdtempSync(path.join(target, '.handoff-'));
  try {
    for (const [filename, bytes] of handoff.files) {
      const file = path.join(stage, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    fs.mkdirSync(path.join(stage, 'design'), { recursive: true });
    for (const [name, value] of Object.entries(handoff.receipts))
      fs.writeFileSync(
        path.join(stage, 'design', name + '.json'),
        JSON.stringify(value, null, 2) + '\n',
      );
    fs.writeFileSync(
      path.join(stage, 'README.md'),
      'Retrieved design evidence. Implement and verify target code before promoting design/baseline-candidate.json to a verified baseline. Font descriptors are in design/fonts.json; files are in public/fonts. Connection credentials are not saved.\n',
    );
    const snapshot = stage.replace('.handoff-', 'handoff-');
    fs.renameSync(stage, snapshot);
    return snapshot;
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

async function runCli() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  const url = new URL(config.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/mcp' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use the local Agent Designer MCP URL.');
  if (
    !config.destination ||
    !config.scope ||
    !['documentId', 'pageId', 'nodeId'].every((k) =>
      /^[a-f0-9-]{36}$/i.test(config.scope[k]),
    )
  )
    throw new Error('Supply destination and document/page/node scope.');
  if (
    !Number.isInteger(config.scope.expectedRevision) ||
    config.scope.expectedRevision < 0
  )
    throw new Error('Supply an exact expectedRevision.');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const {
    StreamableHTTPClientTransport,
  } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'agent-designer-handoff', version: '1' });
  let baseline;
  if (config.baselinePath)
    baseline = JSON.parse(fs.readFileSync(config.baselinePath));
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: config.headers },
      }),
    );
    const result = await retrieveHandoff(client, config.scope, baseline);
    const snapshot = writeHandoff(config.destination, result);
    console.log(
      JSON.stringify({
        snapshot,
        scope: result.receipts.brief.scope,
        files: result.files.size,
        unavailableFonts: result.receipts.fonts.variants
          .filter((v) => !v.asset)
          .map((v) => ({
            family: v.family,
            weight: v.weight,
            style: v.style,
            status: v.status,
          })),
        baselinePromoted: false,
      }),
    );
  } catch (error) {
    const message = String(error.message);
    if (
      /The design changed|The font (library|file) changed|checksum|Missing |Invalid pagination|Unsafe |Unsupported asset/.test(
        message,
      )
    )
      throw error;
    // Network/SDK errors may contain headers; never echo them or the config.
    throw new Error(
      'Could not retrieve the local design. Check the app connection, selection and revision.',
    );
  } finally {
    await client.close();
  }
}
module.exports = { retrieveHandoff, writeHandoff, runCli };
