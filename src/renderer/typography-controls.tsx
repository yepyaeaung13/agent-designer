import type { DesignNode } from '../shared/design';

export function TypographyControls({
  node,
  disabled,
  update,
}: {
  node: DesignNode;
  disabled: boolean;
  update: (patch: Partial<DesignNode>) => void;
}) {
  return (
    <>
      <label>
        Font family
        <input
          key={node.fontFamily ?? 'Arial'}
          defaultValue={node.fontFamily ?? 'Arial'}
          disabled={disabled}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value && value !== node.fontFamily)
              update({ fontFamily: value });
          }}
        />
      </label>
      <div className="field-grid">
        {(
          [
            ['fontWeight', 'Font weight', node.fontWeight ?? 400, 1, 1000],
            [
              'lineHeight',
              'Line height (px)',
              node.lineHeight ?? node.fontSize,
              0.1,
              undefined,
            ],
            [
              'letterSpacing',
              'Letter spacing (px)',
              node.letterSpacing ?? 0,
              undefined,
              undefined,
            ],
          ] as const
        ).map(([field, label, value, min, max]) => (
          <label key={field}>
            {label}
            <input
              key={`${field}-${value}`}
              type="number"
              step="any"
              min={min}
              max={max}
              defaultValue={value}
              disabled={disabled}
              onBlur={(event) => {
                const next = Number(event.target.value);
                if (
                  event.target.value &&
                  Number.isFinite(next) &&
                  (min === undefined || next >= min) &&
                  (max === undefined || next <= max)
                ) {
                  if (next !== value) update({ [field]: next });
                } else event.target.value = String(value);
              }}
            />
          </label>
        ))}
        <label>
          Font style
          <select
            value={node.fontStyle ?? 'normal'}
            disabled={disabled}
            onChange={(event) =>
              update({
                fontStyle: event.target.value as DesignNode['fontStyle'],
              })
            }
          >
            <option value="normal">Normal</option>
            <option value="italic">Italic</option>
          </select>
        </label>
        <label>
          Text alignment
          <select
            value={node.textAlign ?? 'left'}
            disabled={disabled}
            onChange={(event) =>
              update({
                textAlign: event.target.value as DesignNode['textAlign'],
              })
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
            <option value="justify">Justify</option>
          </select>
        </label>
      </div>
      <p className="property-note">
        Font families must be installed on this device. Imported layout and
        original Figma properties are also available to your coding agent.
      </p>
    </>
  );
}
