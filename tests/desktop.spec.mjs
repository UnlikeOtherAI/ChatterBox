import { test, expect, _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
async function launch(empty = false) {
  mkdirSync("work", { recursive: true });
  const directory = mkdtempSync(resolve("work/ui-"));
  seedDemo(directory, await freePort(), empty);
  const env = { ...process.env, CHATTERBOX_HOME: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHATTERBOX_CONFIG;
  const app = await electron.launch({
    // Playwright otherwise emulates light mode and hides native theme changes.
    colorScheme: null,
    ...(process.env.CHATTERBOX_TEST_EXECUTABLE
      ? { executablePath: process.env.CHATTERBOX_TEST_EXECUTABLE, args: [] }
      : { args: ["."] }),
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Board connected", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    return { app, page, directory };
  } catch (error) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
test("desktop search, filters, thread view, delivery audit, sessions and read-only boundary", async () => {
  const { app, page, directory } = await launch();
  try {
    await expect(page.locator(".message")).toHaveCount(5);
    await page
      .getByRole("searchbox", { name: "Search messages" })
      .fill("unicode prefix");
    await expect(page.locator(".message")).toHaveCount(1);
    await expect(page.getByText("◇ Embedding")).toBeVisible();
    await page.getByRole("button", { name: "View details" }).click();
    await expect(page.getByRole("dialog")).toContainText("embedding attached");
    await expect(page.getByRole("dialog")).toContainText("accepted by board");
    await page.getByRole("button", { name: "Close message details" }).click();
    await page.getByRole("searchbox").fill("no-such-phrase");
    await expect(page.getByText("No matching messages")).toBeVisible();
    await page.getByRole("searchbox").fill("");
    await page.getByLabel("Message kind").selectOption("blocker");
    await expect(page.locator(".message")).toHaveCount(1);
    await page.getByLabel("Message kind").selectOption("");
    await page
      .locator(".thread-button")
      .filter({ hasText: "sqlite-search" })
      .click();
    await expect(page.locator(".message")).toHaveCount(2);
    await page.getByRole("button", { name: "Show all threads" }).click();
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
    await page
      .getByRole("button", { name: "Network boards", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Network boards." }),
    ).toBeVisible();
    await expect(page.locator("#network-boards")).toContainText(
      /No nearby boards found|Discovered · credentials required|Discovery unavailable/,
    );
    await page
      .getByRole("button", { name: "Message board", exact: false })
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
    await expect(
      page.getByText("A quiet board. Ready for company."),
    ).toBeVisible();
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
        .getByRole("button", { name: "Message board", exact: false })
        .click();
      for (const selector of [
        ".sidebar",
        ".stat",
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
      await page.getByRole("button", { name: "View details" }).first().click();
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
