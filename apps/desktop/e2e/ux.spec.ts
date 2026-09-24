import { test, expect } from "@playwright/test";

test.describe("Simple Chat UX", () => {
  test("empty state, composer, model picker, settings, sidebar", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByText("Simple Chat", { exact: true })).toBeVisible();
    await expect(page.getByText("Ask Anything")).toBeVisible();
    await expect(page.getByPlaceholder("Ask AI anything…")).toBeFocused();
    await expect(page.getByText(/^Web$/)).toHaveCount(0);

    await page.getByTitle("Select model").click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "GPT-4o" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("option").filter({ hasText: "Gemini" }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText(/web search/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Close" }).click();

    const before = await page.locator(".chat-item").count();
    await page.getByTitle("New Chat (⌘/Ctrl+N)").click();
    await expect(page.locator(".chat-item")).toHaveCount(before);

    await page.getByTitle("Hide sidebar (⌘/Ctrl+B)").click();
    await expect(page.getByTitle("Show sidebar (⌘/Ctrl+B)")).toBeVisible();
    await page.getByTitle("Show sidebar (⌘/Ctrl+B)").click();
    await expect(page.getByPlaceholder("Search Chats…")).toBeVisible();
  });

  test("cmd shortcut badges appear without adding rows", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Ask Anything")).toBeVisible();
    const countBefore = await page.locator(".chat-item").count();
    await page.keyboard.down("Meta");
    await expect(page.locator(".cmd-num").first()).toBeVisible();
    expect(await page.locator(".chat-item").count()).toBe(countBefore);
    await page.keyboard.up("Meta");
  });

  test("send shows Thinking then assistant markdown", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("Ask AI anything…")).toBeFocused();
    await page.getByPlaceholder("Ask AI anything…").fill("hello e2e");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg.assistant")).toContainText("world", {
      timeout: 10_000,
    });
    await expect(page.locator(".error-banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  });

  test("model picker filters by search", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("Ask AI anything…")).toBeFocused();
    await page.getByTitle("Select model").click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByPlaceholder("Search…").fill("flash");
    await expect(page.getByRole("option").filter({ hasText: "Flash" }).first()).toBeVisible();
    await expect(page.getByRole("option").filter({ hasText: "GPT-4o" })).toHaveCount(0);
  });

  test("⌘N reuses empty New Chat", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Ask Anything")).toBeVisible();
    const before = await page.locator(".chat-item").count();
    await page.keyboard.press("Meta+n");
    await expect(page.locator(".chat-item")).toHaveCount(before);
  });

  test("sidebar search filters threads", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("Search Chats…")).toBeVisible();
    await page.getByPlaceholder("Search Chats…").fill("zzzz-no-match");
    await expect(page.getByText("No matching chats")).toBeVisible();
    await page.getByPlaceholder("Search Chats…").fill("");
    await expect(page.getByText("New Chat").first()).toBeVisible();
  });

  test("settings clear key and always-on-top", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const clear = page.getByRole("button", { name: "Clear" });
    if (await clear.count()) {
      await clear.first().click();
      await expect(page.getByText(/key cleared/i)).toBeVisible();
    }

    const top = page.getByRole("checkbox", { name: /always on top/i });
    // toggle both ways so change always fires (memory db may already be on)
    if (await top.isChecked()) await top.uncheck();
    await top.check();
    await expect(page.locator(".settings-status")).toHaveText("Saved", {
      timeout: 5_000,
    });

    const login = page.getByRole("checkbox", { name: /start on login/i });
    await expect(login).toBeEnabled();
    await expect(login).not.toBeChecked();
    await login.check();
    await expect(login).toBeChecked();
  });

  test("asks to start on login after first launch", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText("Start Simple Chat when you log in?"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(
      page.getByText("Start Simple Chat when you log in?"),
    ).toHaveCount(0);
  });

  test("Esc from chat hides is not asserted here; Esc closes settings", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings" })).toHaveCount(0);
    await expect(page.getByText("Ask Anything")).toBeVisible();
  });

  test("thread action menu rename pin delete", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".chat-item").first()).toBeVisible();
    await page.locator(".chat-item").first().hover();
    await page.getByTitle("Actions").first().click();
    await expect(page.getByText("Rename")).toBeVisible();
    await expect(page.getByText("Pin Chat")).toBeVisible();
    await expect(page.getByText("Delete Chat")).toBeVisible();
    await page.getByText("Pin Chat").click();
    await page.locator(".chat-item").first().hover();
    await page.getByTitle("Actions").first().click();
    await expect(page.getByText("Unpin Chat")).toBeVisible();
  });
});
