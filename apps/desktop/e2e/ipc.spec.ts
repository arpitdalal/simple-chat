/**
 * Real Tauri ↔ webview IPC via embedded WebDriver (tauri-plugin-wdio-webdriver).
 */
describe("tauri-driver IPC", () => {
  async function focusAppWebview() {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const handles = await browser.getWindowHandles();
      for (const handle of handles) {
        await browser.switchToWindow(handle);
        const diag = await browser.execute(() => ({
          href: location.href,
          hasInvoke: Boolean(
            (window as unknown as { __TAURI__?: { core?: { invoke?: unknown } } })
              .__TAURI__?.core?.invoke,
          ),
          body: document.body?.innerText?.slice(0, 200) ?? "",
        }));
        if (diag.href && !diag.href.startsWith("about:")) {
          return diag;
        }
      }
      await browser.pause(1_000);
    }
    const handles = await browser.getWindowHandles();
    throw new Error(
      `no app webview (handles=${handles.length}); still about:blank`,
    );
  }

  it("loads the webview and round-trips a Rust command", async () => {
    const diag = await focusAppWebview();
    expect(diag.hasInvoke).toBe(true);

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const ta = document.querySelector("textarea");
          const p = ta?.placeholder ?? "";
          return (
            p.includes("Ask AI anything") ||
            p.includes("Add key to start chatting")
          );
        }),
      { timeout: 45_000, interval: 1_000 },
    );

    type IpcResult = { ok: true; value: unknown } | { ok: false; error: string };

    const result = await browser.executeAsync((done: (r: IpcResult) => void) => {
      const core = (
        window as unknown as {
          __TAURI__?: { core?: { invoke: (cmd: string, args?: object) => Promise<unknown> } };
        }
      ).__TAURI__?.core;
      if (!core?.invoke) {
        done({ ok: false, error: "missing window.__TAURI__.core.invoke" });
        return;
      }
      core
        .invoke("capture_previous_app")
        .then((value) => done({ ok: true, value }))
        .catch((err: unknown) => done({ ok: false, error: String(err) }));
    });

    expect(result.ok).toBe(true);
  });

  it("invokes has_api_key through real Rust (bool or credential error)", async () => {
    await focusAppWebview();

    type KeyResult =
      | { kind: "bool"; value: boolean }
      | { kind: "err"; message: string };

    const result = await browser.executeAsync((done: (r: KeyResult) => void) => {
      const core = (
        window as unknown as {
          __TAURI__?: { core?: { invoke: (cmd: string, args?: object) => Promise<unknown> } };
        }
      ).__TAURI__?.core;
      if (!core?.invoke) {
        done({ kind: "err", message: "missing window.__TAURI__.core.invoke" });
        return;
      }
      core
        .invoke("has_api_key", { provider: "openai" })
        .then((value) => {
          if (typeof value !== "boolean") {
            done({
              kind: "err",
              message: `expected boolean, got ${typeof value}`,
            });
            return;
          }
          done({ kind: "bool", value });
        })
        .catch((err: unknown) => done({ kind: "err", message: String(err) }));
    });

    if (result.kind === "bool") {
      expect(typeof result.value).toBe("boolean");
      return;
    }
    expect(result.message).toMatch(/credential|keychain|Secret Service|credential store/i);
  });
});
