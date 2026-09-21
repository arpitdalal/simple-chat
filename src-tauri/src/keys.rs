use keyring::Entry;

const SERVICE: &str = "com.arpitdalal.simple-chat";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(map_keyring_err)
}

/// Empty / whitespace keys clear the credential instead of storing blanks.
pub fn is_clear_key(key: &str) -> bool {
    key.trim().is_empty()
}

/// User-facing guidance when the OS credential manager fails.
fn map_keyring_err(err: keyring::Error) -> String {
    match &err {
        keyring::Error::NoEntry => err.to_string(),
        keyring::Error::NoStorageAccess(_) => {
            "Could not access the OS credential store. Unlock Keychain / Credential Manager / Secret Service (or approve access), then try again.".into()
        }
        keyring::Error::PlatformFailure(_) => {
            "The OS credential store failed. Check Keychain / Credential Manager / Secret Service is running, then try again.".into()
        }
        keyring::Error::NoDefaultStore => {
            "No OS credential store is available. Install or start Keychain, Windows Credential Manager, or a Secret Service (e.g. gnome-keyring / KWallet), then try again.".into()
        }
        keyring::Error::Ambiguous(_) => {
            "Multiple matching credentials found in the OS store. Remove duplicates in Keychain Access / Credential Manager / Seahorse, then save the key again.".into()
        }
        keyring::Error::TooLong(_, _) | keyring::Error::Invalid(_, _) => {
            "That API key was rejected by the OS credential store (invalid or too long). Shorten or re-enter it, then try again.".into()
        }
        keyring::Error::BadEncoding(_)
        | keyring::Error::BadDataFormat(_, _)
        | keyring::Error::BadStoreFormat(_) => {
            "A saved credential is unreadable. Clear the key in Settings and paste it again.".into()
        }
        _ => {
            "Credential store error. Check the OS keychain / credential manager and try again.".into()
        }
    }
}

fn set_api_key_sync(provider: String, key: String) -> Result<(), String> {
    let e = entry(&provider)?;
    if is_clear_key(&key) {
        match e.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(map_keyring_err(err)),
        }
    } else {
        e.set_password(key.trim()).map_err(map_keyring_err)
    }
}

fn get_api_key_sync(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(map_keyring_err(err)),
    }
}

fn has_api_key_sync(provider: String) -> Result<bool, String> {
    match entry(&provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(map_keyring_err(err)),
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    // Keychain I/O can block on OS prompts — keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || set_api_key_sync(provider, key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_api_key(provider: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_api_key_sync(provider))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn has_api_key(provider: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || has_api_key_sync(provider))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_key_detects_blank_and_whitespace() {
        assert!(is_clear_key(""));
        assert!(is_clear_key("   "));
        assert!(!is_clear_key("sk-abc"));
    }

    #[test]
    fn map_keyring_err_guides_on_missing_store() {
        let msg = map_keyring_err(keyring::Error::NoDefaultStore);
        assert!(msg.contains("No OS credential store"), "{msg}");
        assert!(msg.contains("Secret Service"), "{msg}");
        assert!(!msg.contains("Unlock"), "{msg}");
    }

    #[test]
    fn map_keyring_err_guides_unlock_on_no_storage_access() {
        let msg = map_keyring_err(keyring::Error::NoStorageAccess(
            "locked".to_string().into(),
        ));
        assert!(msg.contains("Unlock"), "{msg}");
    }

    #[test]
    fn map_keyring_err_platform_failure_avoids_unlock_cta() {
        let msg = map_keyring_err(keyring::Error::PlatformFailure(
            "backend".to_string().into(),
        ));
        assert!(msg.contains("failed"), "{msg}");
        assert!(!msg.contains("Unlock"), "{msg}");
    }

    #[test]
    fn map_keyring_err_bad_encoding_points_to_clear() {
        let msg = map_keyring_err(keyring::Error::BadEncoding(vec![0xff]));
        assert!(msg.contains("Clear"), "{msg}");
    }

    #[test]
    fn map_keyring_err_ambiguous_avoids_debug_dump() {
        let msg = map_keyring_err(keyring::Error::Ambiguous(vec![]));
        assert!(msg.contains("Multiple matching"), "{msg}");
        assert!(!msg.contains("Entry"), "{msg}");
    }

    #[test]
    fn map_keyring_err_keeps_no_entry_plain() {
        let msg = map_keyring_err(keyring::Error::NoEntry);
        assert_eq!(msg, keyring::Error::NoEntry.to_string());
    }
}
