import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureSpacing } from '../src/renderer/spacing';
test('spacing measures gaps and parent insets in design pixels at different zooms', () => {
  const a = { x: 10, y: 20, width: 40, height: 30 };
  assert.deepEqual(
    measureSpacing(a, { ...a, x: 70 }, 1).map((line) => line.value),
    [20],
  );
  assert.deepEqual(
    measureSpacing(a, { ...a, y: 65 }, 1).map((line) => line.value),
    [15],
  );
  assert.deepEqual(
    measureSpacing(a, { x: 0, y: 0, width: 100, height: 100 }, 1).map(
      (line) => line.value,
    ),
    [10, 50, 20, 50],
  );
  const scaled = (box: typeof a) => ({
    x: box.x * 2 + 100,
    y: box.y * 2 + 80,
    width: box.width * 2,
    height: box.height * 2,
  });
  assert.deepEqual(
    measureSpacing(scaled(a), scaled({ ...a, x: 70 }), 2).map(
      (line) => line.value,
    ),
    [20],
  );
  assert.deepEqual(measureSpacing(a, a, 1), []);
});
