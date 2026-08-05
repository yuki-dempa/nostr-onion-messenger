import { useEffect, useState } from "react";
import {
  connectBunker,
  currentPubkey,
  disconnectBunker,
  isSignerReady,
  restoreBunker,
  savedBunkerUri,
} from "../signer";

export default function SignerBar({ onChanged }: { onChanged: () => void }) {
  const [pubkey, setPubkey] = useState<string | null>(currentPubkey());
  const [uri, setUri] = useState(savedBunkerUri() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isSignerReady()) return;
    setBusy(true);
    restoreBunker().then((pk) => {
      setPubkey(pk);
      setBusy(false);
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const pk = await connectBunker(uri);
      setPubkey(pk);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    disconnectBunker();
    setPubkey(null);
    onChanged();
  };

  return (
    <div className="signer-bar">
      {pubkey ? (
        <>
          <span className="signer-ok">署名機接続中</span>
          <code className="pubkey">{pubkey.slice(0, 16)}…</code>
          <button onClick={disconnect}>切断</button>
        </>
      ) : (
        <>
          <input
            type="text"
            placeholder="bunker://... (NIP-46 署名機URI)"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            disabled={busy}
          />
          <button onClick={connect} disabled={busy || !uri.trim()}>
            {busy ? "接続中..." : "署名機に接続"}
          </button>
          {error && <span className="error">{error}</span>}
        </>
      )}
    </div>
  );
}
