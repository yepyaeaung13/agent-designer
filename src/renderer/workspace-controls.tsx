import { useEffect, useRef, useState } from 'react';
import type {
  DesignCommand,
  Snapshot,
  WorkspaceAction,
} from '../shared/design';
import './workspace.css';

type Props = {
  snapshot?: Snapshot;
  busy: boolean;
  error: string;
  workspace: (action: WorkspaceAction) => Promise<boolean>;
  execute: (command: DesignCommand) => Promise<boolean | undefined>;
  surface: 'documents' | 'pages';
};
type FormState = {
  type:
    | 'new-document'
    | 'rename-document'
    | 'delete-document'
    | 'new-page'
    | 'rename-page'
    | 'delete-page';
  id?: string;
  name: string;
  documentId: string;
  revision: number;
};

export function WorkspaceControls({
  snapshot,
  busy,
  error,
  workspace,
  execute,
  surface,
}: Props) {
  const [library, setLibrary] = useState(false);
  const [form, setForm] = useState<FormState>();
  const [name, setName] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const formDialog = useRef<HTMLDialogElement>(null);
  const page = snapshot?.document.pages.find(
    (item) => item.id === snapshot.activePageId,
  );
  useEffect(() => {
    if (library) dialog.current?.showModal();
    else dialog.current?.close();
  }, [library]);
  useEffect(() => {
    if (form) formDialog.current?.showModal();
    else formDialog.current?.close();
  }, [form]);
  useEffect(() => {
    setForm(undefined);
  }, [snapshot?.document.id]);
  function open(type: FormState['type'], id?: string, value = '') {
    if (!snapshot) return;
    setName(value);
    setForm({
      type,
      id,
      name: value,
      documentId: snapshot.document.id,
      revision: snapshot.document.revision,
    });
  }
  async function submit() {
    if (!form || !snapshot || busy) return;
    let ok: boolean | undefined;
    if (form.type === 'new-document')
      ok = await workspace({
        type: 'create_document',
        name: name.trim(),
        activate: true,
      });
    else if (form.type === 'delete-document')
      ok = await workspace({
        type: 'delete_document',
        id: form.documentId,
        expectedRevision: form.revision,
      });
    else if (form.type === 'rename-document')
      ok = await execute({ type: 'rename', name: name.trim() });
    else if (form.type === 'new-page') {
      const id = crypto.randomUUID();
      ok = await execute({ type: 'create_page', id, name: name.trim() });
      if (ok)
        ok = await workspace({
          type: 'open_page',
          documentId: form.documentId,
          pageId: id,
        });
    } else if (form.type === 'rename-page')
      ok = await execute({
        type: 'rename_page',
        id: form.id!,
        name: name.trim(),
      });
    else ok = await execute({ type: 'delete_page', id: form.id! });
    if (ok) {
      setForm(undefined);
      if (form.type === 'new-document' || form.type === 'delete-document')
        setLibrary(false);
    }
  }
  const deleting = form?.type.startsWith('delete');
  const title = form
    ? {
        'new-document': 'New document',
        'rename-document': 'Rename document',
        'delete-document': 'Delete document',
        'new-page': 'New page',
        'rename-page': 'Rename page',
        'delete-page': 'Delete page',
      }[form.type]
    : '';
  return (
    <>
      {surface === 'documents' ? (
        <button
          className="document-switcher"
          aria-label="Open documents"
          disabled={!snapshot || busy}
          onClick={() => setLibrary(true)}
        >
          <span>{snapshot?.document.name ?? 'Opening design…'}</span>
          <span className="muted">⌄</span>
        </button>
      ) : (
        <>
          <div className="section-title pages-heading">
            PAGES
            <button
              aria-label="New page"
              title="New page"
              disabled={!snapshot || busy}
              onClick={() =>
                open(
                  'new-page',
                  undefined,
                  `Page ${(snapshot?.document.pages.length ?? 0) + 1}`,
                )
              }
            >
              +
            </button>
          </div>
          <div className="page-list">
            {snapshot?.document.pages.map((item) => (
              <div
                key={item.id}
                className={`page-item ${item.id === snapshot.activePageId ? 'active' : ''}`}
              >
                <button
                  className="page-select"
                  aria-current={
                    item.id === snapshot.activePageId ? 'page' : undefined
                  }
                  disabled={busy}
                  onClick={() =>
                    void workspace({
                      type: 'open_page',
                      documentId: snapshot.document.id,
                      pageId: item.id,
                    })
                  }
                >
                  <span>▧</span>
                  <span>{item.name}</span>
                  <small>{item.nodes.length}</small>
                </button>
              </div>
            ))}
          </div>
          <div className="page-actions">
            <button
              aria-label="Rename page"
              disabled={!page || busy}
              onClick={() => open('rename-page', page?.id, page?.name)}
            >
              Rename
            </button>
            <button
              aria-label="Delete page"
              disabled={
                !page || busy || (snapshot?.document.pages.length ?? 0) < 2
              }
              onClick={() => open('delete-page', page?.id, page?.name)}
            >
              Delete
            </button>
          </div>
        </>
      )}
      <dialog
        className="workspace-dialog library-dialog"
        ref={dialog}
        onCancel={() => setLibrary(false)}
        onClose={() => setLibrary(false)}
      >
        <div className="modal-heading">
          <div>
            <div className="eyebrow">ON THIS DEVICE</div>
            <h2>Your documents</h2>
          </div>
          <button
            aria-label="Close documents"
            onClick={() => setLibrary(false)}
          >
            ×
          </button>
        </div>
        <p className="library-intro">
          A space for every idea. All changes are saved locally.
        </p>
        <div className="document-list">
          {snapshot?.documents.map((document) => (
            <button
              key={document.id}
              className={`document-card ${document.id === snapshot.document.id ? 'active' : ''}`}
              disabled={busy}
              onClick={() => {
                void workspace({ type: 'open_document', id: document.id }).then(
                  (ok) => {
                    if (ok) setLibrary(false);
                  },
                );
              }}
            >
              <span className="document-thumbnail">▧</span>
              <span className="document-card-label">
                <strong>{document.name}</strong>
                <small>
                  {document.pageCount}{' '}
                  {document.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                  {document.nodeCount} layers
                </small>
              </span>
              <span className="muted">
                {document.id === snapshot.document.id ? 'Open' : '→'}
              </span>
            </button>
          ))}
        </div>
        <div className="library-actions">
          <button
            className="primary"
            aria-label="New document"
            disabled={busy}
            onClick={() => open('new-document', undefined, 'Untitled design')}
          >
            + New document
          </button>
          <button
            aria-label="Rename document"
            disabled={busy}
            onClick={() =>
              open('rename-document', undefined, snapshot?.document.name)
            }
          >
            Rename current
          </button>
          <button
            className="danger-text"
            aria-label="Delete document"
            disabled={busy || (snapshot?.documents.length ?? 0) < 2}
            onClick={() =>
              open('delete-document', undefined, snapshot?.document.name)
            }
          >
            Delete current
          </button>
        </div>
      </dialog>
      <dialog
        className="workspace-dialog name-dialog"
        ref={formDialog}
        onCancel={() => {
          if (!busy) setForm(undefined);
        }}
        onClose={() => setForm(undefined)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2>{title}</h2>
          {deleting ? (
            <p>
              Delete <strong>{form?.name}</strong>?{' '}
              {form?.type === 'delete-document'
                ? 'All pages and layers in this document will be permanently removed. This cannot be undone.'
                : 'This removes the page and all its layers. You can undo this while the app remains open.'}
            </p>
          ) : (
            <label>
              Name
              <input
                aria-label="Name"
                autoFocus
                value={name}
                maxLength={120}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setForm(undefined)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={deleting ? 'danger' : 'primary'}
              disabled={busy || (!deleting && !name.trim())}
            >
              {busy ? 'Saving…' : deleting ? 'Delete' : 'Save'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
