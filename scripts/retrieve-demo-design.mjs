import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const destination = 'demos/neuraone';
mkdirSync(`${destination}/design`, { recursive: true });
mkdirSync(`${destination}/public/assets`, { recursive: true });
const scope = {
  documentId: '3b2e9d73-dd43-4e8c-88e4-57feb48dbc73',
  pageId: '5fcb8fa0-bc92-4013-838f-5f3f2814fe95',
  nodeId: '88e0d50f-b62b-44e6-899a-452aff393968',
  expectedRevision: 0,
};
function call(name, args) {
  const response = JSON.parse(
    execFileSync(
      'curl',
      [
        '--max-time',
        '60',
        '-sS',
        process.env.DESIGN_MCP_URL,
        '-H',
        `Authorization: Bearer ${process.env.DESIGN_MCP_TOKEN}`,
        '-H',
        'Content-Type: application/json',
        '-H',
        'Accept: application/json, text/event-stream',
        '--data',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      ],
      { maxBuffer: 80 * 1024 * 1024 },
    ),
  );
  if (response.error || response.result.isError)
    throw new Error(JSON.stringify(response));
  return response.result;
}
function data(result) {
  return JSON.parse(result.content.find((c) => c.type === 'text').text);
}
function save(name, value) {
  writeFileSync(
    `${destination}/design/${name}.json`,
    JSON.stringify(value, null, 2),
  );
}
const brief = data(call('get_coding_brief', scope));
save('brief', brief);
if (existsSync(`${destination}/design/baseline.json`)) {
  const baseline = JSON.parse(
    readFileSync(`${destination}/design/baseline.json`),
  );
  if (['documentId', 'pageId', 'nodeId'].every((k) => baseline[k] === scope[k]))
    save('changes', data(call('get_design_changes', { ...scope, baseline })));
}
for (const [name, tool] of [
  ['context', 'get_design_context'],
  ['components', 'get_component_manifest'],
  ['layout', 'get_layout_context'],
]) {
  const pages = [];
  let offset = 0;
  do {
    const page = data(call(tool, { ...scope, offset, limit: 100 }));
    pages.push(page);
    offset = page.nextOffset;
  } while (offset != null);
  save(name, pages);
}
save('fonts', brief.fontAssets);
const components = JSON.parse(
  readFileSync(`${destination}/design/components.json`),
);
const instances = [];
for (const component of components.flatMap((p) => p.components)) {
  for (const instance of component.instances) {
    let args = instance.context.arguments;
    do {
      const page = data(call(instance.context.tool, args));
      instances.push(page);
      args = { ...args, offset: page.nextOffset };
    } while (args.offset != null);
  }
}
save('instances', instances);
for (const asset of brief.assets) {
  const result = call(asset.retrieve.tool, asset.retrieve.arguments);
  const resource = result.content.find((c) => c.type === 'resource').resource;
  const bytes = Buffer.from(resource.blob, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== asset.id)
    throw new Error('Asset checksum mismatch');
  const ext =
    asset.mimeType === 'image/jpeg'
      ? 'jpg'
      : asset.mimeType === 'image/svg+xml'
        ? 'svg'
        : 'png';
  writeFileSync(`${destination}/public/assets/${asset.id}.${ext}`, bytes);
}
for (const font of brief.fontAssets.variants.filter(
  (f) => f.status === 'available',
)) {
  const result = data(
    call(font.asset.retrieve.tool, font.asset.retrieve.arguments),
  );
  const bytes = Buffer.from(result.data, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== font.asset.sha256)
    throw new Error('Font checksum mismatch');
  writeFileSync(`${destination}/public/assets/${font.asset.filename}`, bytes);
}
for (const [name, preview] of [
  ['reference', brief.preview],
  ['current', brief.currentPreview],
]) {
  if (!preview.available) continue;
  const result = call(preview.retrieve.tool, preview.retrieve.arguments);
  const bitmap = result.content.find((c) => c.type === 'image');
  if (bitmap)
    writeFileSync(
      `${destination}/design/${name}.png`,
      Buffer.from(bitmap.data, 'base64'),
    );
  else {
    const value = data(result);
    save(name, value);
    if (value.data)
      writeFileSync(
        `${destination}/design/${name}.png`,
        Buffer.from(value.data, 'base64'),
      );
  }
}
console.log(
  JSON.stringify({
    selection: brief.selection,
    layers: brief.layerCount,
    sections: brief.sections,
    fonts: brief.fonts,
    missing: brief.missingAssetIds,
  }),
);
