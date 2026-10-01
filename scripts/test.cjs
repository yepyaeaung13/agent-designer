const { spawnSync } = require('node:child_process');
const electron = require('electron');
const result = spawnSync(
  electron,
  [
    '--import',
    'tsx',
    '--test',
    'tests/document.test.ts',
    'tests/figma.test.ts',
    'tests/bundle.test.ts',
    'tests/spacing.test.ts',
    'tests/coding-brief.test.ts',
    'tests/current-preview.test.ts',
    'tests/design-changes.test.ts',
    'tests/fonts.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
);
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
