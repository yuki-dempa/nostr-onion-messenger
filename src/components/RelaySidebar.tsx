import { useEffect, useState } from "react";
import { api, loadExternalRelays, onRelayUpdated, saveExternalRelays } from "../api";
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
  const [creating, setCreating] = useState(false);
  const [newExt, setNewExt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRelays(await api.listRelays());
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const un = onRelayUpdated(() => refresh());
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relaysVersion]);

  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setTorProgress(await api.torStatus());
      } catch {
        // tor未起動時は無視
      }
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const createRelay = async () => {
    const name = window.prompt("新しいRelayの名前", `relay-${relays.length + 1}`);
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const rec = await api.createRelay(name);
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
