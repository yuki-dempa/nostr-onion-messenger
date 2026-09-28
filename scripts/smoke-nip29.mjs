// strfry + strfry29 のNIP-29スモークテスト
// 使い方: node scripts/smoke-nip29.mjs [relayUrl] [waitMs]
// onion経由など遅い経路では waitMs を大きくする (例: 10000)
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool, Relay } from "nostr-tools";

const url = process.argv[2] ?? "ws://127.0.0.1:17777";
const WAIT = Number(process.argv[3] ?? 1500);
const pool = new SimplePool();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adminSk = generateSecretKey();
const memberSk = generateSecretKey();
const memberPk = getPublicKey(memberSk);

const GROUP = "smoke-group-" + Math.random().toString(36).slice(2, 8);

function sign(kind, tags, content, sk) {
  return finalizeEvent(
    { kind, created_at: Math.floor(Date.now() / 1000), tags, content },
    sk,
  );
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

/** publishし、OKが間に合わなくても後続のクエリで効果を検証する前提で進める */
async function publishTolerant(relay, ev) {
  try {
    await relay.publish(ev);
    return "ok";
  } catch (e) {
    return String(e);
  }
}

const relay = await Relay.connect(url);

// 1. グループ作成 (kind 9007)
const r1 = await publishTolerant(relay, sign(9007, [["h", GROUP]], "", adminSk));
console.log(`  (kind 9007 publish: ${r1})`);

// 2. relay生成のメタデータ (kind 39000) が出るまで待つ
await sleep(WAIT * 2);
const meta = await pool.querySync([url], { kinds: [39000], "#d": [GROUP] });
check(
  "グループ作成→メタデータ (kind 39000) 自動生成",
  meta.length > 0,
  meta.length ? `pubkey=${meta[0].pubkey.slice(0, 8)}...` : "取得できず",
);

// 3. 非メンバーからのjoin request (kind 9021)
const r2 = await publishTolerant(relay, sign(9021, [["h", GROUP]], "", memberSk));
console.log(`  (kind 9021 publish: ${r2})`);

// 4. メンバーリスト (kind 39002) に自動追加されるか
await sleep(WAIT * 2);
const members = await pool.querySync([url], { kinds: [39002], "#d": [GROUP] });
const joined = members.some((m) => m.tags.some((t) => t[0] === "p" && t[1] === memberPk));
check("join後のメンバーリスト (kind 39002) 反映", joined);

// 5. メンバーのチャット投稿 (kind 9) が保存されるか
const chatEv = sign(9, [["h", GROUP]], "こんにちは、スモークテストです", memberSk);
const r3 = await publishTolerant(relay, chatEv);
console.log(`  (kind 9 publish: ${r3})`);
await sleep(WAIT);
const chats = await pool.querySync([url], { kinds: [9], "#h": [GROUP] });
check(
  "チャット投稿 (kind 9) 保存",
  chats.some((c) => c.id === chatEv.id),
);

// 6. 無関係イベントはwrite policyで拒否されるか (拒否は即座に返るので厳密に判定)
try {
  await relay.publish(sign(1, [], "これは拒否されるべき", adminSk));
  check("通常イベント (kind 1) の拒否", false, "拒否されず受理された");
} catch (e) {
  check("通常イベント (kind 1) の拒否", !String(e).includes("timed out"), String(e));
}

relay.close();
pool.close([url]);
console.log(failures === 0 ? "\n全テスト成功" : `\n${failures}件失敗`);
process.exit(failures === 0 ? 0 : 1);
