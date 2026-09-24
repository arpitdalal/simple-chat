mod db;
mod focus;
mod keys;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

fn hide_main_window(app: &AppHandle) {
    // Restore while still active (cooperative yield), then hide. Guard blur
    // so Focused(false) from hide cannot clobber PREV_PID mid-restore.
    focus::begin_restore();
    focus::restore_previous_app();
    if let Some(window) = app.get_webview_window("main") {
        // Tell the webview to drop heavy React state before we go tray-resident.
        let _ = window.emit("main-window-hidden", ());
        let _ = window.hide();
    }
    focus::end_restore();
    #[cfg(all(target_os = "macos", not(feature = "webdriver")))]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

fn show_main_window(app: &AppHandle) {
    focus::capture_previous_app();
    if let Some(window) = app.get_webview_window("main") {
        let was_visible = window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(false);
        let _ = window.unminimize();
        if window.show().is_ok() && window.set_focus().is_ok() && !was_visible {
            let _ = window.emit("main-window-shown", ());
        }
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => hide_main_window(app),
            _ => show_main_window(app),
        }
    }
}

fn args_include_autostart<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|a| a.as_ref() == "--autostart")
}

const VISIBLE_RELAUNCH_ENV: &str = "SIMPLE_CHAT_VISIBLE";

/// Login-item `--autostart` stays tray-only unless a user restart marked itself visible.
fn should_show(visible_relaunch: bool, args: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    visible_relaunch || !args_include_autostart(args)
}

fn should_show_on_user_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    should_show(std::env::var_os(VISIBLE_RELAUNCH_ENV).is_some(), args)
}

fn show_on_user_launch<I, S>(app: &AppHandle, args: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    if should_show_on_user_launch(args) {
        show_main_window(app);
    }
}

#[tauri::command]
fn capture_previous_app() {
    focus::capture_previous_app();
}

#[tauri::command]
fn hide_main_window_cmd(app: AppHandle) {
    hide_main_window(&app);
}

#[tauri::command]
fn show_main_window_cmd(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn relaunch_visible(app: AppHandle) {
    // Child inherits this; Tauri restart handles AppImage / .app / lock teardown.
    std::env::set_var(VISIBLE_RELAUNCH_ENV, "1");
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single-instance must be first so a second process never reaches setup.
    #[cfg(desktop)]
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        |app, argv, _cwd| {
            show_on_user_launch(app, &argv);
        },
    ));
    #[cfg(not(desktop))]
    let builder = tauri::Builder::default();

    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        // Hotkey registered from the frontend so users can rebind it in Settings.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            keys::set_api_key,
            keys::get_api_key,
            keys::has_api_key,
            capture_previous_app,
            hide_main_window_cmd,
            show_main_window_cmd,
            relaunch_visible,
        ]);

    // Before setup so on_webview_ready applies to the main webview (CI IPC e2e).
    #[cfg(feature = "webdriver")]
    let builder = if std::env::var(tauri_plugin_wdio_webdriver::PORT_ENV_VAR).is_ok() {
        builder.plugin(tauri_plugin_wdio_webdriver::init())
    } else {
        builder
    };

    let builder = builder.setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    Some(vec!["--autostart"]),
                ))?;
            }

            // Agent-style: no Dock icon. Menu bar app name comes from Info.plist.
            // WebDriver CI needs a normal activation policy or the webview stays blank.
            #[cfg(all(target_os = "macos", not(feature = "webdriver")))]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let show = MenuItem::with_id(app, "show", "Show Simple Chat", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Simple Chat")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Login-item launches stay tray-only; user / hotkey / tray show the window.
            show_on_user_launch(app.handle(), std::env::args());

            // Re-assert accessory after showing (dev builds sometimes bounce to regular).
            #[cfg(all(target_os = "macos", not(feature = "webdriver")))]
            app.set_activation_policy(ActivationPolicy::Accessory);

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Simple Chat");

    app.run(|app_handle, event| {
        match event {
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                api.prevent_close();
                hide_main_window(app_handle);
            }
            // While visible, another app may take focus — remember it for restore on hide.
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Focused(false),
                ..
            } if label == "main" => {
                focus::capture_previous_app();
            }
            // Hidden login-item process: Finder / Spotlight reopen (no new process).
            #[cfg(target_os = "macos")]
            RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => {
                show_main_window(app_handle);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{args_include_autostart, should_show};

    #[test]
    fn detects_autostart_flag() {
        assert!(!args_include_autostart(["simple-chat"]));
        assert!(args_include_autostart(["simple-chat", "--autostart"]));
    }

    #[test]
    fn user_launch_shows_except_login_item() {
        assert!(should_show(false, ["simple-chat"]));
        assert!(!should_show(false, ["simple-chat", "--autostart"]));
        assert!(should_show(true, ["simple-chat", "--autostart"]));
    }
}
