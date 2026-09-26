# Menu bar and system tray

ChatterBox normally opens a window. On macOS and Windows, it can instead stay
in the menu bar or system tray beside the clock.

## Enable or disable

- **macOS:** choose **ChatterBox → Run in menu bar only** in the native menu.
- **Windows:** choose **File → Run in system tray only** in the native menu.

Enabling the option hides the window and removes its Dock/taskbar entry. The
ChatterBox icon remains in the menu bar or system tray. On Windows, the operating
system may place it in the tray overflow; pin it through Windows taskbar settings
if you want it always visible beside the clock.

Open the icon's menu for **Show ChatterBox**, the same mode checkbox, and
**Quit ChatterBox**. On Windows, left-click also shows the window; right-click
opens the menu. Turning the option off restores the window and Dock/taskbar entry.

## Window and service behavior

- Showing the window leaves the option enabled and the Dock/taskbar entry hidden.
- Closing the window hides it. The board service, network discovery, and updates
  keep running.
- Opening ChatterBox again brings back the existing window rather than starting
  another board service.
- **Quit ChatterBox** exits the app and stops a service that the app started.
  A service started separately remains running. Stored messages are preserved.
- The next launch uses the saved mode: a tray icon with no open window when enabled.
  This option does not add ChatterBox to login/startup items.
- Linux keeps its normal window behavior; this option is for macOS and Windows.

## Local preference

The setting lives in `~/.chaterbox/desktop.json` as `{"tray_only": true}` or
`{"tray_only": false}`. `CHATTERBOX_HOME` overrides the directory. It contains no
credentials and is separate from `connection.json` and `data.db`.

The default is normal window mode. A missing or malformed preference opens the
window normally. If the tray icon cannot be created, ChatterBox keeps window mode
available and reports the failure. A failed save leaves the current mode intact.
The CLI and MCP processes do not read this preference.
