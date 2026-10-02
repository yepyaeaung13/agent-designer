/* global figma, __html__ */
figma.showUI(__html__, { width: 420, height: 400 });
let exporting = false;
figma.ui.onmessage = async (message) => {
  if (message.type !== 'export' || exporting) return;
  exporting = true;
  const send = (payload) =>
    figma.ui.postMessage({ ...payload, requestId: message.requestId });
  async function step(label, action, timeout = 60000) {
    send({ type: 'progress', text: label });
    let timer;
    const started = Date.now();
    const heartbeat = setInterval(
      () =>
        send({
          type: 'progress',
          text: `${label} ${Math.floor((Date.now() - started) / 1000)}s elapsed`,
        }),
      10000,
    );
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `${label} timed out after ${timeout / 1000}s. Close and reopen the plugin, choose Compact preview, and retry. If it still fails, export sections separately.`,
                ),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }
  try {
    send({ type: 'progress', text: 'Checking selected frame…' });
    const selection = figma.currentPage.selection;
    if (selection.length !== 1) throw new Error('Select one frame to export.');
    const selected = selection[0];
    if (
      !['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP', 'SECTION'].includes(
        selected.type,
      )
    )
      throw new Error('Select a frame, group, or component.');
    const entry = await step('Reading frame structure…', () =>
      selected.exportAsync({ format: 'JSON_REST_V1' }),
    );
    const nodes = [];
    function visit(node, depth) {
      if (depth > 64 || nodes.length >= 2000)
        throw new Error('Choose a smaller frame (up to 2,000 layers).');
      nodes.push(node);
      for (const child of node.children || []) visit(child, depth + 1);
    }
    visit(entry.document, 0);
    // JSON_REST_V1 may omit newer grid fields; copy them from the selected tree.
    const exportedById = new Map(nodes.map((node) => [node.id, node]));
    function copyGrid(live) {
      const raw = exportedById.get(live.id);
      if (raw && live.layoutMode === 'GRID') {
        raw.layoutMode = 'GRID';
        for (const field of ['gridColumnSizes', 'gridRowSizes'])
          raw[field] = live[field].map((track) => ({
            type: track.type,
            ...(track.value === undefined ? {} : { value: track.value }),
          }));
        raw.gridColumnGap = live.gridColumnGap;
        raw.gridRowGap = live.gridRowGap;
      }
      if (raw && live.parent && live.parent.layoutMode === 'GRID')
        for (const field of [
          'gridRowAnchorIndex',
          'gridColumnAnchorIndex',
          'gridRowSpan',
          'gridColumnSpan',
          'gridChildHorizontalAlign',
          'gridChildVerticalAlign',
        ])
          raw[field] = live[field];
      for (const child of live.children || []) copyGrid(child);
    }
    copyGrid(selected);
    // Recover image references from live paints when REST-shaped export omits them.
    for (const node of nodes) {
      if (
        !(node.fills || []).some(
          (paint) => paint.type === 'IMAGE' && !paint.imageRef,
        )
      )
        continue;
      const live = await step('Checking image references…', () =>
        figma.getNodeByIdAsync(node.id),
      );
      if (live && Array.isArray(live.fills)) {
        node.fills.forEach((paint, index) => {
          if (paint.type === 'IMAGE' && !paint.imageRef)
            paint.imageRef = live.fills[index] && live.fills[index].imageHash;
        });
      }
      if (
        node.fills.some(
          (paint) =>
            paint.type === 'IMAGE' &&
            paint.visible !== false &&
            !paint.imageRef,
        )
      )
        throw new Error(
          'An image reference is unavailable. Wait for Figma to load the image and export again.',
        );
    }
    const bundle = {
      format: 'agent-designer.figma-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      fileKey: figma.fileKey || '',
      entry,
      preview: 'preview',
      renders: {},
      images: {},
      warnings: [],
      assets: [],
    };
    let total = 0;
    function add(key, bytes, mimeType) {
      total += bytes.length;
      if (bytes.length > 12 * 1024 * 1024 || total > 64 * 1024 * 1024)
        throw new Error('Images are too large. Choose a smaller frame.');
      bundle.assets.push({ key, mimeType, base64: figma.base64Encode(bytes) });
    }
    async function render(node, preview = false) {
      const width = Math.max(node.width || 1, 1);
      const height = Math.max(node.height || 1, 1);
      const maxSide = preview ? (message.compactPreview ? 1024 : 2048) : 4096;
      const maxPixels = preview
        ? message.compactPreview
          ? 500000
          : 2000000
        : 8000000;
      return node.exportAsync({
        format: 'PNG',
        constraint: {
          type: 'SCALE',
          value: Math.min(
            1,
            maxSide / Math.max(width, height),
            Math.sqrt(maxPixels / (width * height)),
          ),
        },
      });
    }
    add(
      'preview',
      await step(
        'Rendering reference image (up to 3 minutes)…',
        () => render(selected, true),
        180000,
      ),
      'image/png',
    );
    bundle.warnings.push(
      `Reference preview is limited to ${message.compactPreview ? 1024 : 2048}px on its longest side for large-page export. Original layer geometry and source images are preserved.`,
    );
    const containers = new Set([
      'FRAME',
      'GROUP',
      'COMPONENT',
      'COMPONENT_SET',
      'INSTANCE',
      'SECTION',
    ]);
    const refs = new Set();
    let count = 0;
    for (const node of nodes) {
      const fills = (node.fills || []).filter(
        (paint) => paint.visible !== false,
      );
      for (const paint of fills) if (paint.imageRef) refs.add(paint.imageRef);
      if (
        !containers.has(node.type) &&
        (!['TEXT', 'RECTANGLE', 'ELLIPSE'].includes(node.type) ||
          fills.some((paint) => paint.type !== 'SOLID') ||
          fills.length > 1)
      ) {
        if (++count > 80)
          throw new Error('Choose a frame with fewer than 80 complex layers.');
        const live = await step(`Reading layer ${count}…`, () =>
          figma.getNodeByIdAsync(node.id),
        );
        if (!live || !('exportAsync' in live))
          throw new Error('A layer changed during export. Try again.');
        const key = `render:${node.id}`;
        add(
          key,
          await step(`Rendering layer ${count}…`, () => render(live)),
          'image/png',
        );
        bundle.renders[node.id] = key;
      }
    }
    if (refs.size > 80)
      throw new Error('Choose a frame with fewer than 80 source images.');
    for (const ref of refs) {
      const image = figma.getImageByHash(ref);
      if (!image)
        throw new Error(
          'A source image is unavailable. Wait for the file to load and retry.',
        );
      const bytes = await step(
        `Loading source image ${Object.keys(bundle.images).length + 1} of ${refs.size}…`,
        () => image.getBytesAsync(),
      );
      const mime =
        bytes[0] === 137
          ? 'image/png'
          : bytes[0] === 255
            ? 'image/jpeg'
            : bytes[0] === 71
              ? 'image/gif'
              : null;
      if (!mime) throw new Error('A source image uses an unsupported format.');
      const key = `image:${ref}`;
      add(key, bytes, mime);
      bundle.images[ref] = key;
    }
    send({ type: 'progress', text: 'Preparing download…' });
    if (!refs.size)
      bundle.warnings.push(
        'This selection contains no source image fills. If an image is missing, check that its layer is inside the selected frame in Figma.',
      );
    const json = JSON.stringify(bundle);
    if (json.length > 100 * 1024 * 1024)
      throw new Error('Export is too large. Choose a smaller frame.');
    send({
      type: 'ready',
      json,
      name: selected.name,
      summary: `${nodes.length} layers · ${refs.size} source images · ${count} rendered layers`,
    });
  } catch (error) {
    send({
      type: 'error',
      text: error.message || 'Export failed. Try again.',
    });
  } finally {
    exporting = false;
  }
};
