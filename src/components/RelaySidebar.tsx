import { useEffect, useState } from "react";
import { api, authenticate, authToken, loadExternalRelays, saveExternalRelays } from "../api";
import { currentPubkey } from "../signer";
import type { RelayDto, RelayTarget } from "../types";

interface Props {
  selected: RelayTarget | null;
  onSelect: (t: RelayTarget) => void;
  relaysVersion: number;
  onRelaysChanged: () => void;
}

export default function RelaySidebar({ selected, onSelect, relaysVersion, onRelaysChanged }: Props) {
  const [relays, setRelays] = useState<RelayDto[]>([]);
  const [externals, setExternals] = useState<string[]>(loadExternalRelays());
  const [torProgress, setTorProgress] = useState(0);
  const [hosted, setHosted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newExt, setNewExt] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.serverInfo().then((info) => setHosted(info.hosted)).catch(() => {});
  }, []);

  const refresh = async () => {
    try {
      setRelays(await api.listRelays());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    // onion発行などの更新を定期ポーリングで拾う
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysVersion]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setTorProgress((await api.torStatus()).progress);
      } catch {
        // tor未起動時は無視
      }
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const createRelay = async () => {
    // ホストモード: relayはこのサイトのサーバー上に作られ、アカウントに紐づく。
    // 作成にはログイン + サーバー認証 (NIP-98署名) が必要
    if (hosted && !currentPubkey()) {
      setError("このサイトでRelayを作成するには、まず上部のバーからログインしてください");
      return;
    }
    const name = window.prompt("新しいRelayの名前", `relay-${relays.length + 1}`);
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      if (hosted && !authToken()) await authenticate();
      let rec: RelayDto;
      try {
        rec = await api.createRelay(name);
      } catch (e) {
        // トークン期限切れ等の場合は再認証して1回だけリトライ
        if (!hosted) throw e;
        await authenticate();
        rec = await api.createRelay(name);
      }
      await refresh();
      onRelaysChanged();
      onSelect({ kind: "local", relay: rec });
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  const addExternal = () => {
    const addr = newExt
      .trim()
      .replace(/^wss?:\/\//, "")
      .replace(/\/$/, "");
    if (!addr.endsWith(".onion")) {
      setError("onionアドレス (xxxx.onion) を入力してください");
      return;
    }
    if (!externals.includes(addr)) {
      const next = [...externals, addr];
      setExternals(next);
      saveExternalRelays(next);
    }
    setNewExt("");
    setError(null);
  };

  const removeExternal = (addr: string) => {
    const next = externals.filter((a) => a !== addr);
    setExternals(next);
    saveExternalRelays(next);
  };

  const isSelected = (t: RelayTarget) =>
    selected &&
    ((t.kind === "local" && selected.kind === "local" && t.relay.id === selected.relay.id) ||
      (t.kind === "external" && selected.kind === "external" && t.address === selected.address));

  return (
    <aside className="sidebar">
      <div className="tor-status">
        Tor: {torProgress >= 100 ? "接続済み" : `起動中 ${torProgress}%`}
      </div>

      <button className="create-relay" onClick={createRelay} disabled={creating}>
        {creating ? "作成中..." : "＋ 新しいRelayを作成"}
      </button>
      {hosted && (
        <div className="muted hosted-note">
          ホストモード: Relayはこのサイトのサーバー上に作成され、あなたのアカウント専用になります
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <h3>自分のRelay</h3>
      <ul className="relay-list">
        {relays.map((r) => (
          <li
            key={r.id}
            className={isSelected({ kind: "local", relay: r }) ? "selected" : ""}
            onClick={() => onSelect({ kind: "local", relay: r })}
          >
            <div className="relay-name">
              {r.name} {r.running ? "🟢" : "⚫"}
            </div>
            <div className="relay-addr">
              {r.onion_address ? (
                <>
                  <code>{r.onion_address.slice(0, 20)}…</code>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(`ws://${r.onion_address}`);
                    }}
                  >
                    コピー
                  </button>
                </>
              ) : (
                <span className="muted">onion発行待ち</span>
              )}
            </div>
            <div className="relay-actions" onClick={(e) => e.stopPropagation()}>
              {r.running ? (
                <button onClick={() => api.stopRelay(r.id).then(refresh)}>停止</button>
              ) : (
                <button onClick={() => api.startRelay(r.id).then(refresh)}>開始</button>
              )}
              <button
                onClick={() => {
                  if (window.confirm(`「${r.name}」を削除しますか?`))
                    api.deleteRelay(r.id).then(refresh).then(onRelaysChanged);
                }}
              >
                削除
              </button>
            </div>
          </li>
        ))}
        {relays.length === 0 && <li className="muted">まだRelayがありません</li>}
      </ul>

      <h3>外部Relay (onion)</h3>
      <div className="add-external">
        <input
          type="text"
          placeholder="xxxx.onion"
          value={newExt}
          onChange={(e) => setNewExt(e.target.value)}
        />
        <button onClick={addExternal}>追加</button>
      </div>
      <ul className="relay-list">
        {externals.map((addr) => (
          <li
            key={addr}
            className={isSelected({ kind: "external", address: addr }) ? "selected" : ""}
            onClick={() => onSelect({ kind: "external", address: addr })}
          >
            <div className="relay-addr">
              <code>{addr.slice(0, 24)}…</code>
              <button onClick={(e) => (e.stopPropagation(), removeExternal(addr))}>削除</button>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
