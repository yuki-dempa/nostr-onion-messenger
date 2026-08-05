use std::net::TcpListener;

/// 127.0.0.1 上で未使用のTCPポートを1つ確保して返す。
/// 0番にバインドしてOSに割り当てさせ、即座に解放する。
/// (解放後に他プロセスが取る競合は理論上あり得るが、ローカル用途では実用上十分)
pub fn find_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_usable_port() {
        let port = find_free_port().unwrap();
        assert!(port > 0);
        // 取得したポートに実際にバインドできること
        let _l = TcpListener::bind(("127.0.0.1", port)).unwrap();
    }

    #[test]
    fn returns_distinct_ports() {
        let a = find_free_port().unwrap();
        let b = find_free_port().unwrap();
        assert_ne!(a, b);
    }
}
