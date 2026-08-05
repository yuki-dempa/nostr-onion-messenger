use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

/// torプロセスのライフサイクル管理
pub struct TorManager {
    pub tor_bin: PathBuf,
    pub data_dir: PathBuf,
    pub control_port: u16,
    pub socks_port: u16,
    child: Option<Child>,
}

impl TorManager {
    pub fn new(tor_bin: PathBuf, data_dir: PathBuf, control_port: u16, socks_port: u16) -> Self {
        Self {
            tor_bin,
            data_dir,
            control_port,
            socks_port,
            child: None,
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        let log = fs::File::create(self.data_dir.join("tor.log")).map_err(|e| e.to_string())?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&self.tor_bin)
            .args([
                "--DataDirectory",
                &self.data_dir.to_string_lossy(),
                "--ControlPort",
                &self.control_port.to_string(),
                "--CookieAuthentication",
                "1",
                "--SocksPort",
                &format!("127.0.0.1:{}", self.socks_port),
                // システムのtorと衝突しないよう専用data dirで隔離
            ])
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .map_err(|e| format!("tor起動失敗: {e}"))?;
        self.child = Some(child);
        Ok(())
    }

    pub fn is_running(&mut self) -> bool {
        if let Some(c) = &mut self.child {
            matches!(c.try_wait(), Ok(None))
        } else {
            false
        }
    }

    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            c.kill().ok();
            c.wait().ok();
        }
    }
}

impl Drop for TorManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// ADD_ONION の結果
pub struct OnionService {
    /// "xxxx....onion"
    pub hostname: String,
    /// 永続化用の鍵ブロブ ("ED25519-V3:xxxx==")。次回 ADD_ONION に渡すと同じアドレスが復元される。
    pub key_blob: String,
}

fn read_cookie_hex(data_dir: &Path) -> Result<String, String> {
    let cookie = fs::read(data_dir.join("control_auth_cookie"))
        .map_err(|e| format!("control_auth_cookie読み取り失敗: {e}"))?;
    Ok(crate::relay::hex_encode(&cookie))
}

/// ブートストラップ進捗 (0-100)。接続できない場合は0。
pub async fn bootstrap_progress(control_port: u16, data_dir: &Path) -> u8 {
    let Ok(cookie) = read_cookie_hex(data_dir) else {
        return 0;
    };
    let Ok(mut client) = ControlClient::connect(control_port, &cookie).await else {
        return 0;
    };
    client
        .getinfo("status/bootstrap-phase")
        .await
        .ok()
        .and_then(|line| {
            // "status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 ..." 形式
            line.split_whitespace()
                .find_map(|tok| tok.strip_prefix("PROGRESS=")?.parse::<u8>().ok())
        })
        .unwrap_or(0)
}

/// onionサービスを発行して 127.0.0.1:target_port へ転送する。
/// key_blob: Someなら既存アドレスを復元、Noneなら新規生成。
pub async fn add_onion(
    control_port: u16,
    data_dir: &Path,
    key_blob: Option<&str>,
    target_port: u16,
) -> Result<OnionService, String> {
    let cookie = read_cookie_hex(data_dir)?;
    let mut client = ControlClient::connect(control_port, &cookie).await?;
    let key = key_blob.unwrap_or("NEW:ED25519-V3");
    let resp = client
        .command(&format!(
            // Detach: 制御接続が切れてもonionサービスを維持する (維持しないと接続断で即削除される)
            "ADD_ONION {key} Flags=DiscardPK,Detach Port=80,127.0.0.1:{target_port}"
        ))
        .await?;

    let mut hostname = None;
    let mut blob = None;
    for line in resp.lines() {
        if let Some(id) = line.strip_prefix("250-ServiceID=") {
            hostname = Some(format!("{id}.onion"));
        } else if let Some(k) = line.strip_prefix("250-PrivateKey=") {
            blob = Some(k.to_string());
        }
    }
    // 既存鍵で復元した場合はPrivateKeyが返らない
    let key_blob = blob.or_else(|| key_blob.map(|s| s.to_string()));
    match (hostname, key_blob) {
        (Some(h), Some(k)) => Ok(OnionService {
            hostname: h,
            key_blob: k,
        }),
        _ => Err(format!("ADD_ONIONの応答が不正: {resp}")),
    }
}

pub async fn del_onion(control_port: u16, data_dir: &Path, hostname: &str) -> Result<(), String> {
    let cookie = read_cookie_hex(data_dir)?;
    let mut client = ControlClient::connect(control_port, &cookie).await?;
    let service_id = hostname.trim_end_matches(".onion");
    client.command(&format!("DEL_ONION {service_id}")).await?;
    Ok(())
}

/// Tor Control Port の最小クライアント (250応答のみ処理)
pub struct ControlClient {
    stream: TcpStream,
}

impl ControlClient {
    pub async fn connect(control_port: u16, cookie_hex: &str) -> Result<Self, String> {
        let stream = TcpStream::connect(("127.0.0.1", control_port))
            .await
            .map_err(|e| format!("Control Port接続失敗: {e}"))?;
        let mut client = Self { stream };
        client
            .command(&format!("AUTHENTICATE {cookie_hex}"))
            .await?;
        Ok(client)
    }

    /// コマンドを送り、最終 "250 OK" までの応答全文を返す。エラー応答(4xx/5xx)はErr。
    pub async fn command(&mut self, cmd: &str) -> Result<String, String> {
        self.stream
            .write_all(format!("{cmd}\r\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(&mut self.stream);
        let mut out = String::new();
        loop {
            let mut line = String::new();
            let n = reader.read_line(&mut line).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("Control Portが切断された".into());
            }
            out.push_str(&line);
            // 最終行: "250 OK" / "250 ..." (ハイフン/プラス継続でない)
            if line.starts_with("250 ") {
                return Ok(out);
            }
            if line.starts_with('5') || line.starts_with('4') {
                return Err(format!("tor control error: {}", line.trim()));
            }
        }
    }

    pub async fn getinfo(&mut self, key: &str) -> Result<String, String> {
        let resp = self.command(&format!("GETINFO {key}")).await?;
        Ok(resp
            .lines()
            .find_map(|l| l.strip_prefix("250-").map(|s| s.to_string()))
            .unwrap_or(resp))
    }
}
