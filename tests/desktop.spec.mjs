import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { seedDemo } from "../dist/tests/demo.js";
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function launch(empty = false, large = false, openBoard = true) {
  mkdirSync("work", { recursive: true });
  const directory = mkdtempSync(resolve("work/ui-"));
  seedDemo(directory, await freePort(), empty, large);
  return start(directory, openBoard);
}
async function start(directory, openBoard = false) {
  const env = { ...process.env, CHATTERBOX_HOME: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHATTERBOX_CONFIG;
  const app = await electron.launch({
    // Playwright otherwise emulates light mode and hides native theme changes.
    colorScheme: null,
    chromiumSandbox: true,
    ...(process.env.CHATTERBOX_TEST_EXECUTABLE
      ? { executablePath: process.env.CHATTERBOX_TEST_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    if (openBoard)
      await page
        .getByRole("button", { name: "Open General", exact: true })
        .click();
    return { app, page, directory };
  } catch (error) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function clickMenu(app, id) {
  await app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu().getMenuItemById(itemId);
    if (!item) throw new Error(`Missing native menu item: ${itemId}`);
    item.click();
  }, id);
}

test("tray-only preference survives restart, keeps the board online, and allows show, close and quit", async () => {
  test.skip(!["darwin", "win32"].includes(process.platform));
  const initial = await launch(true, false, false);
  let app = initial.app;
  const { directory } = initial;
  const preference = resolve(directory, "desktop.json");
  const visible = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible(),
    );
  const dockVisible = () => app.evaluate(({ app }) => app.dock.isVisible());
  const quit = async () => {
    const closed = app.waitForEvent("close");
    // Native role-based Quit cannot be invoked with MenuItem.click() on macOS.
    await app.evaluate(({ app }) => app.quit());
    await closed;
  };
  try {
    await clickMenu(app, "tray-only");
    await expect.poll(visible).toBe(false);
    expect(JSON.parse(readFileSync(preference, "utf8"))).toEqual({
      tray_only: true,
    });
    if (process.platform === "darwin")
      await expect.poll(dockVisible).toBe(false);
    expect(
      await app.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu().getMenuItemById("tray-only").checked,
      ),
    ).toBe(true);
    // A real authenticated service request still succeeds with no visible window.
    expect(
      await initial.page.evaluate(() =>
        window.board.read("boards", { limit: 1 }),
      ),
    ).toHaveProperty("boards.0.name", "General");
    await clickMenu(app, "show-main-window");
    await expect.poll(visible).toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect.poll(visible).toBe(false);
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    await quit();

    ({ app } = await start(directory));
    await expect.poll(visible).toBe(false);
    if (process.platform === "darwin")
      await expect.poll(dockVisible).toBe(false);
    await clickMenu(app, "tray-only");
    await expect.poll(visible).toBe(true);
    if (process.platform === "darwin")
      await expect.poll(dockVisible).toBe(true);
    expect(JSON.parse(readFileSync(preference, "utf8"))).toEqual({
      tray_only: false,
    });
    await quit();

    ({ app } = await start(directory));
    await expect.poll(visible).toBe(true);
    await quit();
    // A damaged preference must open normally rather than trap the app hidden.
    writeFileSync(preference, "{");
    ({ app } = await start(directory));
    await expect.poll(visible).toBe(true);
    expect(
      await app.evaluate(
        ({ Menu }) =>
          Menu.getApplicationMenu().getMenuItemById("tray-only").checked,
      ),
    ).toBe(false);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("board click-through, message search, details, sessions and read-only boundary", async () => {
  const { app, page, directory } = await launch();
  try {
    await expect(page.locator(".message")).toHaveCount(5);
    await page
      .getByRole("searchbox", { name: "Search messages" })
      .fill("unicode prefix");
    await expect(page.locator(".message")).toHaveCount(1);
    await page.locator(".message").first().click();
    await page.locator("summary").click();
    await expect(page.getByRole("dialog")).toContainText("embedding attached");
    await expect(page.getByRole("dialog")).toContainText("accepted by board");
    await page.getByRole("button", { name: "Close message details" }).click();
    await page.getByRole("searchbox").fill("no-such-phrase");
    await expect(page.getByText("No matching messages")).toBeVisible();
    await page.getByRole("searchbox").fill("");
    await page.getByLabel("Message kind").selectOption("blocker");
    await expect(page.locator(".message")).toHaveCount(1);
    await page.getByLabel("Message kind").selectOption("");
    await page.getByRole("button", { name: "Sessions", exact: false }).click();
    await expect(page.locator("#sessions .session-card")).toHaveCount(3);
    await expect(page.locator("#sessions .session-card").first()).toContainText(
      "Unknown — no lifecycle signal",
    );
    const denied = await page.evaluate(async () => {
      try {
        await window.board.read("send", {});
        return false;
      } catch {
        return true;
      }
    });
    expect(denied).toBe(true);
    expect(await page.evaluate(() => typeof window.require)).toBe("undefined");
    await page.getByRole("button", { name: "Network", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Network" })).toBeVisible();
    await expect(page.locator("#network-boards")).toContainText(
      /No nearby services found|Discovered · credentials required|Discovery unavailable/,
    );
    await page
      .getByRole("button", { name: "Message boards", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open General", exact: true })
      .click();
    await page.screenshot({ path: "work/desktop-board.png", fullPage: true });
    await page.setViewportSize({ width: 800, height: 700 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "work/desktop-narrow.png", fullPage: true });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("empty dashboard explains how to connect without inventing sessions", async () => {
  const { app, page, directory } = await launch(true);
  try {
    await expect(page.getByText("No messages yet")).toBeVisible();
    await expect(page.locator(".message")).toHaveCount(0);
    await page.screenshot({ path: "work/desktop-empty.png", fullPage: true });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("system appearance keeps native window and all dashboard surfaces in sync", async () => {
  const { app, page, directory } = await launch();
  try {
    expect(
      await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    ).toBe("system");
    await expect(page.locator(".brand-icon")).toHaveJSProperty(
      "naturalWidth",
      1024,
    );
    // Exercise Electron's native appearance propagation without changing OS settings.
    for (const theme of ["light", "dark", "light"]) {
      await app.evaluate(({ nativeTheme }, value) => {
        nativeTheme.themeSource = value;
      }, theme);
      await expect
        .poll(() =>
          page.evaluate(
            () => window.matchMedia("(prefers-color-scheme: dark)").matches,
          ),
        )
        .toBe(theme === "dark");
      const color = await page
        .locator("html")
        .evaluate((el) => window.getComputedStyle(el).backgroundColor);
      const channels = color.match(/\d+/g).map(Number);
      expect(channels[0]).toBe(channels[1]);
      expect(channels[1]).toBe(channels[2]);
      expect(channels[0] > 128).toBe(theme === "light");
      const hex = `#${channels.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
          ),
        )
        .toBe(hex);
      await page
        .getByRole("button", { name: "Message boards", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Open General", exact: true })
        .click();
      await expect(page.locator(".message")).toHaveCount(5);
      for (const selector of [
        ".sidebar",
        ".search-box",
        "select",
        ".message",
      ]) {
        const rgb = await page
          .locator(selector)
          .first()
          .evaluate((el) =>
            window
              .getComputedStyle(el)
              .backgroundColor.match(/\d+/g)
              .slice(0, 3)
              .map(Number),
          );
        expect(
          rgb.every((channel) =>
            theme === "light" ? channel > 128 : channel < 128,
          ),
        ).toBe(true);
      }
      await page.screenshot({
        path: `work/desktop-${theme}.png`,
        fullPage: true,
      });
      await page.locator(".message").first().click();
      const dialogLight = await page
        .getByRole("dialog")
        .evaluate(
          (el) =>
            Number(
              window.getComputedStyle(el).backgroundColor.match(/\d+/)[0],
            ) > 128,
        );
      expect(dialogLight).toBe(theme === "light");
      await page.screenshot({
        path: `work/desktop-${theme}-details.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "Close message details" }).click();
      await page
        .getByRole("button", { name: "Sessions", exact: false })
        .click();
      const sessionLight = await page
        .locator(".session-card")
        .first()
        .evaluate(
          (el) =>
            Number(
              window.getComputedStyle(el).backgroundColor.match(/\d+/)[0],
            ) > 128,
        );
      expect(sessionLight).toBe(theme === "light");
    }
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "system";
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("boards, messages, audit, sessions and services use bounded pages inside a full-height shell", async () => {
  const { app, page, directory } = await launch(false, true, false);
  try {
    await expect(page.locator(".board-row")).toHaveCount(20);
    await expect(page.locator(".board-row").first()).toContainText("Task 044");
    await page.screenshot({ path: "work/desktop-boards.png" });
    await page
      .getByRole("button", { name: "Next boards page", exact: true })
      .click();
    await expect(page.getByLabel("Boards pagination")).toContainText("Page 2");
    await expect(page.locator(".board-row")).toHaveCount(20);
    await page
      .getByRole("button", { name: "Next boards page", exact: true })
      .click();
    await expect(page.locator(".board-row")).toHaveCount(6);
    await page
      .getByRole("button", { name: "Open Task 000", exact: true })
      .click();
    await expect(page.locator(".message")).toHaveCount(50);
    await expect(page.locator(".message").first()).toContainText(
      "Pagination evidence 122",
    );
    await page.getByRole("button", { name: "Back to message boards" }).click();
    await expect(page.getByLabel("Boards pagination")).toContainText("Page 3");
    await page
      .getByRole("searchbox", { name: "Search boards" })
      .fill("Task 000");
    await expect(page.locator(".board-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Open Task 000", exact: true })
      .click();
    await expect(page.locator(".message")).toHaveCount(50);
    const first = await page
      .locator(".message")
      .first()
      .getAttribute("data-message-id");
    await page.locator(".message").first().click();
    await page.locator("summary").click();
    await expect(page.locator(".audit-event")).toHaveCount(50);
    await page.getByRole("button", { name: "Next audit page" }).click();
    await expect(page.getByLabel("Audit pagination")).toContainText("Page 2");
    await expect(page.locator(".audit-event")).toHaveCount(50);
    await page.getByRole("button", { name: "Next audit page" }).click();
    await expect(page.locator(".audit-event")).toHaveCount(26);
    await page.getByRole("button", { name: "Close message details" }).click();
    await page.getByRole("button", { name: "Next messages page" }).click();
    await expect(page.getByLabel("Messages pagination")).toContainText(
      "Page 2",
    );
    await expect(page.locator(".message")).toHaveCount(50);
    await expect(page.locator(".message").first()).not.toHaveAttribute(
      "data-message-id",
      first,
    );
    await page.getByRole("button", { name: /Refresh/ }).click();
    await expect(page.getByLabel("Messages pagination")).toContainText(
      "Page 2",
    );
    await page.getByRole("button", { name: "Next messages page" }).click();
    await expect(page.locator(".message")).toHaveCount(23);
    await page.getByRole("button", { name: "Previous messages page" }).click();
    await expect(page.locator(".message")).toHaveCount(50);
    await page.getByRole("searchbox").fill("Pagination evidence");
    await expect(page.getByLabel("Messages pagination")).toContainText(
      "Page 1",
    );
    await page.getByLabel("Message kind").selectOption("result");
    await expect(page.locator(".message")).toHaveCount(50);
    await page.getByRole("button", { name: "Next messages page" }).click();
    await expect(page.locator(".message")).toHaveCount(12);
    await page.setViewportSize({ width: 800, height: 700 });
    await page.locator(".content").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const layout = await page.evaluate(() => ({
      sidebarBottom: document.querySelector(".sidebar").getBoundingClientRect()
        .bottom,
      footerBottom: document
        .querySelector(".sidebar-footer")
        .getBoundingClientRect().bottom,
      height: window.innerHeight,
      overflow: document.documentElement.scrollHeight > window.innerHeight,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(layout.sidebarBottom).toBe(layout.height);
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.height);
    expect(layout.overflow).toBe(false);
    expect(layout.horizontalOverflow).toBe(false);
    await page.screenshot({ path: "work/desktop-pagination.png" });
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.locator("#sessions .session-card")).toHaveCount(20);
    await page.getByRole("button", { name: "Next sessions page" }).click();
    await expect(page.getByLabel("Sessions pagination")).toContainText(
      "Page 2",
    );
    await expect(page.locator("#sessions .session-card")).toHaveCount(20);
    await page.getByRole("button", { name: "Next sessions page" }).click();
    await expect(page.locator("#sessions .session-card")).toHaveCount(8);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("board:discover");
      ipcMain.handle("board:discover", () => ({
        error: null,
        boards: Array.from({ length: 25 }, (_, i) => ({
          name: `Fixture service ${i}`,
          url: `https://fixture-${i}.local:4317`,
          host: "fixture.local",
          addresses: [],
          protocol: "1",
          version: "0.1",
          authenticated: false,
        })),
      }));
    });
    await page.getByRole("button", { name: "Network", exact: true }).click();
    await expect(page.locator("#network-boards .session-card")).toHaveCount(20);
    await page
      .getByRole("button", { name: "Next network services page" })
      .click();
    await expect(page.locator("#network-boards .session-card")).toHaveCount(5);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
