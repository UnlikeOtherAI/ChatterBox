import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  dialog,
  nativeTheme,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { Board } from "../store.js";
import { initialize, readConfig, databasePath } from "../config.js";
import { serve } from "../server.js";
import { Discovery } from "../discovery.js";
import { Client } from "../client.js";
import { schemas, type Method } from "../types.js";
import { readTrayPreference, saveTrayPreference } from "./preferences.js";

const base = dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(join(base, "../ui/index.html")).href;
let service: Awaited<ReturnType<typeof serve>> | undefined;
let store: Board | undefined;
let discovery: Discovery | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayOnly = false;
let closing = false;
let showWindow: (() => void) | undefined;
const supportsTray = ["darwin", "win32"].includes(process.platform);
const abort = new AbortController();
// Let Electron keep native window chrome and prefers-color-scheme in sync.
nativeTheme.themeSource = "system";
const windowBackground = () =>
  nativeTheme.shouldUseDarkColors ? "#282828" : "#f2f2f2";
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    showWindow?.();
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
        "boards",
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
      const createWindow = () => {
        window = new BrowserWindow({
          show: !trayOnly,
          skipTaskbar: trayOnly && process.platform === "win32",
          width: 1380,
          height: 900,
          minWidth: 780,
          minHeight: 600,
          title: "ChatterBox",
          icon: join(base, "icon.png"),
          backgroundColor: windowBackground(),
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
        window.on("close", (event) => {
          if (trayOnly && !closing) {
            event.preventDefault();
            window?.hide();
          }
        });
        window.on("closed", () => {
          window = undefined;
        });
      };
      showWindow = () => {
        if (closing) return;
        if (!window) createWindow();
        if (window?.isMinimized()) window.restore();
        window?.show();
        window?.focus();
      };
      const rebuildMenus = () => {
        const controls: MenuItemConstructorOptions[] = [
          {
            id: "show-main-window",
            label: "Show ChatterBox",
            click: () => showWindow?.(),
          },
          {
            id: "tray-only",
            label:
              process.platform === "darwin"
                ? "Run in menu bar only"
                : "Run in system tray only",
            type: "checkbox",
            checked: trayOnly,
            click: () => setTrayOnly(!trayOnly),
          },
          { type: "separator" },
          { id: "quit-chatterbox", label: "Quit ChatterBox", role: "quit" },
        ];
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            ...(supportsTray
              ? [
                  {
                    label:
                      process.platform === "darwin" ? "ChatterBox" : "File",
                    submenu:
                      process.platform === "darwin"
                        ? [
                            { role: "about" as const },
                            { type: "separator" as const },
                            ...controls,
                          ]
                        : controls,
                  },
                ]
              : []),
            { role: "editMenu" },
            { role: "viewMenu" },
            { role: "windowMenu" },
          ]),
        );
        tray?.setContextMenu(Menu.buildFromTemplate(controls));
      };
      const setTrayOnly = (enabled: boolean, persist = true) => {
        if (closing) return;
        try {
          if (enabled && !tray) {
            const icon = nativeImage.createFromPath(
              join(
                base,
                process.platform === "win32" ? "icon.ico" : "icon.png",
              ),
            );
            if (icon.isEmpty())
              throw new Error("The tray icon could not be loaded.");
            tray = new Tray(
              process.platform === "darwin"
                ? icon.resize({ width: 18, height: 18 })
                : icon,
            );
            tray.setToolTip("ChatterBox");
            if (process.platform === "win32")
              tray.on("click", () => showWindow?.());
          }
          if (persist) saveTrayPreference(enabled);
          trayOnly = enabled;
          rebuildMenus();
          if (process.platform === "win32") window?.setSkipTaskbar(enabled);
          if (enabled) {
            window?.hide();
            app.dock?.hide();
          } else {
            tray?.destroy();
            tray = undefined;
            if (app.dock) void app.dock.show().then(() => showWindow?.());
            else showWindow?.();
          }
        } catch (error) {
          if (!trayOnly) {
            tray?.destroy();
            tray = undefined;
          }
          rebuildMenus();
          dialog.showErrorBox(
            "ChatterBox could not change its tray setting",
            error instanceof Error ? error.message : String(error),
          );
        }
      };
      if (supportsTray && readTrayPreference()) setTrayOnly(true, false);
      rebuildMenus();
      createWindow();
      nativeTheme.on("updated", () => {
        window?.setBackgroundColor(windowBackground());
      });
      app.on("activate", () => showWindow?.());
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
    if (process.platform !== "darwin" && !trayOnly) app.quit();
  });
  app.on("before-quit", (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    tray?.destroy();
    tray = undefined;
    abort.abort();
    discovery?.close();
    void (service?.close() ?? Promise.resolve()).finally(() => {
      store?.close();
      // Leave the current native quit stack before finishing shutdown.
      setTimeout(() => app.quit(), 0);
    });
  });
}
