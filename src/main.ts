import { app, BrowserWindow, clipboard, dialog, ipcMain, net } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { DocumentService } from './main/document-service';
import { startMcp } from './main/mcp';
import type { ConnectionInfo } from './shared/design';
import { FigmaImporter } from './main/figma-import';
import { z } from 'zod';
import { open } from 'node:fs/promises';
import { bundleLimit, importFigmaBundle } from './main/figma-bundle';

let service: DocumentService | undefined;
let mcp: Awaited<ReturnType<typeof startMcp>> | undefined;
let closing = false;
if (started || !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const databasePath = path.join(
        app.getPath('userData'),
        'designer.sqlite',
      );
      service = new DocumentService(databasePath);
      const importer = new FigmaImporter(service, (url, options) =>
        net.fetch(String(url), options),
      );
      let importing = false;
      let connection: ConnectionInfo;
      try {
        mcp = await startMcp(service);
        connection = { url: mcp.url, token: mcp.token, databasePath };
      } catch (error) {
        connection = {
          url: null,
          token: null,
          databasePath,
          error: String(error),
        };
      }
      const trusted = (event: Electron.IpcMainInvokeEvent) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || event.senderFrame !== window.webContents.mainFrame)
          throw new Error('Untrusted sender');
      };
      ipcMain.handle('design:read', (event) => {
        trusted(event);
        return service!.read();
      });
      ipcMain.handle('design:copy-text', (event, text: unknown) => {
        trusted(event);
        return clipboard.writeText(z.string().max(20000).parse(text));
      });
      ipcMain.handle('design:import-figma', async (event, input: unknown) => {
        trusted(event);
        if (importing)
          throw new Error('A Figma import is already in progress.');
        importing = true;
        try {
          return await importer.import(input);
        } finally {
          importing = false;
        }
      });
      ipcMain.handle('design:import-bundle', async (event) => {
        trusted(event);
        if (importing) throw new Error('An import is already in progress.');
        importing = true;
        try {
          const result = await dialog.showOpenDialog(
            BrowserWindow.fromWebContents(event.sender)!,
            {
              title: 'Import Figma export',
              properties: ['openFile'],
              filters: [
                { name: 'Agent Designer export', extensions: ['json'] },
              ],
            },
          );
          if (result.canceled || !result.filePaths[0]) return null;
          const file = await open(result.filePaths[0], 'r');
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > bundleLimit)
              throw new Error('Choose an export file smaller than 100 MB.');
            const bytes = Buffer.alloc(stat.size + 1);
            let size = 0;
            while (size < bytes.length) {
              const read = await file.read(
                bytes,
                size,
                bytes.length - size,
                null,
              );
              if (!read.bytesRead) break;
              size += read.bytesRead;
            }
            return importFigmaBundle(service!, bytes.subarray(0, size));
          } finally {
            await file.close();
          }
        } finally {
          importing = false;
        }
      });
      ipcMain.handle(
        'design:asset',
        (event, documentId: unknown, assetId: unknown) => {
          trusted(event);
          const asset = service!.getAsset(
            z.string().uuid().parse(documentId),
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(assetId),
          );
          return `data:${asset.mimeType};base64,${asset.bytes.toString('base64')}`;
        },
      );
      ipcMain.handle('design:execute', (event, request: unknown) => {
        trusted(event);
        return service!.execute(request);
      });
      ipcMain.handle('design:connection', (event) => {
        trusted(event);
        return connection;
      });
      ipcMain.handle('design:workspace', (event, action: unknown) => {
        trusted(event);
        return service!.workspace(action);
      });
      service.on('changed', (snapshot) => {
        BrowserWindow.getAllWindows().forEach((window) =>
          window.webContents.send('design:changed', snapshot),
        );
      });
      const createWindow = () => {
        const window = new BrowserWindow({
          show: !process.argv.includes('--smoke-test'),
          width: 1440,
          height: 940,
          minWidth: 1000,
          minHeight: 650,
          backgroundColor: '#f5f5f8',
          title: 'Agent Designer',
          webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) =>
          event.preventDefault(),
        );
        if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
          void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        else
          void window.loadFile(
            path.join(
              __dirname,
              `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
            ),
          );
      };
      createWindow();
      app.on('activate', () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox('Unable to open Agent Designer', String(error));
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    void (async () => {
      await mcp?.close();
      service?.close();
    })().finally(() => app.quit());
  });
}
