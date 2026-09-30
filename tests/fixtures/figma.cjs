const root = {
  id: '10:20',
  type: 'FRAME',
  name: 'Contact fixture',
  absoluteBoundingBox: { x: 300, y: 200, width: 600, height: 400 },
  size: { x: 600, y: 400 },
  fills: [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.99 } }],
  layoutMode: 'VERTICAL',
  itemSpacing: 24,
  paddingTop: 32,
  paddingLeft: 32,
  paddingRight: 32,
  paddingBottom: 32,
  clipsContent: true,
  children: [
    {
      id: '10:21',
      type: 'TEXT',
      name: 'Heading',
      absoluteBoundingBox: { x: 332, y: 232, width: 500, height: 42 },
      size: { x: 500, y: 42 },
      relativeTransform: [
        [1, 0, 32],
        [0, 1, 32],
      ],
      characters: 'Let’s build something good.',
      style: {
        fontFamily: 'Arial',
        fontWeight: 600,
        fontSize: 28,
        lineHeightPx: 36,
        letterSpacing: -0.5,
        textAlignHorizontal: 'LEFT',
      },
      fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.2 } }],
    },
    {
      id: '10:22',
      type: 'FRAME',
      name: 'Contact card',
      absoluteBoundingBox: { x: 332, y: 298, width: 536, height: 220 },
      size: { x: 536, y: 220 },
      relativeTransform: [
        [1, 0, 32],
        [0, 1, 98],
      ],
      layoutMode: 'VERTICAL',
      itemSpacing: 16,
      paddingTop: 24,
      paddingLeft: 24,
      paddingRight: 24,
      paddingBottom: 24,
      cornerRadius: 16,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
      children: [
        {
          id: '10:23',
          type: 'TEXT',
          name: 'Description',
          absoluteBoundingBox: { x: 356, y: 322, width: 440, height: 30 },
          relativeTransform: [
            [1, 0, 24],
            [0, 1, 24],
          ],
          characters: 'Imported typography, layout and assets.',
          style: {
            fontFamily: 'Arial',
            fontSize: 16,
            fontWeight: 400,
            lineHeightPx: 24,
          },
          fills: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.5 } }],
          characterStyleOverrides: [1],
          styleOverrideTable: { 1: { fontWeight: 600 } },
        },
        {
          id: '10:24',
          type: 'VECTOR',
          name: 'Arrow icon',
          absoluteBoundingBox: { x: 356, y: 374, width: 32, height: 32 },
          relativeTransform: [
            [1, 0, 24],
            [0, 1, 76],
          ],
          fills: [{ type: 'SOLID', color: { r: 0.45, g: 0.38, b: 0.9 } }],
          fillGeometry: [
            { path: 'M2 16 H30 M20 6 L30 16 L20 26', windingRule: 'NONZERO' },
          ],
        },
        {
          id: '10:25',
          type: 'RECTANGLE',
          name: 'Photo',
          absoluteBoundingBox: { x: 420, y: 374, width: 80, height: 60 },
          relativeTransform: [
            [1, 0, 88],
            [0, 1, 76],
          ],
          fills: [
            { type: 'IMAGE', imageRef: 'fixture-photo', scaleMode: 'FILL' },
          ],
        },
      ],
    },
  ],
};
const response = {
  name: 'Fixture file',
  version: 'fixture-v1',
  nodes: {
    '10:20': {
      document: root,
      components: {},
      styles: { example: { name: 'Body text' } },
    },
  },
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M2 16H30M20 6L30 16 20 26" fill="none" stroke="#7561e8" stroke-width="3"/></svg>',
);
async function fakeFetch(input, options) {
  const url = new URL(String(input));
  if (url.hostname === 'api.figma.com') {
    if (!options.headers['X-Figma-Token']) throw new Error('Missing token');
    if (url.pathname.endsWith('/nodes')) return Response.json(response);
    if (url.pathname === '/v1/files/fixture/images')
      return Response.json({
        meta: {
          images: { 'fixture-photo': 'https://s3-alpha.figma.com/photo.png' },
        },
      });
    if (url.pathname === '/v1/images/fixture') {
      const images = Object.fromEntries(
        url.searchParams
          .get('ids')
          .split(',')
          .map((id) => [
            id,
            `https://s3-alpha.figma.com/${id.replace(':', '-')}.${url.searchParams.get('format')}`,
          ]),
      );
      return Response.json({ images });
    }
  } else if (url.hostname === 's3-alpha.figma.com') {
    if (options.headers)
      throw new Error('Credentials must not be sent to asset hosts');
    return new Response(url.pathname.endsWith('.svg') ? svg : png);
  }
  throw new Error(`Unexpected fixture request: ${url.hostname}${url.pathname}`);
}
module.exports = { root, response, png, svg, fakeFetch };
