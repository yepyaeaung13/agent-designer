import { useEffect, useRef, useState } from 'react';
import { Image as CanvasImage, Rect } from 'react-konva';
import type { Snapshot } from '../shared/design';
import { useShadowImageReady } from './shadow-group';
import type { canvasEffects } from './effect-controls';
import './figma.css';

export function AssetImage({
  documentId,
  assetId,
  width,
  height,
  cover = false,
  effects,
}: {
  documentId: string;
  assetId: string;
  width: number;
  height: number;
  cover?: boolean;
  effects?: ReturnType<typeof canvasEffects>;
}) {
  const [image, setImage] = useState<HTMLImageElement>();
  const imageReady = useShadowImageReady();
  useEffect(() => {
    if (image) imageReady();
  }, [image, imageReady]);
  useEffect(() => {
    let cancelled = false;
    setImage(undefined);
    void window.designer
      .asset(documentId, assetId)
      .then((url) => {
        const loaded = new window.Image();
        loaded.onload = () => {
          if (!cancelled) setImage(loaded);
        };
        loaded.src = url;
      })
      .catch(() => {
        /* A missing image remains visibly marked. */
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, assetId]);
  if (!image)
    return (
      <Rect
        width={width}
        height={height}
        fill="#eeeaf5"
        stroke="#b7adc9"
        dash={[4, 4]}
      />
    );
  let crop;
  if (cover) {
    const ratio = Math.max(width / image.width, height / image.height);
    crop = {
      x: (image.width - width / ratio) / 2,
      y: (image.height - height / ratio) / 2,
      width: width / ratio,
      height: height / ratio,
    };
  }
  return (
    <CanvasImage
      {...effects}
      image={image}
      width={width}
      height={height}
      crop={crop}
    />
  );
}

export function FigmaImportButton({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: (input: { url: string; token: string }) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit() {
    setLoading(true);
    setError('');
    const temporaryToken = token;
    setToken('');
    try {
      await onImport({ url: url.trim(), token: temporaryToken.trim() });
      ref.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <button
        className="import-button"
        disabled={busy}
        onClick={() => {
          setError('');
          ref.current?.showModal();
        }}
      >
        ↓ Import Figma
      </button>
      <dialog
        ref={ref}
        className="workspace-dialog import-dialog"
        onCancel={(event) => {
          if (loading) event.preventDefault();
        }}
        onClose={() => setToken('')}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="eyebrow">FIGMA → YOUR LOCAL WORKSPACE</div>
          <h2>Bring a frame into your app</h2>
          <p>
            Import the layers, source properties, assets and a reference image.
            Your existing documents stay in place.
          </p>
          <label>
            Figma frame URL
            <input
              autoFocus
              type="url"
              required
              disabled={loading}
              placeholder="https://www.figma.com/design/…?node-id=123-456"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            Read-only Figma token
            <input
              type="password"
              required
              autoComplete="off"
              disabled={loading}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <p className="muted">
            Create a personal access token in Figma settings with{' '}
            <code>file_content:read</code>. It is used only for this import and
            is not saved.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {loading && (
            <p role="status">
              Importing layers and saving assets… This can take a few minutes.
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={loading}
              onClick={() => ref.current?.close()}
            >
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={loading || !url.trim() || !token.trim()}
            >
              {loading ? 'Importing…' : 'Import frame'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

export function FigmaReference({
  snapshot,
}: {
  snapshot?: Snapshot;
  selection: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const document = snapshot?.document;
  const source = document?.source;
  useEffect(() => {
    setImage('');
    setError('');
    dialog.current?.close();
  }, [document?.id]);
  if (!source || !document || !snapshot) return null;
  async function show() {
    dialog.current?.showModal();
    try {
      setImage(
        await window.designer.asset(document!.id, source!.previewAssetId),
      );
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <div className="figma-reference-bar">
        <span>
          Figma import{' '}
          <span className="muted">
            · {source.warnings.length} notes
            {document.revision !== source.importedRevision
              ? ' · edited since import'
              : ''}
          </span>
        </span>
        <div>
          <button onClick={() => void show()}>Reference & notes</button>
        </div>
      </div>
      <dialog ref={dialog} className="workspace-dialog reference-dialog">
        <div className="modal-heading">
          <div>
            <h2>Figma reference</h2>
            <p>
              Original imported frame. Local edits are not reflected in this
              image.
            </p>
          </div>
          <button
            aria-label="Close reference"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <div className="reference-columns">
          <div className="reference-image">
            {image ? (
              <img src={image} alt="Original imported Figma frame" />
            ) : (
              <p>Loading saved preview…</p>
            )}
          </div>
          <aside>
            <h3>Import notes</h3>
            <ul>
              {source.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </aside>
        </div>
      </dialog>
    </>
  );
}
