use crate::state::RelayRecord;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// strfry.conf テンプレート。{PORT} {NAME} {PLUGIN} {SECRET} は生成時に置換する。
/// relay29/strfry29/strfry.conf をベースに最小化したもの。
const STRFRY_CONF_TEMPLATE: &str = r#"db = "strfry-db/"

dbParams {
    maxreaders = 256
    mapsize = 10995116277760
    noReadAhead = false
}

events {
    maxEventSize = 65536
    rejectEventsNewerThanSeconds = 900
    rejectEventsOlderThanSeconds = 94608000
    rejectEphemeralEventsOlderThanSeconds = 60
    ephemeralEventsLifetimeSeconds = 300
    maxNumTags = 2000
    maxTagValSize = 1024
}

relay {
    bind = "127.0.0.1"
    port = {PORT}
    nofiles = 0
    realIpHeader = ""

    info {
        name = "{NAME}"
        description = "NIP-29 group relay hosted by nostr-onion-messenger"
        pubkey = ""
        contact = ""
        icon = ""
    }

    maxWebsocketPayloadSize = 131072
    autoPingSeconds = 29
    enableTcpKeepalive = false
    queryTimesliceBudgetMicroseconds = 10000
    maxFilterLimit = 500
    maxSubsPerConnection = 20

    writePolicy {
        plugin = "{PLUGIN}"
    }

    compression {
        enabled = false
        slidingWindow = true
    }

    logging {
        dumpInAll = false
        dumpInEvents = false
        dumpInReqs = false
        dbScanPerf = false
        invalidEvents = true
    }

    numThreads {
        ingester = 3
        reqWorker = 3
        reqMonitor = 3
        negentropy = 2
    }

    negentropy {
        enabled = true
        maxSyncEvents = 1000000
    }
}
"#;

/// strfry29.json テンプレート。{DOMAIN} {SECRET} {STRFRY_BIN} は生成時に置換する。
/// permissions は relay29 のデフォルトロール定義 (master=全権限, admin=モデレーション, member=書き込み)。
const STRFRY29_JSON_TEMPLATE: &str = r#"{
  "domain": "{DOMAIN}",
  "relay_secret_key": "{SECRET}",
  "strfry_config_path": "strfry.conf",
  "strfry_executable_path": "{STRFRY_BIN}",
  "group_creator_default_role": "master",
  "permissions": {
    "master": [
      "AddUser", "RemoveUser", "EditMetadata", "DeleteEvent",
      "AddPermission", "RemovePermission", "DeleteGroup",
      "CreateInvite", "CreateGroup"
    ],
    "admin": [
      "AddUser", "RemoveUser", "EditMetadata", "DeleteEvent", "CreateInvite"
    ],
    "member": []
  }
}
"#;

pub struct RelayManager {
    pub strfry_bin: PathBuf,
    pub strfry29_bin: PathBuf,
    children: HashMap<String, Child>,
}

impl RelayManager {
    pub fn new(strfry_bin: PathBuf, strfry29_bin: PathBuf) -> Self {
        Self {
            strfry_bin,
            strfry29_bin,
            children: HashMap::new(),
        }
    }

    /// relay用ディレクトリに設定ファイルを書き出す
    pub fn write_configs(
        &self,
        rec: &RelayRecord,
        domain: &str,
    ) -> Result<(), String> {
        fs::create_dir_all(rec.dir.join("strfry-db")).map_err(|e| e.to_string())?;

        let conf = STRFRY_CONF_TEMPLATE
            .replace("{PORT}", &rec.port.to_string())
            .replace("{NAME}", &rec.name.replace('"', ""))
            .replace(
                "{PLUGIN}",
                &self.strfry29_bin.to_string_lossy(),
            );
        fs::write(rec.dir.join("strfry.conf"), conf).map_err(|e| e.to_string())?;

        let json = STRFRY29_JSON_TEMPLATE
            .replace("{DOMAIN}", domain)
            .replace("{SECRET}", &rec.relay_secret_key)
            .replace("{STRFRY_BIN}", &self.strfry_bin.to_string_lossy());
        fs::write(rec.dir.join("strfry29.json"), json).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// strfry relayプロセスを起動する。既に起動済みなら何もしない。
    pub fn start(&mut self, rec: &RelayRecord) -> Result<(), String> {
        self.reap();
        if self.children.contains_key(&rec.id) {
            return Ok(());
        }
        let log = fs::File::create(rec.dir.join("strfry.log")).map_err(|e| e.to_string())?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&self.strfry_bin)
            .arg("relay")
            .current_dir(&rec.dir)
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .map_err(|e| format!("strfry起動失敗: {e}"))?;
        self.children.insert(rec.id.clone(), child);
        Ok(())
    }

    pub fn stop(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut child) = self.children.remove(id) {
            child.kill().map_err(|e| e.to_string())?;
            child.wait().ok();
        }
        Ok(())
    }

    pub fn is_running(&mut self, id: &str) -> bool {
        self.reap();
        self.children.contains_key(id)
    }

    pub fn stop_all(&mut self) {
        let ids: Vec<String> = self.children.keys().cloned().collect();
        for id in ids {
            self.stop(&id).ok();
        }
    }

    /// 終了した子プロセスを回収する
    fn reap(&mut self) {
        let dead: Vec<String> = self
            .children
            .iter_mut()
            .filter_map(|(id, c)| match c.try_wait() {
                Ok(Some(_)) => Some(id.clone()),
                _ => None,
            })
            .collect();
        for id in dead {
            self.children.remove(&id);
        }
    }
}

impl Drop for RelayManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// relay29用のランダムな秘密鍵 (32バイトhex) を生成する
pub fn generate_relay_secret_key() -> String {
    let mut key = [0u8; 32];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut key);
    hex_encode(&key)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
