// strfry + strfry29 のNIP-29スモークテスト
// 使い方: node scripts/smoke-nip29.mjs [relayUrl]
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool, Relay } from "nostr-tools";

const url = process.argv[2] ?? "ws://127.0.0.1:17777";
const pool = new SimplePool();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adminSk = generateSecretKey();
const adminPk = getPublicKey(adminSk);
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

const relay = await Relay.connect(url);

// 1. グループ作成 (kind 9007)
try {
  await relay.publish(sign(9007, [["h", GROUP]], "", adminSk));
  check("グループ作成 (kind 9007)", true);
} catch (e) {
  check("グループ作成 (kind 9007)", false, String(e));
}

// 2. relay生成のメタデータ (kind 39000) が出るまで待つ
await sleep(1500);
const meta = await pool.querySync([url], { kinds: [39000], "#d": [GROUP] });
check(
  "グループメタデータ (kind 39000) 自動生成",
  meta.length > 0 && meta[0].tags.some((t) => t[0] === "name" || t[0] === "d"),
  meta.length ? `pubkey=${meta[0].pubkey.slice(0, 8)}...` : "取得できず",
);

// 3. 非メンバーからのjoin request (kind 9021)
try {
  await relay.publish(sign(9021, [["h", GROUP]], "", memberSk));
  check("join request (kind 9021)", true);
} catch (e) {
  check("join request (kind 9021)", false, String(e));
}

// 4. メンバーリスト (kind 39002) に自動追加されるか
await sleep(1500);
const members = await pool.querySync([url], { kinds: [39002], "#d": [GROUP] });
const joined = members.some((m) => m.tags.some((t) => t[0] === "p" && t[1] === memberPk));
check("join後のメンバーリスト (kind 39002) 反映", joined);

// 5. メンバーのチャット投稿 (kind 9)
try {
  await relay.publish(
    sign(9, [["h", GROUP]], "こんにちは、スモークテストです", memberSk),
  );
  check("チャット投稿 (kind 9)", true);
} catch (e) {
  check("チャット投稿 (kind 9)", false, String(e));
}

// 6. 無関係イベントはwrite policyで拒否されるか
try {
  await relay.publish(sign(1, [], "これは拒否されるべき", adminSk));
  check("通常イベント (kind 1) の拒否", false, "拒否されず受理された");
} catch {
  check("通常イベント (kind 1) の拒否", true);
}

relay.close();
pool.close([url]);
console.log(failures === 0 ? "\n全テスト成功" : `\n${failures}件失敗`);
process.exit(failures === 0 ? 0 : 1);
