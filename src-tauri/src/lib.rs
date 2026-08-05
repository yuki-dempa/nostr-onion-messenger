mod bridge;
mod ports;
mod relay;
mod state;
mod tor;

use relay::{generate_relay_secret_key, RelayManager};
use serde::Serialize;
use state::{RelayRecord, StateStore};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;
use tor::TorManager;

struct AppState {
    store: StateStore,
    relay_mgr: RelayManager,
    tor: TorManager,
    /// onion_host -> (local_port, stop_sender)
    bridges: HashMap<String, (u16, watch::Sender<bool>)>,
}

/// フロントエンドに返すrelay情報
#[derive(Serialize, Clone)]
struct RelayDto {
    id: String,
    name: String,
    port: u16,
    local_url: String,
    onion_address: Option<String>,
    running: bool,
}

fn to_dto(rec: &RelayRecord, running: bool) -> RelayDto {
    RelayDto {
        id: rec.id.clone(),
        name: rec.name.clone(),
        port: rec.port,
        local_url: format!("ws://127.0.0.1:{}", rec.port),
        onion_address: rec.onion_address.clone(),
        running,
    }
}

fn vendor_path(rel: &str) -> PathBuf {
    // 開発時: src-tauri/../vendor/...。envで上書き可能。
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vendor").join(rel)
}

fn strfry_bin() -> PathBuf {
    std::env::var("STRFRY_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| vendor_path("strfry/strfry"))
}

fn strfry29_bin() -> PathBuf {
    std::env::var("STRFRY29_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| vendor_path("relay29/strfry29/strfry29"))
}

fn tor_bin() -> PathBuf {
    std::env::var("TOR_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/opt/homebrew/bin/tor"))
}

/// Torブートストラップを待ち、onion未発行のrelayにonionを発行して state を更新する。
/// 完了したら "relay-updated" イベントをemitする。
async fn ensure_onions(app: AppHandle) {
    // 最大120秒待つ
    for _ in 0..240 {
        let (control_port, data_dir) = {
            let state = app.state::<Mutex<AppState>>();
            let s = state.lock().unwrap();
            (s.tor.control_port, s.tor.data_dir.clone())
        };
        let progress = tor::bootstrap_progress(control_port, &data_dir).await;
        if progress >= 100 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    // onionが無いrelay全てに発行 (起動時の再発行もここで行う)
    loop {
        let work = {
            let state = app.state::<Mutex<AppState>>();
            let s = state.lock().unwrap();
            s.store
                .relays
                .iter()
                .find(|r| r.onion_address.is_none())
                .map(|r| {
                    (
                        r.id.clone(),
                        r.port,
                        r.onion_key.clone(),
                        s.tor.control_port,
                        s.tor.data_dir.clone(),
                    )
                })
        };
        let Some((id, port, key_blob, control_port, data_dir)) = work else {
            break;
        };
        match tor::add_onion(control_port, &data_dir, key_blob.as_deref(), port).await {
            Ok(svc) => {
                let state = app.state::<Mutex<AppState>>();
                let mut s = state.lock().unwrap();
                if let Some(rec) = s.store.get_mut(&id) {
                    rec.onion_address = Some(svc.hostname);
                    rec.onion_key = Some(svc.key_blob);
                }
                s.store.save().ok();
                app.emit("relay-updated", ()).ok();
            }
            Err(e) => {
                eprintln!("onion発行失敗 ({id}): {e}");
                break;
            }
        }
    }
}

#[tauri::command]
fn create_relay(app: AppHandle, name: String) -> Result<RelayDto, String> {
    let state = app.state::<Mutex<AppState>>();
    let mut s = state.lock().map_err(|e| e.to_string())?;

    let id = uuid_v4();
    let port = ports::find_free_port().map_err(|e| e.to_string())?;
    let dir = s.store.parent_dir().join("relays").join(&id);
    let rec = RelayRecord {
        id: id.clone(),
        name: name.clone(),
        port,
        onion_address: None,
        onion_key: None,
        relay_secret_key: generate_relay_secret_key(),
        dir,
    };
    // domainはonion確定後に再生成される。初回はlocalhost。
    let domain = format!("127.0.0.1:{port}");
    s.relay_mgr.write_configs(&rec, &domain)?;
    s.relay_mgr.start(&rec)?;
    s.store.insert(rec.clone());
    s.store.save().map_err(|e| e.to_string())?;

    // バックグラウンドでonion発行
    let app2 = app.clone();
    tauri::async_runtime::spawn(ensure_onions(app2));

    Ok(to_dto(&rec, true))
}

#[tauri::command]
fn list_relays(state: tauri::State<Mutex<AppState>>) -> Result<Vec<RelayDto>, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let AppState {
        store, relay_mgr, ..
    } = &mut *s;
    let mut out = Vec::new();
    for rec in &store.relays {
        let running = relay_mgr.is_running(&rec.id);
        out.push(to_dto(rec, running));
    }
    Ok(out)
}

#[tauri::command]
fn start_relay(state: tauri::State<Mutex<AppState>>, id: String) -> Result<RelayDto, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let rec = s.store.get(&id).ok_or("relayが見つからない")?.clone();
    let domain = rec
        .onion_address
        .clone()
        .unwrap_or_else(|| format!("127.0.0.1:{}", rec.port));
    s.relay_mgr.write_configs(&rec, &domain)?;
    s.relay_mgr.start(&rec)?;
    Ok(to_dto(&rec, true))
}

#[tauri::command]
fn stop_relay(state: tauri::State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.relay_mgr.stop(&id)
}

#[tauri::command]
fn delete_relay(state: tauri::State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.relay_mgr.stop(&id)?;
    if let Some(rec) = s.store.remove(&id) {
        std::fs::remove_dir_all(&rec.dir).ok();
        s.store.save().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn tor_status(state: tauri::State<'_, Mutex<AppState>>) -> Result<u8, String> {
    let (control_port, data_dir) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.tor.control_port, s.tor.data_dir.clone())
    };
    Ok(tor::bootstrap_progress(control_port, &data_dir).await)
}

/// 外部onion relayへの接続用ローカルブリッジを開始する。
/// 戻り値の ws://127.0.0.1:<port> に接続すればtor経由でonionに届く。
#[tauri::command]
async fn open_onion_bridge(
    state: tauri::State<'_, Mutex<AppState>>,
    onion_host: String,
) -> Result<String, String> {
    let host = onion_host
        .trim_start_matches("ws://")
        .trim_start_matches("wss://")
        .trim_end_matches('/')
        .to_string();
    {
        let s = state.lock().map_err(|e| e.to_string())?;
        if let Some((port, _)) = s.bridges.get(&host) {
            return Ok(format!("ws://127.0.0.1:{port}"));
        }
    }
    let socks_port = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.tor.socks_port
    };
    let (port, stop) = bridge::start_bridge(socks_port, host.clone(), 80).await?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.bridges.insert(host, (port, stop));
    Ok(format!("ws://127.0.0.1:{port}"))
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
        b[14], b[15]
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dirの解決に失敗");
            std::fs::create_dir_all(&data_dir).ok();

            let store = StateStore::load(&data_dir.join("state.json"));
            let mut relay_mgr = RelayManager::new(strfry_bin(), strfry29_bin());
            let mut tor_mgr = TorManager::new(
                tor_bin(),
                data_dir.join("tor"),
                ports::find_free_port().unwrap_or(19051),
                ports::find_free_port().unwrap_or(19050),
            );

            tor_mgr.start().map_err(|e| format!("tor起動失敗: {e}"))?;

            // 既存relayを自動再起動
            for rec in &store.relays {
                let domain = rec
                    .onion_address
                    .clone()
                    .unwrap_or_else(|| format!("127.0.0.1:{}", rec.port));
                if let Err(e) = relay_mgr
                    .write_configs(rec, &domain)
                    .and_then(|_| relay_mgr.start(rec))
                {
                    eprintln!("relay再起動失敗 ({}): {e}", rec.id);
                }
            }

            app.manage(Mutex::new(AppState {
                store,
                relay_mgr,
                tor: tor_mgr,
                bridges: HashMap::new(),
            }));

            // バックグラウンドでonion復元/発行
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(ensure_onions(handle));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_relay,
            list_relays,
            start_relay,
            stop_relay,
            delete_relay,
            tor_status,
            open_onion_bridge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
