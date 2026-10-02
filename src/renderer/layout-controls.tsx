import type { DesignNode } from '../shared/design';

type Props = {
  node: DesignNode;
  parent?: DesignNode;
  disabled: boolean;
  update: (patch: Partial<DesignNode>) => void;
};
const sizing = ['FIXED', 'HUG', 'FILL'];
const optionLabels: Record<string, string> = {
  MIN: 'Start',
  CENTER: 'Center',
  MAX: 'End',
  SPACE_BETWEEN: 'Space between',
  INHERIT: 'Use parent alignment',
  STRETCH: 'Stretch',
};
const limitLabels = {
  minWidth: 'Minimum width (px)',
  maxWidth: 'Maximum width (px)',
  minHeight: 'Minimum height (px)',
  maxHeight: 'Maximum height (px)',
};
function Choice({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}
      <select
        aria-label={label}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!value && (
          <option value="" disabled>
            Not set
          </option>
        )}
        {value && !options.includes(value) && (
          <option value={value} disabled>
            Saved: {value}
          </option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option === 'HUG'
              ? 'Hug contents'
              : option === 'FILL'
                ? 'Fill container'
                : option === 'FIXED'
                  ? 'Fixed'
                  : (optionLabels[option] ??
                    option.toLowerCase().replaceAll('_', ' '))}
          </option>
        ))}
      </select>
    </label>
  );
}
function NumberField({
  label,
  value,
  disabled,
  onChange,
  optional = false,
  valid,
}: {
  label: string;
  value?: number;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
  optional?: boolean;
  valid?: (value: number | undefined) => boolean;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={label}
        key={`${label}-${value}`}
        type="number"
        step="any"
        min="0"
        max="10000"
        defaultValue={value ?? ''}
        placeholder={optional ? 'Unset' : undefined}
        disabled={disabled}
        onBlur={(event) => {
          const raw = event.target.value.trim(),
            next = raw ? Number(raw) : undefined;
          if (
            (next === undefined
              ? optional
              : Number.isFinite(next) && next >= 0 && next <= 10000) &&
            (!valid || valid(next)) &&
            next !== value
          )
            onChange(next);
          // The persisted snapshot controls the display, including rejected transactions.
          event.target.value = value === undefined ? '' : String(value);
        }}
      />
    </label>
  );
}
export function LayoutControls({ node, parent, disabled, update }: Props) {
  const layout = node.layout,
    item = node.layoutItem;
  const flow =
    layout && ['horizontal', 'vertical', 'grid'].includes(layout.direction);
  const changeLayout = (patch: Partial<NonNullable<DesignNode['layout']>>) => {
    if (layout) update({ layout: { ...layout, ...patch } });
  };
  const changeItem = (patch: Partial<NonNullable<DesignNode['layoutItem']>>) =>
    update({ layoutItem: { ...item, ...patch } });
  const changeMode = (axis: 'width' | 'height', value: string) => {
    const field = axis === 'width' ? 'widthMode' : 'heightMode';
    if (layout) changeLayout({ [field]: value });
    else changeItem({ [field]: value as 'FIXED' | 'HUG' | 'FILL' });
  };
  return (
    <section className="effect-summary" data-layout-editor>
      <h3>Layout controls</h3>
      {node.type === 'frame' && !flow && (
        <>
          <button
            disabled={disabled}
            onClick={() =>
              update({
                layout: {
                  enabled: false,
                  direction: 'horizontal',
                  gap: 0,
                  padding: { top: 0, right: 0, bottom: 0, left: 0 },
                  align: 'MIN',
                  justify: 'MIN',
                  widthMode: 'FIXED',
                  heightMode: 'FIXED',
                  wrap: false,
                },
              })
            }
          >
            Add horizontal auto-layout
          </button>
          <p>
            Starts with fixed frame bounds and saved positions. Set child
            positioning, then enable live auto-layout.
          </p>
        </>
      )}
      {flow && (
        <>
          <Choice
            label="Layout direction"
            value={layout.direction}
            options={['horizontal', 'vertical', 'grid']}
            disabled={disabled}
            onChange={(value) =>
              changeLayout(
                value === 'grid'
                  ? {
                      direction: 'grid',
                      align: 'MIN',
                      justify: 'MIN',
                      wrap: false,
                      widthMode: 'FIXED',
                      heightMode: 'FIXED',
                      grid: layout.grid ?? {
                        columns: [
                          { mode: 'FILL', value: 1 },
                          { mode: 'FILL', value: 1 },
                        ],
                        rows: [
                          { mode: 'FILL', value: 1 },
                          { mode: 'FILL', value: 1 },
                        ],
                        columnGap: Math.max(0, layout.gap),
                        rowGap: Math.max(0, layout.gap),
                      },
                    }
                  : { direction: value as 'horizontal' | 'vertical' },
              )
            }
          />
          {layout.direction !== 'grid' && (
            <NumberField
              label="Gap (px)"
              value={layout.gap}
              disabled={disabled}
              onChange={(value) => changeLayout({ gap: value! })}
            />
          )}
          <div className="field-grid">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <NumberField
                key={side}
                label={`Padding ${side} (px)`}
                value={layout.padding[side]}
                disabled={disabled}
                onChange={(value) =>
                  changeLayout({
                    padding: { ...layout.padding, [side]: value! },
                  })
                }
              />
            ))}
          </div>
          {layout.direction !== 'grid' && (
            <>
              <div className="field-grid">
                <Choice
                  label="Cross-axis alignment"
                  value={layout.align}
                  options={['MIN', 'CENTER', 'MAX']}
                  disabled={disabled}
                  onChange={(value) => changeLayout({ align: value })}
                />
                <Choice
                  label="Main-axis distribution"
                  value={layout.justify}
                  options={['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']}
                  disabled={disabled}
                  onChange={(value) => changeLayout({ justify: value })}
                />
              </div>
              <label>
                <input
                  aria-label="Wrap children"
                  type="checkbox"
                  checked={layout.wrap}
                  disabled={disabled}
                  onChange={(event) =>
                    changeLayout({ wrap: event.target.checked })
                  }
                />{' '}
                Wrap children
              </label>
            </>
          )}
        </>
      )}
      <GridEditor
        node={node}
        parent={parent}
        disabled={disabled}
        update={update}
      />
      <div className="field-grid">
        <Choice
          label="Width sizing"
          value={layout?.widthMode ?? item?.widthMode}
          options={sizing}
          disabled={disabled}
          onChange={(value) => changeMode('width', value)}
        />
        <Choice
          label="Height sizing"
          value={layout?.heightMode ?? item?.heightMode}
          options={sizing}
          disabled={disabled}
          onChange={(value) => changeMode('height', value)}
        />
      </div>
      {node.parentId && (
        <>
          <Choice
            label="Child positioning"
            value={item?.positioning}
            options={['flow', 'absolute']}
            disabled={disabled}
            onChange={(value) =>
              changeItem({ positioning: value as 'flow' | 'absolute' })
            }
          />
          <Choice
            label="Child alignment"
            value={item?.align}
            options={['INHERIT', 'STRETCH', 'MIN', 'CENTER', 'MAX']}
            disabled={disabled}
            onChange={(value) =>
              changeItem({
                align: value as NonNullable<DesignNode['layoutItem']>['align'],
              })
            }
          />
          {item?.positioning === 'absolute' && (
            <div className="field-grid">
              {(['horizontal', 'vertical'] as const).map((axis) => (
                <Choice
                  key={axis}
                  label={`${axis === 'horizontal' ? 'Horizontal' : 'Vertical'} constraint`}
                  value={item.constraints?.[axis]}
                  options={['start', 'end', 'center', 'stretch', 'scale']}
                  disabled={disabled}
                  onChange={(value) =>
                    changeItem({
                      constraints: { ...item.constraints, [axis]: value },
                    })
                  }
                />
              ))}
            </div>
          )}
        </>
      )}
      <div className="field-grid">
        {(['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const).map(
          (field) => {
            const opposite = field.startsWith('min')
              ? field.replace('min', 'max')
              : field.replace('max', 'min');
            const bound = item?.[opposite as 'minWidth'];
            return (
              <NumberField
                key={field}
                label={limitLabels[field]}
                value={item?.[field]}
                optional
                disabled={disabled}
                valid={(value) =>
                  value === undefined ||
                  bound === undefined ||
                  (field.startsWith('min') ? value <= bound : value >= bound)
                }
                onChange={(value) => changeItem({ [field]: value })}
              />
            );
          },
        )}
      </div>
      <p className="property-note">
        Enabled frames recalculate on each edit. Hug text needs available fonts.
        Unsupported layouts reject the edit; undo restores the previous rules
        and positions. Nested frames are enabled individually.
      </p>
    </section>
  );
}

function GridEditor({ node, parent, disabled, update }: Props) {
  const grid = node.layout?.direction === 'grid' ? node.layout.grid : undefined;
  const change = (next: NonNullable<DesignNode['layout']>['grid']) =>
    update({ layout: { ...node.layout!, grid: next } });
  const cell = node.layoutItem?.grid;
  const changeCell = (patch: Partial<NonNullable<typeof cell>>) =>
    update({
      layoutItem: {
        ...node.layoutItem,
        grid: {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          ...cell,
          ...patch,
        },
      },
    });
  return (
    <>
      {node.layout?.direction === 'grid' && !grid && (
        <>
          <p>
            Grid tracks were not supplied. Reimport with the updated plugin or
            define tracks explicitly.
          </p>
          <button
            disabled={disabled}
            onClick={() =>
              change({
                columns: [
                  { mode: 'FILL', value: 1 },
                  { mode: 'FILL', value: 1 },
                ],
                rows: [
                  { mode: 'FILL', value: 1 },
                  { mode: 'FILL', value: 1 },
                ],
                columnGap: 0,
                rowGap: 0,
              })
            }
          >
            Define 2 × 2 grid tracks
          </button>
        </>
      )}
      {grid && (
        <div data-grid-editor>
          <div className="field-grid">
            <NumberField
              label="Column gap (px)"
              value={grid.columnGap}
              disabled={disabled}
              onChange={(v) => change({ ...grid, columnGap: v! })}
            />
            <NumberField
              label="Row gap (px)"
              value={grid.rowGap}
              disabled={disabled}
              onChange={(v) => change({ ...grid, rowGap: v! })}
            />
          </div>
          {(['columns', 'rows'] as const).map((axis) => (
            <div key={axis}>
              <h4>{axis === 'columns' ? 'Columns' : 'Rows'}</h4>
              {grid[axis].map((track, index) => (
                <div key={index} className="field-grid">
                  <Choice
                    label={`${axis === 'columns' ? 'Column' : 'Row'} ${index + 1} sizing`}
                    value={track.mode}
                    options={sizing}
                    disabled={disabled}
                    onChange={(mode) => {
                      const tracks = [...grid[axis]];
                      tracks[index] =
                        mode === 'HUG'
                          ? { mode: 'HUG' }
                          : {
                              mode: mode as 'FIXED' | 'FILL',
                              value: mode === 'FILL' ? 1 : 100,
                            };
                      change({ ...grid, [axis]: tracks });
                    }}
                  />
                  {track.mode !== 'HUG' && (
                    <NumberField
                      label={`${axis === 'columns' ? 'Column' : 'Row'} ${index + 1} ${track.mode === 'FIXED' ? 'size (px)' : 'weight'}`}
                      value={track.value}
                      disabled={disabled}
                      valid={(v) => v !== undefined && v > 0}
                      onChange={(v) => {
                        const tracks = [...grid[axis]];
                        tracks[index] = { ...track, value: v! };
                        change({ ...grid, [axis]: tracks });
                      }}
                    />
                  )}
                </div>
              ))}
              <button
                disabled={disabled || grid[axis].length >= 64}
                onClick={() =>
                  change({
                    ...grid,
                    [axis]: [...grid[axis], { mode: 'FILL', value: 1 }],
                  })
                }
              >
                Add {axis === 'columns' ? 'column' : 'row'}
              </button>
              <button
                disabled={disabled || grid[axis].length <= 1}
                onClick={() =>
                  change({ ...grid, [axis]: grid[axis].slice(0, -1) })
                }
              >
                Remove last {axis === 'columns' ? 'column' : 'row'}
              </button>
            </div>
          ))}
          <p className="property-note">
            Fill tracks share remaining space by weight. A hug container cannot
            have fill tracks on the same axis. Spanning hug tracks and implicit
            extra tracks are not supported yet.
          </p>
        </div>
      )}
      {parent?.layout?.direction === 'grid' && (
        <div data-grid-cell-editor>
          <h4>Grid cell</h4>
          <label>
            <input
              type="checkbox"
              aria-label="Explicit grid cell"
              checked={Boolean(cell)}
              disabled={disabled}
              onChange={(e) =>
                e.target.checked
                  ? changeCell({})
                  : update({
                      layoutItem: { ...node.layoutItem, grid: undefined },
                    })
              }
            />{' '}
            Explicit placement
          </label>
          {cell && (
            <>
              <div className="field-grid">
                {(['row', 'column', 'rowSpan', 'columnSpan'] as const).map(
                  (field) => (
                    <NumberField
                      key={field}
                      label={
                        field === 'row'
                          ? 'Grid row'
                          : field === 'column'
                            ? 'Grid column'
                            : field === 'rowSpan'
                              ? 'Row span'
                              : 'Column span'
                      }
                      value={
                        cell[field] +
                        (field === 'row' || field === 'column' ? 1 : 0)
                      }
                      disabled={disabled}
                      valid={(v) =>
                        v !== undefined &&
                        Number.isInteger(v) &&
                        v >= 1 &&
                        v <= 64
                      }
                      onChange={(v) =>
                        changeCell({
                          [field]:
                            v! -
                            (field === 'row' || field === 'column' ? 1 : 0),
                        })
                      }
                    />
                  ),
                )}
              </div>
              <Choice
                label="Grid horizontal alignment"
                value={cell.horizontalAlign ?? 'AUTO'}
                options={['AUTO', 'MIN', 'CENTER', 'MAX']}
                disabled={disabled}
                onChange={(v) =>
                  changeCell({
                    horizontalAlign: v as NonNullable<
                      typeof cell
                    >['horizontalAlign'],
                  })
                }
              />
              <Choice
                label="Grid vertical alignment"
                value={cell.verticalAlign ?? 'AUTO'}
                options={['AUTO', 'MIN', 'CENTER', 'MAX']}
                disabled={disabled}
                onChange={(v) =>
                  changeCell({
                    verticalAlign: v as NonNullable<
                      typeof cell
                    >['verticalAlign'],
                  })
                }
              />
            </>
          )}
          <p>
            Automatic placement uses the next free cell in row order. Explicit
            cells cannot overlap or exceed the defined tracks.
          </p>
        </div>
      )}
    </>
  );
}
