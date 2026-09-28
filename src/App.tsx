import { useEffect, useState } from "react";
import "./App.css";
import { relayWsUrl } from "./api";
import { activeRelay, type ConnectionStatus } from "./relayConnection";
import { currentPubkey } from "./signer";
import type { RelayTarget } from "./types";
import RelaySidebar from "./components/RelaySidebar";
import SignerBar from "./components/SignerBar";
import GroupArea from "./components/GroupArea";

function App() {
  const [selected, setSelected] = useState<RelayTarget | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(activeRelay.getStatus());
  const [statusDetail, setStatusDetail] = useState<string | undefined>();
  const [myPubkey, setMyPubkey] = useState<string | null>(currentPubkey());
  const [relaysVersion, setRelaysVersion] = useState(0);

  useEffect(() => {
    return activeRelay.onStatus((s, detail) => {
      setStatus(s);
      setStatusDetail(detail);
    });
  }, []);

  // 選択されたrelayに接続を切り替える (読み書きは常に選択中の1本のみ。
  // onion/local どちらもバックエンドのWSプロキシ経由)
  useEffect(() => {
    if (!selected) return;
    const url =
      selected.kind === "local"
        ? relayWsUrl({ kind: "local", port: selected.relay.port })
        : relayWsUrl({ kind: "onion", address: selected.address });
    activeRelay.switchTo(url).catch((e) => console.error("接続失敗:", e));
  }, [selected]);

  return (
    <main className="app">
      <SignerBar onChanged={() => setMyPubkey(currentPubkey())} />
      <div className="app-body">
        <RelaySidebar
          selected={selected}
          onSelect={setSelected}
          relaysVersion={relaysVersion}
          onRelaysChanged={() => setRelaysVersion((v) => v + 1)}
        />
        <GroupArea status={status} statusDetail={statusDetail} myPubkey={myPubkey} />
      </div>
    </main>
  );
}

export default App;
