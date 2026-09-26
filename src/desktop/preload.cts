import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("board", {
  read: (method: string, args: unknown) =>
    ipcRenderer.invoke("board:read", method, args),
  context: () => ipcRenderer.invoke("board:context"),
  onChanged: (callback: () => void) => {
    ipcRenderer.on("board:changed", callback);
    return () => ipcRenderer.removeListener("board:changed", callback);
  },
});
