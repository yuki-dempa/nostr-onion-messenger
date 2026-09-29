// HOSTEDモード (マルチテナント) の動作検証
// 前提: HOSTED=1 でサーバーが localhost:8787 で起動していること
//   HOSTED=1 node server/index.mjs
// 使い方: node scripts/test-hosted.mjs
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import WebSocketClient from "ws";

const BASE = "http://localhost:8787";
let failed = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failed++;
};

const auth = async (sk) => {
  const ev = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["u", `${BASE}/api/auth`], ["method", "POST"]],
      content: "",
    },
    sk,
  );
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: ev }),
  });
  return res.json();
};

// 1. server-info
const info = await (await fetch(`${BASE}/api/server-info`)).json();
check("server-info hosted=true", info.hosted === true, JSON.stringify(info));

// 2. 未認証 GET は空配列
const anonList = await (await fetch(`${BASE}/api/relays`)).json();
check("未認証のrelay一覧は空", Array.isArray(anonList) && anonList.length === 0);

// 3. 未認証 POST は 401
const anonCreate = await fetch(`${BASE}/api/relays`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "anon" }),
});
check("未認証の作成は401", anonCreate.status === 401);

// 4. ユーザーA: 認証→作成→一覧
const skA = generateSecretKey();
const pkA = getPublicKey(skA);
const { token: tokA } = await auth(skA);
check("ユーザーA認証", typeof tokA === "string" && tokA.length === 64);
const hA = { Authorization: `Bearer ${tokA}`, "Content-Type": "application/json" };

const createA = await fetch(`${BASE}/api/relays`, { method: "POST", headers: hA, body: JSON.stringify({ name: "relay-A" }) });
const relayA = await createA.json();
check("ユーザーAがrelay作成", createA.status === 200 && !!relayA.id, JSON.stringify(relayA));

const listA = await (await fetch(`${BASE}/api/relays`, { headers: hA })).json();
check("ユーザーAの一覧に1件", listA.length === 1 && listA[0].id === relayA.id);

// 5. ユーザーB: 認証するがAのrelayは見えない・操作できない
const skB = generateSecretKey();
const { token: tokB } = await auth(skB);
const hB = { Authorization: `Bearer ${tokB}`, "Content-Type": "application/json" };
const listB = await (await fetch(`${BASE}/api/relays`, { headers: hB })).json();
check("ユーザーBの一覧は空", listB.length === 0);
const delB = await fetch(`${BASE}/api/relays/${relayA.id}`, { method: "DELETE", headers: hB });
check("ユーザーBはAのrelayを削除不可(403)", delB.status === 403);

// 6. 所有数上限 (MAX_RELAYS_PER_USER 未設定 → デフォルト3)
for (let i = 0; i < 2; i++) {
  await fetch(`${BASE}/api/relays`, { method: "POST", headers: hA, body: JSON.stringify({ name: `relay-A-${i}` }) });
}
const overLimit = await fetch(`${BASE}/api/relays`, { method: "POST", headers: hA, body: JSON.stringify({ name: "relay-A-4" }) });
check("4つ目の作成は403 (上限3)", overLimit.status === 403);

// 7. WSプロキシ: local接続はトークン無しでは拒否、所有者トークンで許可
const wsTest = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocketClient(url);
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("close", (code, reason) => resolve(`close:${reason || code}`));
    ws.on("error", (e) => resolve(`error:${e.message}`));
    setTimeout(() => resolve("timeout"), 8000);
  });

const noTok = await wsTest(`ws://localhost:8787/ws?target=local:${relayA.port}`);
check("WS local トークン無しは拒否", noTok !== "open", noTok);
const withTok = await wsTest(`ws://localhost:8787/ws?target=local:${relayA.port}&token=${tokA}`);
check("WS local 所有者トークンで接続", withTok === "open", withTok);
const otherTok = await wsTest(`ws://localhost:8787/ws?target=local:${relayA.port}&token=${tokB}`);
check("WS local 他人トークンは拒否", otherTok !== "open", otherTok);

// 8. 所有者は削除できる
const delA = await fetch(`${BASE}/api/relays/${relayA.id}`, { method: "DELETE", headers: hA });
check("ユーザーAは自分のrelayを削除可", delA.status === 200);

console.log(failed === 0 ? "\n全テスト通過" : `\n${failed}件失敗`);
process.exit(failed === 0 ? 0 : 1);
