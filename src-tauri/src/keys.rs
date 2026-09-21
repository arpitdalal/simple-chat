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
        keyring::Error::NoStorageAccess(_)
        | keyring::Error::PlatformFailure(_)
        | keyring::Error::NoDefaultStore => format!(
            "Could not access the OS credential store ({err}). Unlock or repair Keychain / Credential Manager / Secret Service, then try again."
        ),
        _ => format!(
            "Credential store error ({err}). Check the OS keychain / credential manager and try again."
        ),
    }
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
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

#[tauri::command]
pub fn get_api_key(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(map_keyring_err(err)),
    }
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    Ok(get_api_key(provider)?.is_some())
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
        assert!(msg.contains("OS credential store"), "{msg}");
        assert!(msg.contains("try again"), "{msg}");
    }

    #[test]
    fn map_keyring_err_keeps_no_entry_plain() {
        let msg = map_keyring_err(keyring::Error::NoEntry);
        assert_eq!(msg, keyring::Error::NoEntry.to_string());
    }
}
