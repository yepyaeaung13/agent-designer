import { useEffect, useState, type RefObject } from 'react';
import Konva from 'konva';
import type { DesignNode } from '../shared/design';
import { measureSpacing, type Box } from './spacing';
import './spacing.css';

export function SpacingOverlay({
  stage,
  viewport,
  selected,
  nodes,
  zoom,
  pan,
  revision,
}: {
  stage: RefObject<Konva.Stage | null>;
  viewport: RefObject<HTMLDivElement | null>;
  selected?: DesignNode;
  nodes: DesignNode[];
  zoom: number;
  pan: { x: number; y: number };
  revision?: number;
}) {
  const [boxes, setBoxes] = useState<{ a: Box; b: Box; name: string }>();
  useEffect(() => {
    setBoxes(undefined);
    let alt = false;
    let pointer: { x: number; y: number } | undefined;
    const container = viewport.current;
    const clear = () => {
      alt = false;
      setBoxes(undefined);
    };
    function bounds(id: string): Box | undefined {
      const node = stage.current?.findOne(`#${id}`);
      const model = nodes.find((item) => item.id === id);
      if (!node || !model || !node.isVisible()) return;
      const transform = node.getAbsoluteTransform();
      const corners = [
        [0, 0],
        [model.width, 0],
        [0, model.height],
        [model.width, model.height],
      ].map(([x, y]) => transform.point({ x, y }));
      const xs = corners.map((point) => point.x),
        ys = corners.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    }
    function refresh() {
      if (!alt || !pointer || !selected || !stage.current) {
        setBoxes(undefined);
        return;
      }
      let hit: Konva.Node | null = stage.current.getIntersection(pointer);
      while (hit && !nodes.some((node) => node.id === hit!.id()))
        hit = hit.getParent();
      let target = nodes.find((node) => node.id === hit?.id());
      if (!target || target.id === selected.id)
        target = nodes.find((node) => node.id === selected.parentId);
      const a = bounds(selected.id),
        b = target && bounds(target.id);
      setBoxes(a && b && target ? { a, b, name: target.name } : undefined);
    }
    const move = (event: MouseEvent) => {
      if (event.buttons) {
        setBoxes(undefined);
        return;
      }
      const rect = container!.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      alt = event.altKey;
      refresh();
    };
    const down = (event: KeyboardEvent) => {
      if (
        event.key !== 'Alt' ||
        (event.target as HTMLElement)?.closest(
          'input, textarea, select, [contenteditable], dialog',
        )
      )
        return;
      event.preventDefault();
      alt = true;
      refresh();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Alt') clear();
    };
    const leave = () => {
      pointer = undefined;
      setBoxes(undefined);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    container?.addEventListener('mousemove', move);
    container?.addEventListener('mouseleave', leave);
    container?.addEventListener('mousedown', leave);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      container?.removeEventListener('mousemove', move);
      container?.removeEventListener('mouseleave', leave);
      container?.removeEventListener('mousedown', leave);
    };
  }, [stage, viewport, selected, nodes, zoom, pan, revision]);
  if (!boxes) return null;
  return (
    <svg
      className="spacing-overlay"
      aria-label={`Spacing to ${boxes.name} in design pixels`}
    >
      <rect {...boxes.b} fill="none" stroke="#ff527c" strokeDasharray="4 3" />
      {measureSpacing(boxes.a, boxes.b, zoom).map((line, index) => {
        const x = (line.x1 + line.x2) / 2,
          y = (line.y1 + line.y2) / 2;
        const width = String(line.value).length * 7 + 12;
        return (
          <g key={index}>
            <line
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="#ff527c"
            />
            <rect
              x={x - width / 2}
              y={y - 10}
              width={width}
              height={20}
              rx={4}
              fill="#ce2453"
            />
            <text
              x={x}
              y={y + 4}
              textAnchor="middle"
              fill="white"
              fontSize={12}
            >
              {line.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
