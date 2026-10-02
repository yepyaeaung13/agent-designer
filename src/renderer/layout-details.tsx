import type { DesignNode } from '../shared/design';
export function LayoutDetails({ node }: { node: DesignNode }) {
  const item = node.layoutItem;
  const values = {
    Recalculation: node.layout?.enabled ? 'Live' : 'Saved positions',
    Width: node.layout?.widthMode ?? item?.widthMode ?? 'Unknown',
    Height: node.layout?.heightMode ?? item?.heightMode ?? 'Unknown',
    Position: item?.positioning ?? 'Unknown',
    Align: item?.align ?? 'Unknown',
    Grow: item?.grow ?? 'Unknown',
    'Horizontal constraint': item?.constraints?.horizontal ?? 'Unknown',
    'Vertical constraint': item?.constraints?.vertical ?? 'Unknown',
    'Minimum width': item?.minWidth ?? 'Unset',
    'Maximum width': item?.maxWidth ?? 'Unset',
    'Minimum height': item?.minHeight ?? 'Unset',
    'Maximum height': item?.maxHeight ?? 'Unset',
  };
  return (
    <section className="effect-summary" data-layout-details>
      <h3>Layout details</h3>
      <dl>
        {Object.entries(values).map(([label, value]) => (
          <div
            key={label}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}
          >
            <dt>{label}</dt>
            <dd style={{ margin: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        {node.layout?.enabled
          ? 'Live layout measures hug text with loaded fonts and updates child bounds after edits. Grid needs explicit tracks; baseline alignment is not supported yet.'
          : 'Saved rules for coding. Enable live auto-layout on a supported frame to recalculate it.'}
      </p>
    </section>
  );
}
