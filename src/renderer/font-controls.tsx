import { useEffect, useRef, useState } from 'react';
import type { DesignNode } from '../shared/design';
import type { FontStatus, LocalFont } from '../shared/fonts';
import {
  fontVersion,
  localFonts,
  onFontsChanged,
  refreshFonts,
  resolveFonts,
  fontLoadFailed,
  textOverflow,
} from './font-manager';
import './fonts.css';

export function FontControls({ nodes }: { nodes: DesignNode[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [version, setVersion] = useState(fontVersion());
  const [status, setStatus] = useState<FontStatus[]>([]);
  const [library, setLibrary] = useState<LocalFont[]>([]);
  const [clipped, setClipped] = useState(0);
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState('400');
  const [style, setStyle] = useState<'normal' | 'italic'>('normal');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => onFontsChanged(() => setVersion(fontVersion())), []);
  useEffect(() => {
    let active = true;
    void resolveFonts(nodes)
      .then((value) => {
        if (active) {
          setStatus(value);
          setLibrary(localFonts());
          setClipped(textOverflow(nodes).length);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [nodes, version]);
  const missing = status.filter(
    (font) => !['local', 'system'].includes(font.status),
  );
  async function load() {
    setBusy(true);
    setError('');
    try {
      const font = await window.designer.importFont({ family, weight, style });
      if (font) {
        await refreshFonts();
        if (fontLoadFailed(font.id))
          setError(
            'The file could not be decoded. Remove it and choose a valid font file.',
          );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await window.designer.removeFont(id);
      await refreshFonts();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="font-status-bar">
        <span role="status">
          {status.length
            ? missing.length
              ? `${missing.length} font variants need attention`
              : 'Design fonts available'
            : nodes.some((node) => node.type === 'text')
              ? 'Checking design fonts…'
              : 'No text layers on this page'}
        </span>
        <button
          onClick={() => {
            const font = missing[0] ?? status[0];
            if (font) {
              setFamily(font.family);
              setWeight(String(font.weight));
              setStyle(font.style);
            }
            dialog.current?.showModal();
          }}
        >
          Manage fonts
        </button>
      </div>
      <dialog ref={dialog} className="workspace-dialog font-dialog">
        <div className="modal-heading">
          <h2>Design fonts</h2>
          <button
            aria-label="Close font manager"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p>
          Load local font files for this app. Choose the matching family, weight
          and style. Design properties stay unchanged.
        </p>
        <div className="font-list">
          {status.map((font) => (
            <div
              className="font-row"
              key={`${font.family}/${font.weight}/${font.style}`}
            >
              <span>
                <strong>{font.family}</strong>
                <small>
                  {font.weight} · {font.style}
                </small>
              </span>
              <span>
                {
                  {
                    local: 'Local file loaded',
                    system: 'Installed family',
                    substituted: 'Another weight/style used',
                    missing: 'Missing · fallback used',
                    error: 'File could not load',
                  }[font.status]
                }
                {font.message && <small>{font.message}</small>}
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  setFamily(font.family);
                  setWeight(String(font.weight));
                  setStyle(font.style);
                }}
              >
                Choose variant
              </button>
            </div>
          ))}
        </div>
        <p className="muted">
          Installed-family detection does not guarantee every weight or glyph is
          available. Text can overflow its saved box; clipping frames still clip
          it.
        </p>
        {clipped > 0 && (
          <p role="status">
            {clipped} text layers exceed their saved height with the currently
            available fonts. Load missing fonts first, then review text boxes.
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <label>
            Font family
            <input
              required
              maxLength={200}
              value={family}
              disabled={busy}
              onChange={(event) => setFamily(event.target.value)}
            />
          </label>
          <div className="font-fields">
            <label>
              Weight or variable range
              <input
                required
                value={weight}
                placeholder="400 or 100 900"
                disabled={busy}
                onChange={(event) => setWeight(event.target.value)}
              />
            </label>
            <label>
              Style
              <select
                value={style}
                disabled={busy}
                onChange={(event) =>
                  setStyle(event.target.value as typeof style)
                }
              >
                <option value="normal">Normal</option>
                <option value="italic">Italic</option>
              </select>
            </label>
          </div>
          <button className="primary" disabled={busy || !family.trim()}>
            {busy ? 'Loading…' : 'Load local font file'}
          </button>
        </form>
        <p className="muted">
          TTF, OTF, WOFF and WOFF2 · up to 20 MB per file. Files remain on this
          device and load automatically after restart.
        </p>
        <h3>Local font library</h3>
        {library.length ? (
          library.map((font) => (
            <div className="font-row" key={font.id}>
              <span>
                {font.family}
                <small>
                  {font.weight} · {font.style}
                </small>
              </span>
              <button disabled={busy} onClick={() => void remove(font.id)}>
                Remove
              </button>
            </div>
          ))
        ) : (
          <p>No local files loaded yet.</p>
        )}
        {error && (
          <p className="font-error" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </>
  );
}
