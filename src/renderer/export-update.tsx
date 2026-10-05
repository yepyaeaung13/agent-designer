import { useEffect, useRef, useState } from 'react';
import type { Snapshot, DesignerApi } from '../shared/design';
import type { ExportReview } from '../shared/figma-update';
import './export-update.css';

const valueLabel = (value: unknown) =>
  value === undefined
    ? 'Unset'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

export function ExportUpdate({
  snapshot,
  busy,
  apply,
}: {
  snapshot: Snapshot;
  busy: boolean;
  apply: (
    input: Parameters<DesignerApi['applyExportUpdate']>[0],
  ) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const currentId = useRef(snapshot.document.id);
  currentId.current = snapshot.document.id;
  const staged = useRef<string | undefined>(undefined);
  const [review, setReview] = useState<ExportReview>();
  const [choices, setChoices] = useState<Record<string, 'local' | 'export'>>(
    {},
  );
  const [confirmed, confirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const discard = () => {
    if (staged.current)
      void window.designer.discardExportUpdate(staged.current).catch(() => {});
    staged.current = undefined;
  };
  function close() {
    discard();
    setReview(undefined);
    dialog.current?.close();
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discard();
    };
  }, []);
  useEffect(() => {
    close();
    setError('');
  }, [snapshot.document.id]);
  useEffect(() => {
    if (review) dialog.current?.showModal();
    else dialog.current?.close();
  }, [review]);
  async function open() {
    setLoading(true);
    setError('');
    const documentId = snapshot.document.id;
    try {
      const result = await window.designer.reviewExportUpdate({
        documentId,
        expectedRevision: snapshot.document.revision,
      });
      if (!result) return;
      if (!mounted.current || currentId.current !== documentId) {
        await window.designer.discardExportUpdate(result.reviewId);
        return;
      }
      staged.current = result.reviewId;
      setChoices({});
      confirm(false);
      setReview(result);
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  const stale =
    review && review.expectedRevision !== snapshot.document.revision;
  return (
    <>
      <button disabled={busy || loading} onClick={() => void open()}>
        {loading ? 'Reading export...' : 'Update from export'}
      </button>
      {!review && error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
      <dialog
        ref={dialog}
        className="workspace-dialog export-update-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else close();
        }}
        onClose={() => {
          discard();
          setReview(undefined);
        }}
      >
        {review && (
          <>
            <h2>Review export update</h2>
            <p>
              {review.documentName} / {review.frameName}
            </p>
            <p className="muted">{review.fileName}</p>
            <h3>Export changes</h3>
            <dl className="export-update-counts">
              <div>
                <dt>Added</dt>
                <dd>{review.added}</dd>
              </div>
              <div>
                <dt>Removed</dt>
                <dd>{review.removed}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{review.updated}</dd>
              </div>
              <div>
                <dt>Conflicts</dt>
                <dd>{review.conflicts.length}</dd>
              </div>
            </dl>
            {!review.identityVerified && (
              <label className="export-identity">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => confirm(event.target.checked)}
                />
                This export is from the same Figma file
              </label>
            )}
            <div className="export-conflicts">
              {review.conflicts.map((conflict) => (
                <div className="export-conflict" key={conflict.id}>
                  <strong>{conflict.layerName}</strong>
                  <span>{conflict.field}</span>
                  {conflict.field === 'Layer hierarchy and order' ? (
                    <p>
                      Using the export hierarchy replaces local additions,
                      deletions, layer types and ordering within this frame.
                      Edits to removed or replaced layers will be discarded.
                    </p>
                  ) : (
                    <div className="export-conflict-values">
                      <div>
                        <small>Local</small>
                        <pre>{valueLabel(conflict.local)}</pre>
                      </div>
                      <div>
                        <small>Export</small>
                        <pre>{valueLabel(conflict.incoming)}</pre>
                      </div>
                    </div>
                  )}
                  <label>
                    Keep
                    <select
                      disabled={busy}
                      value={choices[conflict.id] ?? 'local'}
                      onChange={(event) =>
                        setChoices({
                          ...choices,
                          [conflict.id]: event.target.value as
                            | 'local'
                            | 'export',
                        })
                      }
                    >
                      <option value="local">Local change</option>
                      <option value="export">Export change</option>
                    </select>
                  </label>
                </div>
              ))}
            </div>
            {stale && (
              <p role="alert" className="error">
                The design changed. Cancel and select the export again.
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button disabled={busy} onClick={close}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={
                  busy || !!stale || (!review.identityVerified && !confirmed)
                }
                onClick={() => {
                  setError('');
                  void apply({
                    reviewId: review.reviewId,
                    choices,
                    confirmUnverifiedSource: confirmed,
                  }).then((ok) => {
                    if (ok) close();
                    else
                      setError(
                        'Update failed. The document was not changed; review the editor error.',
                      );
                  });
                }}
              >
                {busy ? 'Updating...' : 'Apply update'}
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
