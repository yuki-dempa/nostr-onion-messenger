use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 作成されたrelayの永続化レコード
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayRecord {
    pub id: String,
    pub name: String,
    /// strfryがlistenするlocalhostポート
    pub port: u16,
    /// "xxxx....onion" 形式のホスト名 (Tor起動・onion発行後に設定)
    pub onion_address: Option<String>,
    /// ADD_ONION で使う永続鍵ブロブ ("ED25519-V3:...")。
    /// 保持しておくことで再起動後も同じonionアドレスを復元できる。
    pub onion_key: Option<String>,
    /// relay29がグループメタデータイベントに署名するためのrelay秘密鍵 (hex)
    pub relay_secret_key: String,
    /// relayのデータディレクトリ (strfry.conf / strfry-db/ 等を含む)
    pub dir: PathBuf,
}

pub struct StateStore {
    path: PathBuf,
    pub relays: Vec<RelayRecord>,
}

impl StateStore {
    pub fn load(path: &Path) -> Self {
        let relays = match fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                eprintln!("state.json のパースに失敗したため空で初期化: {e}");
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        Self {
            path: path.to_path_buf(),
            relays,
        }
    }

    pub fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&self.relays)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// state.json の親ディレクトリ (= app data dir)
    pub fn parent_dir(&self) -> PathBuf {
        self.path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub fn get(&self, id: &str) -> Option<&RelayRecord> {
        self.relays.iter().find(|r| r.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut RelayRecord> {
        self.relays.iter_mut().find(|r| r.id == id)
    }

    pub fn insert(&mut self, rec: RelayRecord) {
        self.relays.push(rec);
    }

    pub fn remove(&mut self, id: &str) -> Option<RelayRecord> {
        let pos = self.relays.iter().position(|r| r.id == id)?;
        Some(self.relays.remove(pos))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> RelayRecord {
        RelayRecord {
            id: id.to_string(),
            name: format!("relay-{id}"),
            port: 7777,
            onion_address: None,
            onion_key: None,
            relay_secret_key: "ab".repeat(32),
            dir: PathBuf::from("/tmp/x"),
        }
    }

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("nom-state-{}", std::process::id()));
        let path = dir.join("state.json");
        let mut store = StateStore::load(&path);
        store.insert(sample("a"));
        store.save().unwrap();

        let store2 = StateStore::load(&path);
        assert_eq!(store2.relays.len(), 1);
        assert_eq!(store2.relays[0].id, "a");
        assert_eq!(store2.relays[0].port, 7777);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_empty() {
        let store = StateStore::load(Path::new("/tmp/definitely-not-exists-nom/state.json"));
        assert!(store.relays.is_empty());
    }
}
