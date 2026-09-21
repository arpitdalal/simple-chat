/**
 * Real Tauri ↔ webview IPC via embedded WebDriver (tauri-plugin-wdio-webdriver).
 * External tauri-driver + WebKitWebDriver on Linux breaks custom-protocol Origin/IPC.
 */
describe("tauri-driver IPC", () => {
  it("loads the webview and round-trips a Rust command", async () => {
    const empty = await $("h1=Ask Anything");
    await empty.waitForExist({ timeout: 45_000 });

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
    // Headless CI often has no Secret Service — still proves IPC reached Rust.
    expect(result.message).toMatch(/credential|keychain|Secret Service|credential store/i);
  });
});
