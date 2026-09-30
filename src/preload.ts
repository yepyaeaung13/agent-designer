import { contextBridge, ipcRenderer } from 'electron';
import type { DesignerApi, Snapshot } from './shared/design';

const api: DesignerApi = {
  copyText: (text) => ipcRenderer.invoke('design:copy-text', text),
  importFigma: (input) => ipcRenderer.invoke('design:import-figma', input),
  importBundle: () => ipcRenderer.invoke('design:import-bundle'),
  asset: (documentId, assetId) =>
    ipcRenderer.invoke('design:asset', documentId, assetId),
  read: () => ipcRenderer.invoke('design:read'),
  workspace: (action) => ipcRenderer.invoke('design:workspace', action),
  execute: (request) => ipcRenderer.invoke('design:execute', request),
  connection: () => ipcRenderer.invoke('design:connection'),
  onChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) =>
      listener(snapshot);
    ipcRenderer.on('design:changed', handler);
    return () => ipcRenderer.removeListener('design:changed', handler);
  },
};
contextBridge.exposeInMainWorld('designer', api);
