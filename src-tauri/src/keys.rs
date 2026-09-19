use keyring::Entry;

const SERVICE: &str = "com.arpitdalal.simple-chat";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let e = entry(&provider)?;
    if key.trim().is_empty() {
        match e.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    } else {
        e.set_password(key.trim()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_api_key(provider: String) -> Result<Option<String>, String> {
    match entry(&provider)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    Ok(get_api_key(provider)?.is_some())
}
