import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { Board } from "../store.js";
import { initialize, readConfig, databasePath } from "../config.js";
import { serve } from "../server.js";
import { Discovery } from "../discovery.js";
import { Client } from "../client.js";
import { schemas, type Method } from "../types.js";

const base = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(base, "../ui/index.html")).href;
let service: Awaited<ReturnType<typeof serve>> | undefined;
let store: Board | undefined;
let discovery: Discovery | undefined;
let window: BrowserWindow | undefined;
const abort = new AbortController();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const config = process.env.CHATTERBOX_CONFIG
        ? readConfig(process.env.CHATTERBOX_CONFIG)
        : initialize();
      const client = new Client(config.board_url, config.viewer_token);
      const url = new URL(config.board_url);
      try {
        await client.call("sessions", { limit: 1 });
      } catch (error) {
        if (
          url.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(url.hostname)
        )
          throw error;
        store = new Board(databasePath());
        service = await serve(store, {
          host: url.hostname,
          port: Number(url.port || 80),
        });
        await client.call("sessions", { limit: 1 });
      }
      const verify = (event: Electron.IpcMainInvokeEvent) => {
        if (event.senderFrame?.url !== entry)
          throw new Error("Untrusted renderer");
      };
      const allowed = new Set<Method>([
        "sessions",
        "messages",
        "thread",
        "search",
        "audit",
      ]);
      ipcMain.handle("board:read", (event, method: Method, args: unknown) => {
        verify(event);
        if (!allowed.has(method)) throw new Error("Dashboard is read-only");
        return client.call(method, schemas[method].parse(args));
      });
      ipcMain.handle("board:context", (event) => {
        verify(event);
        return {
          workspace: config.workspace_id,
          project: config.project_id,
          version: app.getVersion(),
        };
      });
      try {
        discovery = new Discovery(() =>
          window?.webContents.send("board:changed"),
        );
      } catch {
        console.error(
          "Local network discovery is unavailable; manual connections still work.",
        );
      }
      ipcMain.handle("board:discover", (event) => {
        verify(event);
        return (
          discovery?.snapshot() ?? {
            boards: [],
            error: "Discovery is unavailable",
          }
        );
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [
                {
                  label: "ChatterBox",
                  submenu: [
                    { role: "about" as const },
                    { type: "separator" as const },
                    { role: "quit" as const },
                  ],
                },
              ]
            : []),
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]),
      );
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1380,
          height: 900,
          minWidth: 780,
          minHeight: 600,
          title: "ChatterBox",
          icon: join(base, "icon.png"),
          backgroundColor: "#101419",
          webPreferences: {
            preload: join(base, "preload.cjs"),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        window.webContents.session.setPermissionRequestHandler(
          (_wc, _permission, callback) => callback(false),
        );
        void window.loadURL(entry);
        window.on("closed", () => {
          window = undefined;
        });
      };
      createWindow();
      app.on("activate", () => {
        if (!window) createWindow();
      });
      const watch = async () => {
        while (!abort.signal.aborted) {
          try {
            await client.events(abort.signal, () =>
              window?.webContents.send("board:changed"),
            );
          } catch {
            /* UI reads show connection errors and reconnect automatically. */
          }
          if (!abort.signal.aborted)
            await delay(3000, undefined, { signal: abort.signal }).catch(
              () => {},
            );
        }
      };
      void watch();
    })
    .catch((error) => {
      dialog.showErrorBox(
        "ChatterBox could not start",
        error instanceof Error ? error.message : String(error),
      );
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    abort.abort();
    discovery?.close();
    void (service?.close() ?? Promise.resolve()).finally(() => {
      store?.close();
      app.quit();
    });
  });
}
