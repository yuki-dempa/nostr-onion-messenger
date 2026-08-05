use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

/// 指定host:portへのSOCKS5接続を確立する (認証なし, DOMAINNAME形式)
async fn socks5_connect(socks_port: u16, host: &str, port: u16) -> Result<TcpStream, String> {
    let mut s = TcpStream::connect(("127.0.0.1", socks_port))
        .await
        .map_err(|e| format!("tor socks接続失敗: {e}"))?;

    // greeting: VER=5, NMETHODS=1, METHOD=0(認証なし)
    s.write_all(&[0x05, 0x01, 0x00]).await.map_err(|e| e.to_string())?;
    let mut resp = [0u8; 2];
    s.read_exact(&mut resp).await.map_err(|e| e.to_string())?;
    if resp != [0x05, 0x00] {
        return Err(format!("SOCKS5 greeting失敗: {resp:02x?}"));
    }

    // CONNECT host:port (ATYP=0x03 DOMAINNAME)
    let host_bytes = host.as_bytes();
    if host_bytes.len() > 255 {
        return Err("ホスト名が長すぎる".into());
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host_bytes.len() as u8];
    req.extend_from_slice(host_bytes);
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await.map_err(|e| e.to_string())?;

    // 応答: VER REP RSV ATYP BND.ADDR BND.PORT
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.map_err(|e| e.to_string())?;
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 CONNECT失敗: REP={}", head[1]));
    }
    let skip = match head[3] {
        0x01 => 4,
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await.map_err(|e| e.to_string())?;
            len[0] as usize
        }
        0x04 => 16,
        _ => return Err("SOCKS5応答のATYPが不正".into()),
    };
    let mut buf = vec![0u8; skip + 2];
    s.read_exact(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(s)
}

/// ローカルTCPブリッジを起動し、接続をtor経由で target_host:target_port にトンネルする。
/// 戻り値: (ローカルポート, 停止用sender)
pub async fn start_bridge(
    socks_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<(u16, watch::Sender<bool>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (stop_tx, mut stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                accept = listener.accept() => {
                    let Ok((inbound, _)) = accept else { continue };
                    let host = target_host.clone();
                    tokio::spawn(async move {
                        match socks5_connect(socks_port, &host, target_port).await {
                            Ok(outbound) => {
                                let (mut ri, mut wi) = inbound.into_split();
                                let (mut ro, mut wo) = outbound.into_split();
                                let t1 = tokio::spawn(async move { tokio::io::copy(&mut ri, &mut wo).await.ok() });
                                let t2 = tokio::spawn(async move { tokio::io::copy(&mut ro, &mut wi).await.ok() });
                                let _ = tokio::join!(t1, t2);
                            }
                            Err(e) => eprintln!("bridge: onion接続失敗: {e}"),
                        }
                    });
                }
            }
        }
    });

    Ok((local_port, stop_tx))
}
