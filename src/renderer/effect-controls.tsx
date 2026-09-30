import type { DesignNode } from '../shared/design';

export function EffectControls({
  node,
  disabled,
  update,
}: {
  node: DesignNode;
  disabled: boolean;
  update: (patch: Partial<DesignNode>) => void;
}) {
  const shadow = node.shadow ?? {
    enabled: false,
    color: '#000000',
    opacity: 0.25,
    blur: 12,
    x: 0,
    y: 4,
  };
  return (
    <>
      <h3>Border</h3>
      <label>
        Border color
        <input
          type="color"
          value={node.stroke ?? '#000000'}
          disabled={disabled}
          onChange={(event) =>
            update({
              stroke: event.target.value,
              strokeWidth: node.strokeWidth || 1,
            })
          }
        />
      </label>
      <label>
        Border width (px)
        <input
          key={node.strokeWidth ?? 0}
          type="number"
          min="0"
          step="any"
          defaultValue={node.strokeWidth ?? 0}
          disabled={disabled}
          onBlur={(event) => {
            const width = Number(event.target.value);
            if (Number.isFinite(width) && width >= 0)
              update({ stroke: node.stroke ?? '#000000', strokeWidth: width });
          }}
        />
      </label>
      <h3>Shadow</h3>
      <label>
        <input
          type="checkbox"
          checked={shadow.enabled}
          disabled={disabled}
          onChange={(event) =>
            update({ shadow: { ...shadow, enabled: event.target.checked } })
          }
        />
        Enable shadow
      </label>
      {shadow.enabled && (
        <>
          <label>
            Shadow color
            <input
              type="color"
              value={shadow.color}
              disabled={disabled}
              onChange={(event) =>
                update({ shadow: { ...shadow, color: event.target.value } })
              }
            />
          </label>
          <div className="field-grid">
            {(
              [
                ['opacity', 'Shadow opacity (%)', 0, 100],
                ['blur', 'Shadow blur (px)', 0, 500],
                ['x', 'Shadow X', -5000, 5000],
                ['y', 'Shadow Y', -5000, 5000],
              ] as const
            ).map(([field, label, min, max]) => {
              const value =
                field === 'opacity' ? shadow.opacity * 100 : shadow[field];
              return (
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
                        next >= min &&
                        next <= max
                      )
                        update({
                          shadow: {
                            ...shadow,
                            [field]: field === 'opacity' ? next / 100 : next,
                          },
                        });
                      else event.target.value = String(value);
                    }}
                  />
                </label>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

export function canvasEffects(node: DesignNode) {
  return {
    stroke: node.stroke,
    strokeWidth: node.strokeWidth ?? 0,
    shadowEnabled: node.shadow?.enabled ?? false,
    shadowColor: node.shadow?.color ?? '#000000',
    shadowOpacity: node.shadow?.opacity ?? 0,
    shadowBlur: node.shadow?.blur ?? 0,
    shadowOffsetX: node.shadow?.x ?? 0,
    shadowOffsetY: node.shadow?.y ?? 0,
    shadowForStrokeEnabled: false,
  };
}
