import { useEffect, useMemo, useRef, useState } from "react";
import type { NostrEvent } from "nostr-tools";
import { activeRelay, type ConnectionStatus } from "../relayConnection";
import { isSignerReady, signEvent } from "../signer";
import type { GroupMeta } from "../types";

function metaFromEvent(ev: NostrEvent): GroupMeta {
  const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1] ?? "";
  return { id: tag("d"), name: tag("name") || tag("d"), about: tag("about"), picture: tag("picture"), raw: ev };
}

async function publish(kind: number, tags: string[][], content: string): Promise<void> {
  const ev = await signEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });
  await activeRelay.publish(ev);
}

/* ---------- グループ一覧 ---------- */

function GroupList({
  myPubkey,
  onOpen,
}: {
  myPubkey: string;
  onOpen: (g: GroupMeta) => void;
}) {
  const [groups, setGroups] = useState<Map<string, GroupMeta>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGroups(new Map());
    const unsub = activeRelay.subscribe([{ kinds: [39000] }], {
      onevent: (ev) => {
        const meta = metaFromEvent(ev);
        if (!meta.id) return;
        setGroups((prev) => {
          const next = new Map(prev);
          next.set(meta.id, meta);
          return next;
        });
      },
    });
    return unsub;
  }, [myPubkey]);

  const createGroup = async () => {
    const name = window.prompt("グループ名");
    if (!name) return;
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    setError(null);
    try {
      await publish(9007, [["h", id]], "");
      await publish(9002, [["h", id], ["name", name]], "");
    } catch (e) {
      setError(String(e));
    }
  };

  const list = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="group-list">
      <div className="group-list-header">
        <h3>グループ</h3>
        <button onClick={createGroup} disabled={!isSignerReady()}>
          ＋ グループを作成
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <ul>
        {list.map((g) => (
          <li key={g.id} onClick={() => onOpen(g)}>
            <strong>{g.name}</strong>
            <code className="muted"> {g.id}</code>
          </li>
        ))}
        {list.length === 0 && <li className="muted">グループがありません</li>}
      </ul>
    </div>
  );
}

/* ---------- チャット画面 ---------- */

function ChatView({
  group,
  myPubkey,
  onBack,
}: {
  group: GroupMeta;
  myPubkey: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Map<string, NostrEvent>>(new Map());
  const [members, setMembers] = useState<string[]>([]);
  const [admins, setAdmins] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isMember = members.includes(myPubkey);
  const isAdmin = admins.includes(myPubkey);

  useEffect(() => {
    setMessages(new Map());
    setMembers([]);
    setAdmins([]);
    const unsubs = [
      activeRelay.subscribe([{ kinds: [9], "#h": [group.id] }], {
        onevent: (ev) =>
          setMessages((prev) => {
            if (prev.has(ev.id)) return prev;
            const next = new Map(prev);
            next.set(ev.id, ev);
            return next;
          }),
      }),
      // 39002/39001 はreplaceable: 最新のみ残す
      (() => {
        let latestMembers = 0;
        let latestAdmins = 0;
        return [
          activeRelay.subscribe([{ kinds: [39002], "#d": [group.id] }], {
            onevent: (ev) => {
              if (ev.created_at < latestMembers) return;
              latestMembers = ev.created_at;
              setMembers(ev.tags.filter((t) => t[0] === "p").map((t) => t[1]));
            },
          }),
          activeRelay.subscribe([{ kinds: [39001], "#d": [group.id] }], {
            onevent: (ev) => {
              if (ev.created_at < latestAdmins) return;
              latestAdmins = ev.created_at;
              setAdmins(ev.tags.filter((t) => t[0] === "p").map((t) => t[1]));
            },
          }),
        ];
      })(),
    ].flat();
    return () => unsubs.forEach((u) => u());
  }, [group.id]);

  const sorted = useMemo(
    () => [...messages.values()].sort((a, b) => a.created_at - b.created_at),
    [messages],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sorted.length]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setError(null);
    try {
      await publish(9, [["h", group.id]], text);
      setInput("");
    } catch (e) {
      setError(String(e));
    }
  };

  const joinRequest = async () => {
    setError(null);
    setNotice(null);
    try {
      await publish(9021, [["h", group.id]], "");
      setNotice("参加リクエストを送信しました。承認されるとメンバーに追加されます。");
    } catch (e) {
      setError(String(e));
    }
  };

  const removeMember = async (pk: string) => {
    if (!window.confirm(`${pk.slice(0, 12)}… をグループから削除しますか?`)) return;
    try {
      await publish(9001, [["h", group.id], ["p", pk]], "");
    } catch (e) {
      setError(String(e));
    }
  };

  const renameGroup = async () => {
    const name = window.prompt("新しいグループ名", group.name);
    if (!name) return;
    try {
      await publish(9002, [["h", group.id], ["name", name]], "");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button onClick={onBack}>← 戻る</button>
        <h3>{group.name}</h3>
        {isAdmin && <button onClick={renameGroup}>名前を変更</button>}
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="chat-body">
        <div className="messages">
          {sorted.map((m) => (
            <div key={m.id} className={`message ${m.pubkey === myPubkey ? "mine" : ""}`}>
              <div className="message-meta">
                <code>{m.pubkey.slice(0, 8)}</code>
                <span>{new Date(m.created_at * 1000).toLocaleTimeString()}</span>
              </div>
              <div className="message-content">{m.content}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="members">
          <h4>メンバー ({members.length})</h4>
          <ul>
            {members.map((pk) => (
              <li key={pk}>
                <code>{pk.slice(0, 12)}…</code>
                {admins.includes(pk) && <span className="badge">admin</span>}
                {isAdmin && pk !== myPubkey && (
                  <button onClick={() => removeMember(pk)}>削除</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="chat-input">
        {isMember ? (
          <>
            <input
              type="text"
              value={input}
              placeholder="メッセージを入力"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              disabled={!isSignerReady()}
            />
            <button onClick={send} disabled={!isSignerReady() || !input.trim()}>
              送信
            </button>
          </>
        ) : (
          <button onClick={joinRequest} disabled={!isSignerReady()}>
            参加リクエストを送る
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- グループエリア全体 ---------- */

export default function GroupArea({
  status,
  statusDetail,
  myPubkey,
}: {
  status: ConnectionStatus;
  statusDetail?: string;
  myPubkey: string | null;
}) {
  const [openGroup, setOpenGroup] = useState<GroupMeta | null>(null);

  // relay切替時に開いているグループを閉じる
  useEffect(() => {
    setOpenGroup(null);
  }, [status]);

  if (status !== "connected") {
    return (
      <div className="group-area placeholder">
        {status === "connecting" && <p>relayに接続中...</p>}
        {status === "error" && <p className="error">接続エラー: {statusDetail}</p>}
        {status === "disconnected" && <p>左の一覧からRelayを選択してください</p>}
      </div>
    );
  }
  if (!myPubkey) {
    return (
      <div className="group-area placeholder">
        <p>上のバーからNIP-46署名機 (bunker) に接続してください</p>
      </div>
    );
  }
  return (
    <div className="group-area">
      {openGroup ? (
        <ChatView group={openGroup} myPubkey={myPubkey} onBack={() => setOpenGroup(null)} />
      ) : (
        <GroupList myPubkey={myPubkey} onOpen={setOpenGroup} />
      )}
    </div>
  );
}
