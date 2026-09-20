//! Restore keyboard focus to the previously frontmost app when we hide.
//! macOS accessory / LSUIElement apps otherwise leave focus in the void after hide.

use std::sync::atomic::{AtomicI32, Ordering};

/// PID of the app that was frontmost before we took focus. 0 = none.
static PREV_PID: AtomicI32 = AtomicI32::new(0);

/// Remember the frontmost app if it isn't us. Call before show / set_focus.
#[cfg(target_os = "macos")]
pub fn capture_previous_app() {
    use objc2_app_kit::{NSRunningApplication, NSWorkspace};

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

/// Re-activate the app we displaced, or fall back to hiding ourselves (Cmd+H semantics).
#[cfg(target_os = "macos")]
pub fn restore_previous_app() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication,
    };

    let pid = PREV_PID.swap(0, Ordering::SeqCst);
    if pid != 0 {
        if let Some(prev) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            // macOS 14+: cooperative yield; IgnoringOtherApps is a no-op.
            if let Some(mtm) = MainThreadMarker::new() {
                NSApplication::sharedApplication(mtm).yieldActivationToApplication(&prev);
            }
            let me = NSRunningApplication::currentApplication();
            if prev.activateFromApplication_options(
                &me,
                NSApplicationActivationOptions::ActivateAllWindows,
            ) {
                return;
            }
            if prev.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
                return;
            }
        }
    }
    let _ = NSRunningApplication::currentApplication().hide();
}

#[cfg(not(target_os = "macos"))]
pub fn restore_previous_app() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_and_restore_leave_pid_clear() {
        capture_previous_app();
        restore_previous_app();
        assert_eq!(PREV_PID.load(Ordering::SeqCst), 0);
    }
}
