import { FontStore } from './main/font-store';
import { getCodingBrief } from './main/coding-brief';
import { fontRequestSchema } from './shared/fonts';
import { app, BrowserWindow, clipboard, dialog, ipcMain, net } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { DocumentService } from './main/document-service';
import { startMcp } from './main/mcp';
import type { PreviewRenderer } from './main/current-preview';
import type { ConnectionInfo } from './shared/design';
import { FigmaImporter } from './main/figma-import';
import { z } from 'zod';
import { open, writeFile } from 'node:fs/promises';
import {
  bundleLimit,
  importFigmaBundle,
  parseFigmaBundle,
} from './main/figma-bundle';
import { prepareExportUpdate } from './main/figma-sync';
import { updateExportInput, applyExportInput } from './shared/figma-update';

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
      let fonts: FontStore | undefined;
      let fontError = '';
      try {
        fonts = new FontStore(app.getPath('userData'));
      } catch {
        fontError =
          'The local font library could not be read. Your design is intact.';
      }
      const fontLibrary = () => {
        if (!fonts) throw new Error(fontError);
        return fonts;
      };
      let loadingFont = false;
      const importer = new FigmaImporter(service, (url, options) =>
        net.fetch(String(url), options),
      );
      let importing = false;
      let pendingExport: ReturnType<typeof prepareExportUpdate> | undefined;
      let connection: ConnectionInfo;
      let previewBusy = false;
      service.setLayoutRecalculator(async (nodes, previous) => {
        const window = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed(),
        );
        if (!window || window.webContents.isLoadingMainFrame())
          throw new Error(
            'The text measurement renderer is not ready. Try again after the editor loads.',
          );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            window.webContents.executeJavaScript(
              `window.__recalculateLiveLayout(${JSON.stringify(nodes)},${JSON.stringify(previous)})`,
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Text measurement timed out. No design changes were saved.',
                    ),
                  ),
                20000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      const renderPreview: PreviewRenderer = async (input) => {
        const window = BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed(),
        );
        if (!window || window.webContents.isLoadingMainFrame())
          throw new Error(
            'Preview renderer is not ready. Try again after the editor loads.',
          );
        if (previewBusy)
          throw new Error('Preview renderer is busy. Try again shortly.');
        previewBusy = true;
        try {
          return await window.webContents.executeJavaScript(
            `window.__renderCurrentPreview(${JSON.stringify(input)})`,
          );
        } finally {
          previewBusy = false;
        }
      };
      try {
        mcp = await startMcp(service, 0, renderPreview, fonts);
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
      ipcMain.handle('fonts:list', (event) => {
        trusted(event);
        return fontLibrary().list();
      });
      ipcMain.handle('fonts:data', (event, id: unknown) => {
        trusted(event);
        return fontLibrary().data(id);
      });
      ipcMain.handle('fonts:remove', (event, id: unknown) => {
        trusted(event);
        fontLibrary().remove(id);
      });
      ipcMain.handle('fonts:import', async (event, input: unknown) => {
        trusted(event);
        const request = fontRequestSchema.parse(input);
        if (loadingFont) throw new Error('Another font is being loaded.');
        loadingFont = true;
        try {
          const selected = await dialog.showOpenDialog(
            BrowserWindow.fromWebContents(event.sender)!,
            {
              title: 'Load a local font file',
              properties: ['openFile'],
              filters: [
                {
                  name: 'Font files',
                  extensions: ['ttf', 'otf', 'woff', 'woff2'],
                },
              ],
            },
          );
          if (selected.canceled || !selected.filePaths.length) return null;
          const file = await open(selected.filePaths[0], 'r');
          try {
            const info = await file.stat();
            if (
              !info.isFile() ||
              info.size < 12 ||
              info.size > 20 * 1024 * 1024
            )
              throw new Error('Choose a font file smaller than 20 MB.');
            const bytes = Buffer.alloc(info.size + 1);
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
            if (size !== info.size)
              throw new Error(
                'The font file changed while loading. Try again.',
              );
            return fontLibrary().import(request, bytes.subarray(0, size));
          } finally {
            await file.close();
          }
        } finally {
          loadingFont = false;
        }
      });
      ipcMain.handle('design:read', (event) => {
        trusted(event);
        return service!.read();
      });
      ipcMain.handle('design:save-export', async (event, input: unknown) => {
        trusted(event);
        const value = z
          .object({
            name: z.string().min(1).max(160),
            format: z.enum(['png', 'svg']),
            data: z.string().max(90 * 1024 * 1024),
          })
          .strict()
          .parse(input);
        const bytes =
          value.format === 'png'
            ? Buffer.from(value.data, 'base64')
            : Buffer.from(value.data, 'utf8');
        if (bytes.length > 64 * 1024 * 1024)
          throw new Error('Export exceeds 64 MB. Try a lower scale.');
        if (
          value.format === 'png' &&
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error('Invalid PNG export.');
        if (value.format === 'svg' && !value.data.startsWith('<svg '))
          throw new Error('Invalid SVG export.');
        const name =
          value.name
            // Windows filenames cannot contain control characters.
            // eslint-disable-next-line no-control-regex
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
            .replace(/[. ]+$/, '') || 'layer';
        const result = await dialog.showSaveDialog(
          BrowserWindow.fromWebContents(event.sender)!,
          {
            title: 'Export layer',
            defaultPath: path.join(
              app.getPath('downloads'),
              `${name}.${value.format}`,
            ),
            filters: [
              { name: value.format.toUpperCase(), extensions: [value.format] },
            ],
          },
        );
        if (result.canceled || !result.filePath) return false;
        await writeFile(result.filePath, bytes);
        return true;
      });
      ipcMain.handle('design:copy-text', async (event, text: unknown) => {
        trusted(event);
        const value = z.string().max(20000).parse(text);
        await clipboard.writeText(value);
        if ((await clipboard.readText()) !== value)
          throw new Error(
            'Could not confirm the clipboard copy. Please try again.',
          );
      });
      ipcMain.handle('design:handoff-readiness', (event, input: unknown) => {
        trusted(event);
        return getCodingBrief(service!, input, false, fonts).readiness;
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
      const pickBundle = async (event: Electron.IpcMainInvokeEvent) => {
        const result = await dialog.showOpenDialog(
          BrowserWindow.fromWebContents(event.sender)!,
          {
            title: 'Import Figma export',
            properties: ['openFile'],
            filters: [{ name: 'Agent Designer export', extensions: ['json'] }],
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
          if (size !== stat.size)
            throw new Error(
              'The export file changed while reading. Try again.',
            );
          return {
            bytes: bytes.subarray(0, size),
            name: path.basename(result.filePaths[0]),
          };
        } finally {
          await file.close();
        }
      };
      ipcMain.handle(
        'design:review-export-update',
        async (event, input: unknown) => {
          trusted(event);
          const request = updateExportInput.parse(input);
          if (importing) throw new Error('An import is already in progress.');
          importing = true;
          pendingExport = undefined;
          try {
            const selected = await pickBundle(event);
            if (!selected) return null;
            const prepared = prepareExportUpdate(
              service!,
              request.documentId,
              request.expectedRevision,
              parseFigmaBundle(selected.bytes),
              selected.name,
            );
            pendingExport = prepared;
            return prepared.review;
          } finally {
            importing = false;
          }
        },
      );
      ipcMain.handle('design:discard-export-update', (event, id: unknown) => {
        trusted(event);
        const reviewId = z.string().uuid().parse(id);
        if (pendingExport?.review.reviewId === reviewId)
          pendingExport = undefined;
      });
      ipcMain.handle(
        'design:apply-export-update',
        async (event, input: unknown) => {
          trusted(event);
          const request = applyExportInput.parse(input);
          if (importing) throw new Error('An import is already in progress.');
          const prepared = pendingExport;
          if (!prepared || prepared.review.reviewId !== request.reviewId)
            throw new Error(
              'This export review expired. Select the export again.',
            );
          importing = true;
          try {
            const resolved = prepared.resolve(
              request.choices,
              request.confirmUnverifiedSource,
            );
            const result = await service!.updateImportedDocument(
              prepared.review.documentId,
              prepared.review.expectedRevision,
              resolved.document,
              resolved.raw,
              resolved.assets,
            );
            if (pendingExport === prepared) pendingExport = undefined;
            return result;
          } finally {
            importing = false;
          }
        },
      );
      ipcMain.handle('design:import-bundle', async (event) => {
        trusted(event);
        if (importing) throw new Error('An import is already in progress.');
        importing = true;
        try {
          const selected = await pickBundle(event);
          if (!selected) return null;
          return importFigmaBundle(service!, selected.bytes);
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
        return service!.executeAsync(request);
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
