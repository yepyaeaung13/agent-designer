import { ensureFonts } from './font-manager';
import { useState, type RefObject } from 'react';
import Konva from 'konva';
import type { DesignNode } from '../shared/design';
import { exportExtent, exportPng, exportSvg } from './layer-export';

export function ExportControls({
  node,
  nodes,
  documentId,
  stage,
  busy,
}: {
  node: DesignNode;
  nodes: DesignNode[];
  documentId: string;
  stage: RefObject<Konva.Stage | null>;
  busy: boolean;
}) {
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [scale, setScale] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const bounds = exportExtent(node);
  async function save() {
    setExporting(true);
    setMessage('Preparing export…');
    try {
      await ensureFonts();
      if (!stage.current) throw new Error('Canvas is not ready.');
      const data =
        format === 'png'
          ? await exportPng(stage.current, node, scale)
          : await exportSvg(node, nodes, documentId, scale);
      const saved = await window.designer.saveExport({
        name: `${node.name}${scale > 1 ? `@${scale}x` : ''}`,
        format,
        data,
      });
      setMessage(saved ? 'Export saved.' : 'Export canceled.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="layer-export" aria-label="Export selected layer">
      <h3>Export</h3>
      <div className="field-grid">
        <label>
          Scale
          <select
            value={scale}
            disabled={exporting}
            onChange={(event) => setScale(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select
            value={format}
            disabled={exporting}
            onChange={(event) => setFormat(event.target.value as 'png' | 'svg')}
          >
            <option value="png">PNG</option>
            <option value="svg">SVG</option>
          </select>
        </label>
      </div>
      <p className="property-note">
        {Math.ceil(bounds.width * scale)} × {Math.ceil(bounds.height * scale)} ·
        Includes visible child layers. SVG keeps shapes and text; imported
        raster assets remain embedded images.
      </p>
      <button
        className="primary"
        disabled={busy || exporting || !node.visible}
        onClick={() => void save()}
      >
        {exporting ? 'Exporting…' : `Export ${node.name}`}
      </button>
      {message && (
        <p className="property-note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
