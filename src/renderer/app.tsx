import { FontControls } from './font-controls';
import {
  ensureFonts,
  fontStack,
  fontVersion,
  onFontsChanged,
} from './font-manager';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TypographyControls } from './typography-controls';
import { ExportControls } from './export-controls';
import { CodingHandoff } from './coding-handoff';
import { SpacingOverlay } from './spacing-overlay';
import { ShadowGroup } from './shadow-group';
import { EffectControls, canvasEffects } from './effect-controls';
import { useRightPan } from './use-right-pan';
import {
  Stage,
  Layer,
  Group,
  Rect,
  Ellipse,
  Text,
  Transformer,
  useStrictMode,
} from 'react-konva';
import Konva from 'konva';
import {
  makeNode,
  type DesignCommand,
  type DesignNode,
  type Snapshot,
  type ConnectionInfo,
  type WorkspaceAction,
} from '../shared/design';
import { WorkspaceControls } from './workspace-controls';
import {
  AssetImage,
  FigmaImportButton,
  FigmaReference,
} from './figma-controls';
import '../index.css';
import './theme.css';
import './current-preview';

function savedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('designer-theme') === 'light'
      ? 'light'
      : 'dark';
  } catch {
    return 'dark';
  }
}
const initialTheme = savedTheme();
document.documentElement.dataset.theme = initialTheme;

const symbols = {
  frame: '▣',
  rectangle: '□',
  ellipse: '○',
  text: 'T',
  image: '▧',
};
useStrictMode(true);
function App() {
  const [fontsVersion, setFontsVersion] = useState(fontVersion());
  useEffect(() => {
    const unsubscribe = onFontsChanged(() => setFontsVersion(fontVersion()));
    void ensureFonts().catch(() => {});
    return unsubscribe;
  }, []);
  const [theme, setTheme] = useState(initialTheme);
  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('designer-theme', next);
    } catch {
      /* Theme still works when storage is unavailable. */
    }
  }
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const [selection, select] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [showConnection, setShowConnection] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hand, setHand] = useState(false);
  const [size, setSize] = useState({ width: 800, height: 700 });
  const viewport = useRef<HTMLDivElement>(null);
  useRightPan(viewport, setPan);
  const stage = useRef<Konva.Stage>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const page = snapshot?.document.pages.find(
    (item) => item.id === snapshot.activePageId,
  );
  const selected = page?.nodes.find((node) => node.id === selection);
  const shadowOwners: DesignNode[] = [];
  let ancestor = selected;
  while (ancestor) {
    if (ancestor.shadow?.enabled) shadowOwners.push(ancestor);
    ancestor = page?.nodes.find((node) => node.id === ancestor?.parentId);
  }
  function editEffects(id: string) {
    select(id);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .querySelector('[data-effect-controls]')
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }),
    );
  }
  const accept = (value: Snapshot) => {
    if (value.document.id !== value.activeDocumentId) return;
    if (!current.current || value.sequence >= current.current.sequence) {
      if (
        current.current?.document.id !== value.document.id ||
        current.current?.activePageId !== value.activePageId
      ) {
        select(null);
        setZoom(1);
        setPan({ x: 0, y: 0 });
        setHand(false);
      }
      current.current = value;
      setSnapshot(value);
    }
  };
  useEffect(() => {
    if (!window.designer) {
      setError('Open this editor through Electron with npm start.');
      return;
    }
    const unsubscribe = window.designer.onChanged(accept);
    void window.designer
      .read()
      .then(accept)
      .catch((e) => setError(String(e)));
    void window.designer
      .connection()
      .then(setConnection)
      .catch((e) => setError(String(e)));
    return unsubscribe;
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const node = stage.current?.findOne(`#${selection}`);
    transformer.current?.nodes(
      node && selected?.visible && !selected.locked && !hand ? [node] : [],
    );
  }, [selection, snapshot, hand, selected]);

  async function execute(command: DesignCommand) {
    if (!current.current || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      accept(
        await window.designer.execute({
          documentId: current.current.document.id,
          pageId: current.current.activePageId,
          expectedRevision: current.current.document.revision,
          command,
        }),
      );
      return true;
    } catch (e) {
      setError(String(e));
      try {
        accept(await window.designer.read());
      } catch {
        /* Preserve the last visible document. */
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function importFigma(input: { url: string; token: string }) {
    if (pending.current)
      throw new Error('Wait for the current edit to finish.');
    pending.current = true;
    setBusy(true);
    try {
      accept(await window.designer.importFigma(input));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function importBundle() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const snapshot = await window.designer.importBundle();
      if (snapshot) accept(snapshot);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function workspace(action: WorkspaceAction) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      accept(await window.designer.workspace(action));
      return true;
    } catch (e) {
      setError(String(e));
      try {
        accept(await window.designer.read());
      } catch {
        /* Retain the last visible document. */
      }
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const update = (patch: Partial<DesignNode>) => {
    if (selected) void execute({ type: 'update', id: selected.id, patch });
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,button,dialog,[contenteditable]',
        )
      )
        return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection && !selected?.locked) {
          event.preventDefault();
          void execute({ type: 'delete', id: selection });
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void execute({ type: event.shiftKey ? 'redo' : 'undo' });
      }
      if (event.key === 'Escape') {
        select(null);
        setHand(false);
      }
      if (event.key.toLowerCase() === 'h') setHand(true);
      if (event.key.toLowerCase() === 'v') setHand(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  function add(type: DesignNode['type']) {
    const node = makeNode(
      type,
      Math.round((80 - pan.x) / zoom),
      Math.round((80 - pan.y) / zoom),
    );
    if (selected?.type === 'frame' && !selected.locked && type !== 'frame') {
      node.parentId = selected.id;
      node.x = 40;
      node.y = 40;
    }
    select(node.id);
    setHand(false);
    void execute({ type: 'create', node });
  }
  function renderNodes(parentId: string | null): React.ReactNode {
    return page?.nodes
      .filter((node) => node.parentId === parentId)
      .map((node) => {
        const properties = {
          ...canvasEffects(node),
          shadowEnabled: node.type === 'frame' ? false : node.shadow?.enabled,
          width: node.width,
          height: node.height,
          fill: node.fill,
          opacity: node.fillOpacity ?? 1,
          stroke: node.stroke,
          strokeWidth: node.strokeWidth,
        };
        return (
          <Group
            key={node.id}
            id={node.id}
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rotation={node.rotation}
            opacity={node.opacity}
            visible={node.visible}
            draggable={!hand && !node.locked && !busy}
            onClick={(event) => {
              if (!hand) {
                event.cancelBubble = true;
                select(node.id);
              }
            }}
            onTap={(event) => {
              event.cancelBubble = true;
              select(node.id);
            }}
            onDragStart={(event) => {
              event.cancelBubble = true;
              select(node.id);
            }}
            onDragEnd={(event) => {
              event.cancelBubble = true;
              void execute({
                type: 'update',
                id: node.id,
                patch: {
                  x: Math.round(event.target.x()),
                  y: Math.round(event.target.y()),
                },
              });
            }}
            onTransformEnd={(event) => {
              event.cancelBubble = true;
              const target = event.target;
              const width = Math.max(
                1,
                Math.round(node.width * target.scaleX()),
              );
              const height = Math.max(
                1,
                Math.round(node.height * target.scaleY()),
              );
              target.scale({ x: 1, y: 1 });
              void execute({
                type: 'update',
                id: node.id,
                patch: {
                  x: Math.round(target.x()),
                  y: Math.round(target.y()),
                  width,
                  height,
                  rotation: Math.round(target.rotation()),
                },
              });
            }}
          >
            <ShadowGroup
              shadow={node.type === 'frame' ? node.shadow : undefined}
            >
              {node.assetId ? (
                <AssetImage
                  documentId={snapshot!.document.id}
                  assetId={node.assetId}
                  effects={canvasEffects(node)}
                  width={node.width}
                  height={node.height}
                />
              ) : node.type === 'ellipse' ? (
                <Ellipse
                  {...canvasEffects(node)}
                  x={node.width / 2}
                  y={node.height / 2}
                  radiusX={node.width / 2}
                  radiusY={node.height / 2}
                  fill={node.fill}
                  opacity={node.fillOpacity ?? 1}
                  stroke={node.stroke}
                  strokeWidth={node.strokeWidth}
                />
              ) : node.type === 'text' ? (
                <Text
                  key={fontsVersion}
                  {...properties}
                  text={node.text}
                  fontSize={node.fontSize}
                  fontFamily={fontStack(node.fontFamily)}
                  fontStyle={`${node.fontStyle === 'italic' ? 'italic ' : ''}${node.fontWeight ?? 400}`}
                  lineHeight={
                    node.lineHeight ? node.lineHeight / node.fontSize : 1
                  }
                  letterSpacing={node.letterSpacing ?? 0}
                  align={node.textAlign ?? 'left'}
                />
              ) : (
                <Rect {...properties} cornerRadius={node.cornerRadius} />
              )}
              {node.backgroundAssetId && (
                <AssetImage
                  documentId={snapshot!.document.id}
                  assetId={node.backgroundAssetId}
                  width={node.width}
                  height={node.height}
                  cover
                />
              )}
              {node.type === 'frame' && (
                <Group
                  clipWidth={node.clipsContent ? node.width : undefined}
                  clipHeight={node.clipsContent ? node.height : undefined}
                >
                  {renderNodes(node.id)}
                </Group>
              )}
            </ShadowGroup>
          </Group>
        );
      });
  }
  function layers(parentId: string | null, depth = 0): React.ReactNode {
    return page?.nodes
      .filter((node) => node.parentId === parentId)
      .slice()
      .reverse()
      .map((node) => (
        <div key={node.id}>
          <button
            className={`layer-row ${selection === node.id ? 'active' : ''}`}
            style={{ paddingLeft: 16 + depth * 14 }}
            onClick={() => select(node.id)}
          >
            <span className="node-icon">{symbols[node.type]}</span>
            <span className="layer-name">{node.name}</span>
            <span className="muted">
              {node.locked ? '⌑' : !node.visible ? '–' : ''}
            </span>
          </button>
          {layers(node.id, depth + 1)}
        </div>
      ));
  }
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">a</span>
          <strong>
            agent<span>designer</span>
          </strong>
        </div>
        <div className="document-name">
          <WorkspaceControls
            snapshot={snapshot}
            busy={busy}
            error={error}
            workspace={workspace}
            execute={execute}
            surface="documents"
          />
          <span className="local-badge">LOCAL</span>
        </div>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
          <FigmaImportButton busy={busy} onImport={importFigma} />
          <button
            disabled={busy}
            onClick={() => void importBundle()}
            title="Import a file saved by the Agent Designer Figma plugin"
          >
            Import export file
          </button>
          <button
            className="agent-button"
            onClick={() => setShowConnection(true)}
          >
            <span className={`dot ${connection?.url ? 'online' : ''}`} />
            Connect agent
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar left">
          <WorkspaceControls
            snapshot={snapshot}
            busy={busy}
            error={error}
            workspace={workspace}
            execute={execute}
            surface="pages"
          />
          <div className="section-title layers-heading">
            LAYERS<span>{page?.nodes.length ?? 0}</span>
          </div>
          <div className="layer-list">{layers(null)}</div>
          <div className="sidebar-footer">
            <span className="dot online" />
            Stored on this device
          </div>
        </aside>
        <main className="canvas-column">
          <FigmaReference snapshot={snapshot} selection={selection} />
          <CodingHandoff snapshot={snapshot} selection={selection} />
          <FontControls nodes={page?.nodes ?? []} />
          <div className="toolbar">
            <div className="tool-group">
              <button
                title="Select (V)"
                className={!hand ? 'tool selected' : 'tool'}
                onClick={() => setHand(false)}
              >
                ↖
              </button>
              <button
                title="Pan (H)"
                className={hand ? 'tool selected' : 'tool'}
                onClick={() => setHand(true)}
              >
                ✥
              </button>
            </div>
            <div className="divider" />
            {(['frame', 'rectangle', 'ellipse', 'text'] as const).map(
              (type) => (
                <button
                  key={type}
                  disabled={!snapshot || busy}
                  className="tool"
                  title={`Add ${type}`}
                  aria-label={`Add ${type}`}
                  onClick={() => add(type)}
                >
                  {symbols[type]}
                </button>
              ),
            )}
            <div className="toolbar-spacer" />
            <button
              title="Undo (Ctrl+Z)"
              disabled={!snapshot?.canUndo || busy}
              onClick={() => void execute({ type: 'undo' })}
            >
              ↶
            </button>
            <button
              title="Redo (Ctrl+Shift+Z)"
              disabled={!snapshot?.canRedo || busy}
              onClick={() => void execute({ type: 'redo' })}
            >
              ↷
            </button>
            <div className="divider" />
            <button
              aria-label="Zoom out"
              onClick={() => setZoom(Math.max(0.2, zoom - 0.1))}
            >
              −
            </button>
            <button
              title="Reset view"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              onClick={() => setZoom(Math.min(3, zoom + 0.1))}
            >
              +
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError('')}>Dismiss</button>
            </div>
          )}
          <div
            className={`canvas-viewport ${hand ? 'hand' : ''}`}
            ref={viewport}
          >
            <Stage
              ref={stage}
              width={size.width}
              height={size.height}
              x={pan.x}
              y={pan.y}
              scaleX={zoom}
              scaleY={zoom}
              draggable={hand}
              onMouseDown={(event) => {
                if (event.target === event.target.getStage()) select(null);
              }}
              onDragEnd={(event) => {
                if (event.target === stage.current)
                  setPan({ x: event.target.x(), y: event.target.y() });
              }}
              onWheel={(event) => {
                event.evt.preventDefault();
                const pointer = stage.current?.getPointerPosition();
                if (!pointer) return;
                const next = Math.max(
                  0.2,
                  Math.min(3, zoom * (event.evt.deltaY > 0 ? 0.92 : 1.08)),
                );
                setPan({
                  x: pointer.x - ((pointer.x - pan.x) / zoom) * next,
                  y: pointer.y - ((pointer.y - pan.y) / zoom) * next,
                });
                setZoom(next);
              }}
            >
              <Layer>
                {renderNodes(null)}
                <Transformer
                  ref={transformer}
                  rotateEnabled={true}
                  flipEnabled={false}
                  borderStroke="#7561e8"
                  anchorStroke="#7561e8"
                  anchorFill="#ffffff"
                  anchorSize={7}
                  enabledAnchors={selected?.type === 'frame' ? [] : undefined}
                  boundBoxFunc={(oldBox, newBox) =>
                    newBox.width < 8 ||
                    newBox.height < 8 ||
                    newBox.width > 10000 * zoom ||
                    newBox.height > 10000 * zoom
                      ? oldBox
                      : newBox
                  }
                />
              </Layer>
            </Stage>
            <SpacingOverlay
              stage={stage}
              viewport={viewport}
              selected={selected}
              nodes={page?.nodes ?? []}
              zoom={zoom}
              pan={pan}
              revision={snapshot?.document.revision}
            />
            <div className="canvas-hint">
              Scroll to zoom <span>·</span> Right-drag to pan <span>·</span> H
              to pan <span>·</span> V to select
            </div>
          </div>
          <footer className="statusbar">
            <span>
              {busy
                ? 'Saving…'
                : snapshot
                  ? '✓ All changes saved locally'
                  : 'Opening…'}
            </span>
            <span>
              {selected
                ? `${selected.type} · ${Math.round(selected.width)} × ${Math.round(selected.height)}`
                : 'Your ideas stay yours.'}
            </span>
          </footer>
        </main>
        <aside className="sidebar right">
          <div className="inspector-tabs">
            <strong>Design</strong>
            <span>Local canvas</span>
          </div>
          {selected ? (
            <div className="inspector" key={selected.id}>
              <div className="selection-heading">
                <span className="node-icon">{symbols[selected.type]}</span>
                <strong>
                  {selected.type[0].toUpperCase() + selected.type.slice(1)}
                </strong>
              </div>
              <label>
                Name
                <input
                  key={`${selected.id}-${selected.name}`}
                  defaultValue={selected.name}
                  disabled={busy}
                  onBlur={(event) => {
                    if (event.target.value !== selected.name)
                      update({ name: event.target.value });
                  }}
                />
              </label>
              <section className="effect-summary" aria-label="Layer appearance">
                <strong>Layer appearance</strong>
                {selected.stroke && !!selected.strokeWidth && (
                  <div>
                    Border: {selected.stroke} · {selected.strokeWidth}px
                  </div>
                )}
                {shadowOwners.map((owner) => (
                  <div key={owner.id}>
                    <div>
                      {owner.id === selected.id
                        ? 'Shadow on this layer'
                        : `Shadow on parent: ${owner.name}`}
                    </div>
                    <div>
                      {owner.shadow!.color} ·{' '}
                      {Math.round(owner.shadow!.opacity * 100)}% · Blur{' '}
                      {owner.shadow!.blur}px · X {owner.shadow!.x} · Y{' '}
                      {owner.shadow!.y}
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => editEffects(owner.id)}
                    >
                      {owner.id === selected.id
                        ? 'Edit shadow'
                        : `Edit ${owner.name} shadow`}
                    </button>
                  </div>
                ))}
                {!shadowOwners.length && (
                  <div>No shadow on this layer or its parents.</div>
                )}
                <button
                  disabled={busy}
                  onClick={() => editEffects(selected.id)}
                >
                  Border & shadow controls
                </button>
              </section>
              <h3>Position & size</h3>
              <div className="field-grid">
                {(['x', 'y', 'width', 'height', 'rotation'] as const).map(
                  (field) => (
                    <label key={field}>
                      {field}
                      <input
                        key={`${field}-${selected[field]}`}
                        type="number"
                        defaultValue={Math.round(selected[field])}
                        disabled={busy || selected.locked}
                        onBlur={(event) => {
                          const value = Number(event.target.value);
                          if (event.target.value && value !== selected[field])
                            update({ [field]: value });
                        }}
                      />
                    </label>
                  ),
                )}
              </div>
              <h3>Appearance</h3>
              <label className="color-row">
                <input
                  type="color"
                  value={selected.fill}
                  disabled={busy || selected.locked}
                  onChange={(event) => update({ fill: event.target.value })}
                />
                <span>{selected.fill.toUpperCase()}</span>
              </label>
              <div className="field-grid">
                <label>
                  Opacity
                  <input
                    key={selected.opacity}
                    type="number"
                    min="0"
                    max="100"
                    defaultValue={selected.opacity * 100}
                    onBlur={(event) =>
                      update({ opacity: Number(event.target.value) / 100 })
                    }
                    disabled={busy || selected.locked}
                  />
                </label>
                <label>
                  Radius
                  <input
                    key={selected.cornerRadius}
                    type="number"
                    min="0"
                    defaultValue={selected.cornerRadius}
                    onBlur={(event) =>
                      update({ cornerRadius: Number(event.target.value) })
                    }
                    disabled={busy || selected.locked}
                  />
                </label>
              </div>
              {selected.type === 'text' && (
                <>
                  <h3>Typography</h3>
                  <TypographyControls
                    node={selected}
                    disabled={busy || selected.locked}
                    update={update}
                  />
                  <label>
                    Content
                    <textarea
                      key={selected.text}
                      defaultValue={selected.text}
                      onBlur={(event) => update({ text: event.target.value })}
                      disabled={busy || selected.locked}
                    />
                  </label>
                  <label>
                    Font size
                    <input
                      key={selected.fontSize}
                      type="number"
                      defaultValue={selected.fontSize}
                      onBlur={(event) =>
                        update({ fontSize: Number(event.target.value) })
                      }
                      disabled={busy || selected.locked}
                    />
                  </label>
                </>
              )}
              <div data-effect-controls>
                <EffectControls
                  node={selected}
                  disabled={busy || selected.locked}
                  update={update}
                />
              </div>
              <div className="toggles">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.visible}
                    onChange={(event) =>
                      update({ visible: event.target.checked })
                    }
                    disabled={busy}
                  />
                  Visible
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.locked}
                    onChange={(event) =>
                      update({ locked: event.target.checked })
                    }
                    disabled={busy}
                  />
                  Locked
                </label>
              </div>
              <ExportControls
                node={selected}
                nodes={page!.nodes}
                documentId={snapshot!.document.id}
                stage={stage}
                busy={busy}
              />
              <button
                className="delete-button"
                disabled={busy || selected.locked}
                onClick={() => {
                  void execute({ type: 'delete', id: selected.id });
                  select(null);
                }}
              >
                Delete layer
              </button>
            </div>
          ) : (
            <div className="empty-inspector">
              <div className="empty-icon">↖</div>
              <h3>A little space to create.</h3>
              <p>
                Select a layer to edit its properties, or add something new from
                the toolbar.
              </p>
              <div className="tip">
                Start with a frame.
                <br />
                Give your next idea a home.
              </div>
            </div>
          )}
        </aside>
      </div>
      {showConnection && (
        <div
          className="modal-backdrop"
          onClick={() => setShowConnection(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Connect an agent"
            className="modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>Connect an agent</h2>
              <button
                aria-label="Close"
                onClick={() => setShowConnection(false)}
              >
                ×
              </button>
            </div>
            <p>
              Your agent can read and edit this canvas while the app is open.
              Use a client that supports Streamable HTTP and a bearer token.
            </p>
            {connection?.url ? (
              <>
                <label>
                  Server URL
                  <input readOnly value={connection.url} />
                </label>
                <label>
                  Bearer token
                  <input
                    readOnly
                    type="password"
                    value={connection.token ?? ''}
                  />
                </label>
                <button
                  className="primary"
                  onClick={() => {
                    void window.designer
                      .copyText(
                        JSON.stringify(
                          {
                            url: connection.url,
                            headers: {
                              Authorization: `Bearer ${connection.token}`,
                            },
                          },
                          null,
                          2,
                        ),
                      )
                      .then(() => setShowConnection(false))
                      .catch((e) => setError(String(e)));
                  }}
                >
                  Copy connection settings
                </button>
                <p className="muted">
                  Connection settings change when the app restarts. Share the
                  token only with agents you trust to edit your design.
                </p>
              </>
            ) : (
              <p className="error">
                {connection?.error ?? 'Starting local server…'}
              </p>
            )}
            <label>
              Saved design location
              <input readOnly value={connection?.databasePath ?? ''} />
            </label>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
