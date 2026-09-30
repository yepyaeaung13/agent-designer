require('tsx/cjs');
const { DocumentService } = require('../src/main/document-service.ts');
const { importFigmaBundle } = require('../src/main/figma-bundle.ts');
const { readFileSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const folder = mkdtempSync(
  path.join(require('node:os').tmpdir(), 'contact-import-check-'),
);
const service = new DocumentService(path.join(folder, 'test.sqlite'));
try {
  const bytes = readFileSync(
    path.join(
      require('node:os').homedir(),
      'Downloads',
      'Contact.agentdesign.json',
    ),
  );
  const snapshot = importFigmaBundle(service, bytes);
  const nodes = snapshot.document.pages[0].nodes;
  const dot = nodes.find(
    (node) =>
      node.name === 'Background' && node.width === 8 && node.height === 8,
  );
  if (!dot || dot.cornerRadius !== 4)
    throw new Error('Small circular background radius not preserved');
  console.log(
    JSON.stringify({
      imported: snapshot.document.name,
      nodes: nodes.length,
      assets: service.listAssets(snapshot.document.id).length,
      dotRadius: dot.cornerRadius,
    }),
  );
} finally {
  service.close();
}
