use tauri_plugin_sql::{Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:simple-chat.db";

/// Versioned schema for `simple-chat.db`. Applied by tauri-plugin-sql / sqlx.
pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "initial_schema",
        sql: r#"
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
"#,
        kind: MigrationKind::Up,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_migration_defines_core_tables() {
        let m = &migrations()[0];
        assert_eq!(m.version, 1);
        assert!(m.sql.contains("CREATE TABLE IF NOT EXISTS settings"));
        assert!(m.sql.contains("CREATE TABLE IF NOT EXISTS chats"));
        assert!(m.sql.contains("CREATE TABLE IF NOT EXISTS messages"));
        assert!(m.sql.contains("pinned INTEGER NOT NULL DEFAULT 0"));
    }
}
