# Windows and Linux support plan

## Decision

Ship Windows first, then Linux. Build the shared release and verification contract before adding either platform, and do not advertise a platform until its native build, installer, signing, IPC, updater, and clean-machine smoke checks pass.

The first release targets are intentionally narrow:

| Platform | Initial architecture | Initial artifact | Update artifact | Out of scope initially |
| --- | --- | --- | --- | --- |
| Windows | x86_64 | NSIS installer, MSI installer | Tauri updater artifacts | ARM64, Microsoft Store, winget, portable ZIP |
| Linux | x86_64 | AppImage | Tauri updater artifacts | ARM64, Flatpak, Snap, deb, RPM, AUR |
| macOS | arm64 + x86_64 | Existing DMG and app bundle | Existing Tauri updater artifacts | No scope change |

This keeps the first cross-platform release focused on the formats already configured in `tauri.windows.conf.json` and `tauri.linux.conf.json`, while leaving a clear path to additional distribution channels later.

## Current state and issue map

The open issues form one delivery chain:

- **#32 — Ship Windows and Linux support** is the release gate and owns the final platform matrix, clean-machine checks, documentation, and publication decision.
- **#25 — Extend real IPC WebDriver e2e to Windows and Linux** is a required native test gate. The current workflow is macOS-only and explicitly records Linux/Windows WebView IPC problems.
- **#29 — Windows & Linux code signing for releases** is a required trust and distribution gate. Windows needs Authenticode; Linux needs a documented and verifiable signing story for the chosen AppImage format.
- **#6 — Wayland & Linux quirks** is a product-compatibility gate for shortcuts and monitor placement, not only a packaging task.

The repository already has:

- Tauri bundle target definitions for Windows NSIS/MSI and Linux AppImage.
- Windows and Linux capabilities in the Tauri configuration.
- A cross-platform keyring dependency graph and platform-aware error text.
- A generic Tauri updater endpoint and a macOS release workflow.
- macOS-only CI, release, IPC, documentation, and website download assumptions.

The existing configuration proves that the project is intended to be cross-platform; it does not prove that the artifacts install, run, update, or behave correctly on those platforms.

## Target architecture and operating rules

1. Build every platform on its native GitHub Actions runner for release artifacts.
2. Keep a single version source of truth and preserve the existing tag/version preflight.
3. Use a single draft GitHub Release for all platform assets. A release is not publishable until every required matrix job and artifact assertion succeeds.
4. Keep the Tauri updater signing key separate from OS package/installer signing keys. Tauri signs updater payloads; Windows Authenticode and Linux GPG authenticate downloadable installers/AppImages.
5. Add artifact assertions that run before a draft release can be published. “The action completed” is not sufficient evidence that an installer exists and is signed.
6. Keep development builds and test binaries out of the updater channel.
7. Test both a signed artifact and a clean install path. A successful `tauri build` alone does not prove install, launch, or upgrade behavior.
8. Update the website and README in the same change that introduces the first public platform artifact. Do not leave the site claiming macOS-only after Windows or Linux assets are published.

## Phase 0 — Shared release contract

### 0.1 Define the release artifact manifest

Create a repository-owned manifest or equivalent workflow assertions that records, for every release:

- Product version and release tag.
- Platform and architecture.
- Installer/AppImage filename.
- SHA-256 checksum.
- Whether the artifact is signed.
- Updater payload and signature filenames.
- Minimum supported OS version.

Use the manifest in release verification and website tests so download discovery is not coupled to one hard-coded filename per platform. The website currently resolves exactly two DMGs in `apps/website/src/lib/release.ts`; extend that model to platform assets rather than adding ad hoc selectors.

### 0.2 Separate platform configuration

Audit the shared Tauri window configuration in `apps/desktop/src-tauri/tauri.conf.json` and make the platform overlays explicit:

- Windows must not inherit macOS-only traffic-light positioning or unsupported window effects.
- Linux must use a native-compatible window configuration and retain the existing tray, autostart, global shortcut, and updater capabilities.
- Frontend chrome must be verified with native Windows and Linux window decorations; the current macOS-oriented title bar and drag-region CSS must not be the only tested layout.

The existing `tauri.windows.conf.json` and `tauri.linux.conf.json` should remain the platform entry points for these settings.

### 0.3 Create a shared validation command contract

Keep the existing commands and add platform jobs around them:

```text
pnpm test
cargo test
pnpm test:e2e
pnpm test:ipc
pnpm --filter @simple-chat/website test
pnpm --filter @simple-chat/website check
```

The native IPC job must run on the same platform and architecture it validates. The release job must run the platform build and its artifact/signature assertions after the tests.

## Phase 1 — Windows first

### 1.1 Native build and installer smoke

Add a Windows x64 job to `.github/workflows/ci.yml` and a corresponding release matrix entry in `.github/workflows/release.yml`.

The job must:

- Use `windows-latest` and the pinned Node 24/pnpm 12.6.0 toolchain.
- Install Rust, cache `apps/desktop/src-tauri/target`, and run `pnpm install --frozen-lockfile`.
- Build with the Windows bundle configuration, producing both NSIS and MSI installers.
- Assert that the unsigned CI build contains the expected `.exe`, NSIS installer, and MSI installer outputs.
- Avoid requiring release signing secrets in pull-request CI; use a separate unsigned build check there.

The existing `tauri.windows.conf.json` already declares NSIS and MSI, so this phase should first prove the existing configuration before adding new formats.

### 1.2 Windows Authenticode signing

Implement the signing portion of #29 on the Windows release job:

- Acquire and protect a code-signing certificate suitable for the project’s distribution model.
- Store the certificate and password as GitHub Actions secrets; never commit certificate material or print secret contents.
- Import the PFX into the runner’s certificate store.
- Configure Tauri’s Windows signing settings or a tested signing command for the executable and installers.
- Configure timestamping so signatures remain valid after certificate expiry.
- Verify the final NSIS installer, MSI, and packaged executable with `signtool verify /pa` or the equivalent supported verification command.
- Fail the release if signing succeeds for some outputs but not all required outputs.

Tauri’s current Windows guidance supports GitHub Actions certificate import and Authenticode configuration. Signing reduces trust warnings but does not guarantee immediate SmartScreen reputation; document that behavior rather than promising that warnings disappear for every user.

### 1.3 Native Windows IPC

Complete #25 on `windows-latest`:

- Make the WebDriver workflow a platform matrix rather than a macOS-only job.
- Preserve the Windows executable path already selected in `apps/desktop/wdio.conf.ts`.
- Use the embedded WebDriver provider if the existing Tauri/WDIO setup is stable on Windows; otherwise use the supported external driver path and document the required origin fix.
- Run at least one real Rust command round-trip from the webview, not only frontend/browser tests.
- Run the test against a release-mode webdriver build so the frontend is embedded and the app does not depend on the Vite dev server.

### 1.4 Windows product behavior

Run a clean Windows smoke test on a machine or VM without an existing Simple Chat installation:

1. Install from the NSIS artifact and verify the app launches without a console window.
2. Install the MSI artifact in a second clean environment and verify the same.
3. Launch, summon, hide, and quit through the tray.
4. Register the default global shortcut and confirm it does not conflict with common Windows shortcuts.
5. Confirm the window appears on the expected monitor and has usable native window chrome.
6. Save, read, clear, and restart with an API key in Windows Credential Manager.
7. Create a chat, close/reopen the app, and confirm SQLite history and migrations survive.
8. Test autostart enable/disable.
9. Test an update from a previous signed test release, including download, signature verification, install, relaunch, and rollback/manual recovery behavior.
10. Uninstall and confirm the user’s expected data-retention behavior is documented.

### 1.5 Windows distribution and documentation

Only after 1.1–1.4 pass:

- Add Windows download cards to `apps/website/src/pages/index.astro`.
- Extend `ResolvedRelease` and `apps/website/tests/release.test.ts` to resolve the Windows NSIS and MSI assets by platform metadata or stable filename suffixes.
- Keep the macOS Apple Silicon/Intel requirement intact.
- Update README install steps, supported Windows versions, signing/trust guidance, updater behavior, and troubleshooting.
- Add the Windows artifact names and checksum/signature verification instructions to the release notes or website.

## Phase 2 — Linux after Windows

### 2.1 Linux AppImage baseline

Add an x86_64 Linux build to CI and release using `ubuntu-22.04`, not an unconstrained newer runner, to establish a compatible glibc baseline. Install the existing WebKitGTK, AppIndicator, SVG, patchelf, and xdg-utils dependencies.

The job must:

- Build the frontend and Rust application on the Linux runner.
- Use `tauri.linux.conf.json` to produce the AppImage.
- Assert the AppImage is executable, non-empty, and contains the expected application binary.
- Check that the app’s updater payload and Tauri `.sig` are generated.
- Use `xvfb` for automated GUI/IPC tests where a real desktop session is not available.

Do not cross-compile the first Linux artifact from macOS or Windows. Build it natively and validate the oldest supported glibc baseline.

### 2.2 Linux AppImage signing

Implement the Linux portion of #29 for the AppImage format:

- Generate or obtain a project signing key and protect its private key/passphrase as GitHub Actions secrets.
- Sign the AppImage during the build with the supported AppImage/GPG signing variables.
- Fail the build when signing fails; do not rely on the default behavior that can still emit an unsigned AppImage.
- Publish the public key fingerprint through an authenticated channel such as the HTTPS website.
- Add a documented `validate` command showing how users verify the downloaded AppImage.
- Keep the Tauri updater private key separate from the GPG key.
- Add a CI/release assertion that the AppImage contains a signature and that the public fingerprint matches the documented key.

AppImage signatures are not automatically validated by the AppImage runtime. The trust story must therefore include an explicit user verification procedure, not just a signed-file claim.

### 2.3 Wayland and Linux behavior

Close the implementation portion of #6 before declaring Linux support:

- Test global shortcut registration and toggling under both X11 and Wayland on supported desktop environments.
- Determine whether the current WebKit/Tauri path can reliably report the cursor and position the window under Wayland.
- If it cannot, implement a deliberate fallback: show on the active/primary monitor and clearly document that cursor-monitor summoning is X11-only or best effort under Wayland.
- Keep X11 behavior as the baseline for monitor-under-cursor positioning.
- Do not claim full Wayland support until shortcut, show/hide, tray, window placement, and autostart behavior are verified on a real Wayland session.
- Document the supported distribution/desktop-environment matrix and the exact Wayland limitation.

The current limitation is already documented in `apps/desktop/src/lib/hotkey.ts`; the plan is to turn that into a tested compatibility decision rather than leaving it as an undocumented platform difference.

### 2.4 Linux native IPC and desktop smoke

Complete #25 on `ubuntu-22.04` with the needed `webkit2gtk-driver` and `xvfb` packages. Use the same real `invoke` round-trip as the macOS and Windows jobs. If the embedded provider remains unstable, isolate the external `tauri-driver` path and document the origin/configuration fix.

Run clean Linux smoke tests on representative X11 and Wayland sessions:

1. Download and verify the AppImage signature.
2. Make it executable and launch it on a clean system.
3. Verify the app window, tray icon, autostart setting, and global shortcut.
4. Verify shortcut show/hide and the chosen Wayland fallback.
5. Save and retrieve an API key through a real Secret Service provider such as GNOME Keyring or KWallet.
6. Create and reopen local chats after restart.
7. Verify the updater detects, downloads, verifies, installs, and relaunches a newer test release.
8. Verify the app starts correctly after a desktop-environment restart and after logout/login.
9. Record the minimum glibc/WebKitGTK/desktop-environment requirements.

### 2.5 Linux distribution and documentation

Only after 2.1–2.4 pass:

- Add the x86_64 AppImage to the website’s platform-aware release model and download UI.
- Add AppImage signature verification, key fingerprint, minimum OS, Secret Service, X11, and Wayland instructions to the README.
- Publish checksums and signatures alongside the artifact.
- Consider `.deb`, Flatpak, Snap, RPM, AUR, or ARM64 only as separate follow-up work after AppImage support is stable. Do not let those formats block the first release gate.

## Phase 3 — Unified release publication

### 3.1 Release workflow gates

Refactor the release workflow so each platform has a native build job and platform-specific assertions. The release should be published only when all of these pass:

- Version/tag preflight.
- Unit, Rust, browser E2E, and native IPC tests.
- Windows signed NSIS, MSI, and executable assertions.
- Linux signed AppImage, updater payload, and signature assertions.
- Existing macOS signing/notarization assertions.
- Release asset completeness and checksum verification.
- Website release resolution against the complete published release.

Keep the current draft-release and failed-draft cleanup behavior. A failure in any platform should leave the release in draft rather than publishing a partial platform matrix.

### 3.2 Updater validation

Test the updater separately from installer installation:

- Create a temporary previous-version release for each platform with the same Tauri updater public key.
- Verify `latest.json` contains the correct platform/architecture payload and `.sig` entries.
- Verify the current build rejects a missing, malformed, or wrong-key signature.
- Verify a signed update downloads and installs on a clean install of the previous version.
- Verify restart behavior and document any platform-specific manual recovery step.

Do not use the macOS release as proof that Windows or Linux updater paths work; the generated manifest and runtime platform detection must be checked per platform.

## Final release gate for #32

Before changing the project’s public support status, require a signed release with:

### Windows

- x86_64 NSIS installer.
- x86_64 MSI installer.
- Authenticode verification for the executable and installers.
- Successful clean install, launch, tray, shortcut, window, Credential Manager, SQLite, autostart, and updater checks.
- Native Windows IPC CI green.

### Linux

- x86_64 AppImage.
- Embedded GPG signature plus published public fingerprint.
- Signature validation from a clean download.
- Successful AppImage launch, tray, shortcut, window, Secret Service, SQLite, autostart, and updater checks.
- Native Linux IPC CI green.
- Explicit X11/Wayland results and documented limitations.

### Shared

- Existing macOS build/signing/notarization remains green.
- Website tests and build pass with the complete release manifest.
- README documents supported OS versions, install steps, artifact verification, updates, storage/keychain behavior, and platform limitations.
- The release contains checksums, installer signatures, Tauri updater payloads, and Tauri updater signatures.
- A human publishes the draft only after all checks pass.

## Recommended execution order

1. Add shared artifact/manifest and platform-configuration work.
2. Implement Windows build and unsigned CI artifacts.
3. Implement Windows Authenticode and release assertions.
4. Fix and green Windows native IPC.
5. Run Windows clean-machine product and updater smoke tests.
6. Publish Windows download/docs support.
7. Implement Linux AppImage build on the compatibility baseline.
8. Add Linux AppImage signing and verification.
9. Resolve or explicitly scope the Wayland behavior in #6.
10. Green Linux native IPC and run X11/Wayland clean-session smoke tests.
11. Publish Linux download/docs support.
12. Run the unified release gate and close #32 only after #6, #25, and #29 are complete.

## Risks to manage explicitly

- SmartScreen reputation is not guaranteed immediately after code signing; document the likely warning/reputation delay.
- AppImage signing requires a separate key-management and user-verification story.
- Wayland may prevent reliable cursor location and window placement; the product must not imply behavior it cannot provide.
- Linux glibc compatibility can regress if artifacts are built on a newer base than the supported baseline.
- Tauri's current shared window configuration and frontend chrome contain macOS-specific assumptions.
- Native WebDriver automation is the highest-risk CI dependency and should be isolated early rather than discovered during release week.
- The current website release resolver and user-facing copy only understand macOS DMGs and will fail or misrepresent a multi-platform release until updated.
