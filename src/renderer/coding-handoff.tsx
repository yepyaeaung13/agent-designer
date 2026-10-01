import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../shared/design';
import { codingPrompt, type CodingTarget } from '../shared/coding-handoff';
import './coding-handoff.css';

export function CodingHandoff({
  snapshot,
  selection,
}: {
  snapshot?: Snapshot;
  selection: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [nodeId, setNodeId] = useState('');
  const [target, setTarget] = useState<CodingTarget>('existing');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const document = snapshot?.document;
  const page = document?.pages.find(
    (item) => item.id === snapshot?.activePageId,
  );
  const selected = page?.nodes.find((node) => node.id === nodeId);
  useEffect(() => {
    setCopied(false);
  }, [nodeId, target, document?.revision]);
  useEffect(() => {
    dialog.current?.close();
    setError('');
  }, [document?.id, page?.id]);
  if (!document || !page) return null;
  const options = page.nodes.filter(
    (node) => node.type === 'frame' || node.id === nodeId,
  );
  const stale =
    document.source && document.revision !== document.source.importedRevision;
  function open() {
    setNodeId(
      page!.nodes.find((node) => node.id === selection)?.id ??
        page!.nodes.find((node) => !node.parentId)?.id ??
        '',
    );
    setCopied(false);
    setError('');
    dialog.current?.showModal();
  }
  async function copy() {
    if (!selected) return;
    try {
      await window.designer.copyText(
        codingPrompt({
          documentId: document!.id,
          pageId: page!.id,
          nodeId: selected.id,
          expectedRevision: document!.revision,
          target,
        }),
      );
      setCopied(true);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <div className="coding-handoff-bar">
        <span>Ready to build this design?</span>
        <button disabled={!page.nodes.length} onClick={open}>
          Send design to agent
        </button>
      </div>
      <dialog ref={dialog} className="workspace-dialog coding-handoff-dialog">
        <div className="modal-heading">
          <h2>Send design to agent</h2>
          <button
            aria-label="Close coding handoff"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <p>
          Choose what to build, then paste the coding brief into your connected
          agent.
        </p>
        <label>
          Design to build
          <select
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
          >
            {options.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} · {Math.round(node.width)} ×{' '}
                {Math.round(node.height)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Build in
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as CodingTarget)}
          >
            <option value="existing">My current project</option>
            <option value="react-demo">A separate React demo</option>
          </select>
        </label>
        <p className="muted">
          {document.name} / {page.name} · revision {document.revision}. Your
          agent will retrieve the design, required images, fonts and import
          notes through MCP.
        </p>
        {stale && (
          <p className="handoff-note">
            Edited since import. The original reference does not show these
            changes; the brief tells your agent to use the current design
            properties.
          </p>
        )}
        {!document.source && (
          <p className="handoff-note">
            This design has no imported reference image. Your agent can still
            build from the saved layers.
          </p>
        )}
        {selected &&
          selected.source?.nodeId !== document.source?.nodeId &&
          document.source && (
            <p className="muted">
              The reference shows the full imported frame. Your agent will focus
              on the selected layer.
            </p>
          )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={() => dialog.current?.close()}>Close</button>
          <button
            className="primary"
            disabled={!selected}
            onClick={() => void copy()}
          >
            {copied ? 'Coding brief copied' : 'Copy coding brief'}
          </button>
        </div>
        <p className="muted">
          Connect your agent using “Connect agent” and keep Agent Designer open
          while it retrieves the design. Copying this brief does not start an
          agent automatically.
        </p>
      </dialog>
    </>
  );
}
