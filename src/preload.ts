import { contextBridge, ipcRenderer } from 'electron';
import type { DesignerApi, Snapshot } from './shared/design';

const api: DesignerApi = {
  handoffReadiness: (input) =>
    ipcRenderer.invoke('design:handoff-readiness', input),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  fontData: (id) => ipcRenderer.invoke('fonts:data', id),
  importFont: (input) => ipcRenderer.invoke('fonts:import', input),
  removeFont: (id) => ipcRenderer.invoke('fonts:remove', id),
  saveExport: (input) => ipcRenderer.invoke('design:save-export', input),
  copyText: (text) => ipcRenderer.invoke('design:copy-text', text),
  importFigma: (input) => ipcRenderer.invoke('design:import-figma', input),
  importBundle: () => ipcRenderer.invoke('design:import-bundle'),
  reviewExportUpdate: (input) =>
    ipcRenderer.invoke('design:review-export-update', input),
  applyExportUpdate: (input) =>
    ipcRenderer.invoke('design:apply-export-update', input),
  discardExportUpdate: (reviewId) =>
    ipcRenderer.invoke('design:discard-export-update', reviewId),
  asset: (documentId, assetId) =>
    ipcRenderer.invoke('design:asset', documentId, assetId),
  read: () => ipcRenderer.invoke('design:read'),
  workspace: (action) => ipcRenderer.invoke('design:workspace', action),
  execute: (request) => ipcRenderer.invoke('design:execute', request),
  connection: () => ipcRenderer.invoke('design:connection'),
  resetConnection: () => ipcRenderer.invoke('design:reset-connection'),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) =>
      listener(snapshot);
    ipcRenderer.on('design:changed', handler);
    return () => ipcRenderer.removeListener('design:changed', handler);
  },
};
contextBridge.exposeInMainWorld('designer', api);
