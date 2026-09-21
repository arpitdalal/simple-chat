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
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

fn show_main_window(app: &AppHandle) {
    focus::capture_previous_app();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
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

#[tauri::command]
fn capture_previous_app() {
    focus::capture_previous_app();
}

#[tauri::command]
fn hide_main_window_cmd(app: AppHandle) {
    hide_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
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
        ])
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Agent-style: no Dock icon. Menu bar app name comes from Info.plist.
            #[cfg(target_os = "macos")]
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

            show_main_window(app.handle());

            // Re-assert accessory after showing (dev builds sometimes bounce to regular).
            #[cfg(target_os = "macos")]
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
            _ => {}
        }
    });
}
