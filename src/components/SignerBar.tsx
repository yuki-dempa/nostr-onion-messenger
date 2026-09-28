import { useEffect, useState } from "react";
import {
  connectBunker,
  connectNip07,
  currentPubkey,
  currentSignerKind,
  disconnectSigner,
  isSignerReady,
  nip07Available,
  restoreSigner,
  savedBunkerUri,
  type SignerKind,
} from "../signer";

const KIND_LABEL: Record<SignerKind, string> = {
  nip07: "拡張機能",
  nip46: "bunker",
};

export default function SignerBar({ onChanged }: { onChanged: () => void }) {
  const [pubkey, setPubkey] = useState<string | null>(currentPubkey());
  const [kind, setKind] = useState<SignerKind | null>(currentSignerKind());
  const [uri, setUri] = useState(savedBunkerUri() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBunker, setShowBunker] = useState(false);
  const hasNip07 = nip07Available();

  useEffect(() => {
    if (isSignerReady()) return;
    setBusy(true);
    restoreSigner().then((pk) => {
      setPubkey(pk);
      setKind(currentSignerKind());
      setBusy(false);
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      const pk = await fn();
      setPubkey(pk);
      setKind(currentSignerKind());
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    disconnectSigner();
    setPubkey(null);
    setKind(null);
    onChanged();
  };

  return (
    <div className="signer-bar">
      {pubkey && kind ? (
        <>
          <span className="signer-ok">ログイン中 ({KIND_LABEL[kind]})</span>
          <code className="pubkey">{pubkey.slice(0, 16)}…</code>
          <button onClick={disconnect}>ログアウト</button>
        </>
      ) : (
        <>
          <button onClick={() => login(connectNip07)} disabled={busy || !hasNip07}>
            拡張機能でログイン
          </button>
          {!hasNip07 && (
            <span className="muted">NIP-07拡張機能 (Alby, nos2x 等) が見つかりません</span>
          )}
          <button onClick={() => setShowBunker((v) => !v)} disabled={busy}>
            {showBunker ? "bunker入力を閉じる" : "bunkerで接続"}
          </button>
          {showBunker && (
            <>
              <input
                type="text"
                placeholder="bunker://... (NIP-46 署名機URI)"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                disabled={busy}
              />
              <button onClick={() => login(() => connectBunker(uri))} disabled={busy || !uri.trim()}>
                {busy ? "接続中..." : "接続"}
              </button>
            </>
          )}
          {error && <span className="error">{error}</span>}
        </>
      )}
    </div>
  );
}
