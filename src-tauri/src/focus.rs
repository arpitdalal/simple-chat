//! Restore keyboard focus to the previously frontmost app when we hide.
//! macOS accessory / LSUIElement apps otherwise leave focus in the void after hide.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

/// PID of the app that was frontmost before we took focus. 0 = none.
static PREV_PID: AtomicI32 = AtomicI32::new(0);

/// True while hide+restore runs — blur must not clobber PREV_PID mid-restore.
static RESTORING: AtomicBool = AtomicBool::new(false);

/// Remember the frontmost app if it isn't us. Call before show / set_focus.
/// No-op while a restore is in flight (blur during hide).
#[cfg(target_os = "macos")]
pub fn capture_previous_app() {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};

    if RESTORING.load(Ordering::SeqCst) {
        return;
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let Some(front) = workspace.frontmostApplication() else {
        return;
    };
    let me = NSRunningApplication::currentApplication();
    let front_pid = front.processIdentifier();
    if front_pid != me.processIdentifier() {
        PREV_PID.store(front_pid, Ordering::SeqCst);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture_previous_app() {}

/// Begin a hide/restore critical section (pair with [`end_restore`]).
pub fn begin_restore() {
    RESTORING.store(true, Ordering::SeqCst);
}

pub fn end_restore() {
    RESTORING.store(false, Ordering::SeqCst);
}

/// Re-activate the app we displaced. Call while we are still the active app
/// (before `window.hide`) so cooperative yield works.
#[cfg(target_os = "macos")]
pub fn restore_previous_app() {
    use objc2_app_kit::NSRunningApplication;

    let pid = PREV_PID.load(Ordering::SeqCst);
    if pid != 0 {
        if let Some(prev) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            let activated = activate_previous(&prev);
            if activated {
                PREV_PID.store(0, Ordering::SeqCst);
                return;
            }
        }
    }

    // Accessory apps: NSRunningApplication.hide() is often a no-op. Prefer
    // NSApp.hide which deactivates us and activates the next app in line.
    // Skip in unit tests — would hide the test host.
    #[cfg(not(test))]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::NSApplication;
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).hide(None);
        }
    }
    PREV_PID.store(0, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn activate_previous(prev: &objc2_app_kit::NSRunningApplication) -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication,
    };

    let me = NSRunningApplication::currentApplication();

    // yieldActivation / activateFromApplication are macOS 14+.
    if objc2::available!(macos = 14.0) {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).yieldActivationToApplication(prev);
        }
        // Return value = request accepted (activation may complete async).
        if prev.activateFromApplication_options(
            &me,
            NSApplicationActivationOptions::empty(),
        ) {
            return true;
        }
    }

    // Pre-14 (and 14+ fallback): IgnoringOtherApps still works on older OS;
    // on 14+ it is a documented no-op but activateWithOptions remains valid.
    #[allow(deprecated)]
    let opts = NSApplicationActivationOptions::ActivateIgnoringOtherApps
        | NSApplicationActivationOptions::ActivateAllWindows;
    prev.activateWithOptions(opts)
}

#[cfg(not(target_os = "macos"))]
pub fn restore_previous_app() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn capture_blocked_while_restoring() {
        let _g = TEST_LOCK.lock().unwrap();
        end_restore();
        PREV_PID.store(0, Ordering::SeqCst);
        begin_restore();
        capture_previous_app();
        assert_eq!(PREV_PID.load(Ordering::SeqCst), 0);
        end_restore();
    }

    #[test]
    fn restore_clears_pid_via_hide_fallback_when_no_target() {
        let _g = TEST_LOCK.lock().unwrap();
        end_restore();
        PREV_PID.store(0, Ordering::SeqCst);
        begin_restore();
        restore_previous_app();
        end_restore();
        assert_eq!(PREV_PID.load(Ordering::SeqCst), 0);
    }
}
