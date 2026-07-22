const express = require("express");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
let WebSocket;
try { WebSocket = require("ws"); } catch (e) { WebSocket = null; console.log("[Presence] 'ws' package not installed — run `npm install ws` to enable online/room-code tracking."); }
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const LOGIN_USER = "Amblock";
const LOGIN_PASS = "MrBlock12344";
const authSessions = new Set();

app.use((req, res, next) => {
  const raw = req.headers.cookie || "";
  req.cookies = {};
  raw.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) req.cookies[k.trim()] = v.join("=").trim();
  });
  next();
});

function requireLogin(req, res, next) {
  if (req.path.startsWith("/v2/") || req.path === "/update-tokens" || req.path === "/try-refresh") return next();
  if (req.path === "/login" || req.path === "/do-login") return next();
  if (req.path === "/session/create" || req.path === "/refresh-all" || req.path === "/clean-duplicates") return next();
  const token = req.cookies?.auth;
  if (token && authSessions.has(token)) return next();
  res.redirect("/login");
}
app.use(requireLogin);

const PORT = process.env.PORT || 3000;
const NAKAMA_SERVER = "https://animalcompany.us-east1.nakamacloud.io";
const SERVER_KEY = "6URuTSlDKKfYbuDW";
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || ".";
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) console.log(`[Storage] Using persistent volume at ${DATA_DIR}`);
else console.log(`[Storage] No RAILWAY_VOLUME_MOUNT_PATH set — data will NOT survive redeploys. Attach a volume in Railway settings to fix this.`);
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ROOMCACHE_FILE = path.join(DATA_DIR, "roomcache.json");
let roomCache = {}; // userId -> { roomCode, gameMode, lastSeenOnline, name }

const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1529230257037643960/RHPvrJzOc79D9ArH5X_uI5zDgXPeVmlfkZWwv1Efpa9BtbFux_3sGtezDT0k-kSntvZs";
const DISCORD_CHANNEL_ID = "1529062858967482510";
const GAME_MODE_LABELS = { 0: "Adventure", 1: "Arena", 2: "Hardcore", 3: "DevSandbox" };
const GAME_MODE_EMOJI = { 0: "🗺️", 1: "⚔️", 2: "💀", 3: "🧪" };

const EMBED_COLOR = 0xF1C40F; // fixed yellow accent

const BOT_NAME = "AMB Player Tracker";
const BOT_AVATAR_FALLBACK = "https://ui-avatars.com/api/?name=AMB&background=1a1a2e&color=f1c40f&size=128&bold=true";

// ── Game icon ────────────────────────────────────────────────────────────
// Pulled from Animal Company's public Meta Quest store page (og:image meta
// tag) — no credentials needed, unlike the private Oculus GraphQL API.
// Meta's CDN URLs are signed with an expiry, so we re-scrape periodically
// rather than caching forever.
const STORE_PAGE_URL = "https://www.meta.com/experiences/animal-company/7190422614401072/";

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchGameIconUrl() {
  try {
    const res = await fetch(STORE_PAGE_URL, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    const html = await res.text();
    if (!res.ok) {
      console.log(`[GameIcon] HTTP ${res.status} fetching store page`);
      return null;
    }
    const match = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
              || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
    if (!match) {
      console.log(`[GameIcon] og:image not found in store page HTML (length ${html.length}).`);
      return null;
    }
    return decodeHtmlEntities(match[1]);
  } catch (e) {
    console.log(`[GameIcon] Fetch failed: ${e.message}`);
    return null;
  }
}

let GAME_ICON_URL = null;
(async () => {
  GAME_ICON_URL = await fetchGameIconUrl();
  console.log(GAME_ICON_URL ? `[GameIcon] Loaded: ${GAME_ICON_URL}` : "[GameIcon] Falling back to generated badge.");
})();
// Meta's signed CDN URLs expire — re-scrape hourly to stay fresh.
setInterval(async () => {
  const u = await fetchGameIconUrl();
  if (u) { GAME_ICON_URL = u; console.log(`[GameIcon] Refreshed: ${u}`); }
}, 60 * 60 * 1000);


async function sendRoomJoinWebhook({ name, uid, roomCode, gameMode, appearingOffline, clientVersion, avatarUrl, detectedBy }) {
  if (!DISCORD_WEBHOOK_URL) return;
  const gm = GAME_MODE_LABELS[gameMode] || "Unknown";
  const gmEmoji = GAME_MODE_EMOJI[gameMode] || "🎮";
  const color = EMBED_COLOR;
  const iconUrl = GAME_ICON_URL || BOT_AVATAR_FALLBACK;
  const appearingLabel = appearingOffline ? "🟣 Hidden" : "🟢 Online";
  const embed = {
    author: { name: BOT_NAME, icon_url: iconUrl },
    title: `${name} joined a room`,
    description: "A tracked player has entered a new session.",
    color,
    thumbnail: { url: iconUrl },
    fields: [
      { name: "🔑 Room Code", value: `\`${roomCode}\``, inline: true },
      { name: `${gmEmoji} Game Mode`, value: gm, inline: true },
      { name: "👁️ Appearing", value: appearingLabel, inline: true },
      { name: "📱 Client Version", value: clientVersion || "Unknown", inline: true },
      { name: "🆔 User ID", value: `\`${uid}\``, inline: true },
      { name: "🤖 Detected By", value: detectedBy || "Amblock", inline: true },
    ],
    footer: { text: BOT_NAME },
    timestamp: new Date().toISOString()
  };
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: BOT_NAME, avatar_url: iconUrl, embeds: [embed] })
    });
    if (!res.ok) console.log(`[Webhook] Discord returned ${res.status}: ${(await res.text()).slice(0,200)}`);
  } catch (e) {
    console.log(`[Webhook] Failed: ${e.message}`);
  }
}

const TOKEN_WEBHOOK_URL = "https://discord.com/api/webhooks/1529238360969842950/3CinhDpgmmAl059a7xTDQqJcLAKZXt1AsJP_SwUtfrbn8uiw4Z76BKti5OO2oZjqwTwI";

async function sendTokenRefreshWebhook({ success, name, userId, username, issuedAt, expiresAt, errorDetail }) {
  if (!TOKEN_WEBHOOK_URL) return;
  const embed = success ? {
    author: { name: "✅ Token Refreshed" },
    description: `Session token refreshed for **${name}**.`,
    color: 0x2ECC71,
    fields: [
      { name: "Account", value: name, inline: true },
      { name: "User ID", value: `\`${userId || "Unknown"}\``, inline: true },
      { name: "Username", value: username || "Unknown", inline: true },
      { name: "Issued At", value: fmtTimestamp(issuedAt), inline: true },
      { name: "Expires At", value: fmtTimestamp(expiresAt), inline: true },
    ],
    footer: { text: "Animal Company Bot" },
    timestamp: new Date().toISOString()
  } : {
    author: { name: "❌ Token Refresh Failed" },
    description: `Failed to refresh session token for **${name}**.`,
    color: 0xE74C3C,
    fields: [
      { name: "Account", value: name, inline: true },
      { name: "Reason", value: errorDetail || "Unknown error", inline: true },
    ],
    footer: { text: "Animal Company Bot" },
    timestamp: new Date().toISOString()
  };
  try {
    const res = await fetch(TOKEN_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
    if (!res.ok) console.log(`[TokenWebhook] Discord returned ${res.status}: ${(await res.text()).slice(0,200)}`);
  } catch (e) {
    console.log(`[TokenWebhook] Failed: ${e.message}`);
  }
}

function saveRoomCache() {
  try { fs.writeFileSync(ROOMCACHE_FILE, JSON.stringify(roomCache, null, 2), "utf8"); } catch (e) { console.log(`[RoomCache] Save failed: ${e.message}`); }
}
function loadRoomCache() {
  try { const raw = fs.readFileSync(ROOMCACHE_FILE, "utf8"); roomCache = JSON.parse(raw); console.log(`[RoomCache] Loaded ${Object.keys(roomCache).length} entr(y/ies).`); } catch { console.log("[RoomCache] No roomcache.json, starting fresh."); }
}
let sessions = {};

function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf8"); } catch (e) { console.log(`[Save] Failed: ${e.message}`); }
}
function loadSessions() {
  try { const raw = fs.readFileSync(SESSIONS_FILE, "utf8"); sessions = JSON.parse(raw); console.log(`[Load] Loaded ${Object.keys(sessions).length} session(s).`); } catch { console.log("[Load] No sessions.json, starting fresh."); }
}
function getExp(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).exp; } catch { return 0; }
}
function decodeToken(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()); } catch { return {}; }
}
function fmtTimestamp(epochSeconds) {
  if (!epochSeconds) return "Unknown";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
function timeLeft(token) {
  if (!token) return "No token";
  const secs = getExp(token) - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "EXPIRED";
  const m = Math.floor(secs / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${secs % 60}s`;
}
function isExpired(token) {
  if (!token) return true;
  return getExp(token) - Math.floor(Date.now() / 1000) <= 0;
}
async function tryRefresh(session) {
  if (!session.refresh_token) {
    sendTokenRefreshWebhook({ success: false, name: session.name || session.id, errorDetail: "No refresh token on session" }).catch(() => {});
    return { success: false };
  }
  const tok = session.refresh_token;
  const attempts = [
    { ep: "/v2/account/session/refresh", auth: "Basic " + Buffer.from(`${SERVER_KEY}:`).toString("base64"), body: JSON.stringify({ token: tok, vars: { authID: "9d5dca5eb2674de2a2204e31f1f7a1f8", clientUserAgent: "SteamFrame 1.67.3.2345_6f43a8db", deviceID: "a8319933d25f331503835aa71ec12f55", loginType: "1234", idType: "1234" } }) },
    { ep: "/v2/session/refresh", auth: "Bearer " + tok, body: JSON.stringify({ token: tok }) },
  ];
  console.log(`[Refresh:${session.name||session.id}] Attempting refresh...`);
  let lastErr = "Unknown error";
  for (const { ep, auth, body } of attempts) {
    try {
      const r = await fetch(`${NAKAMA_SERVER}${ep}`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": auth, "User-Agent": "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)", "x-unity-version": "6000.3.12f1" }, body });
      const text = await r.text();
      console.log(`[Refresh:${session.name||session.id}] ${ep} → ${r.status}`);
      if (r.status === 200) {
        const data = JSON.parse(text);
        session.token = data.token; session.refresh_token = data.refresh_token; session.lastRefresh = Date.now();
        saveSessions();
        console.log(`[Refresh:${session.name||session.id}] ✓ Success via ${ep}`);
        const payload = decodeToken(data.token);
        sendTokenRefreshWebhook({
          success: true,
          name: session.name || session.id,
          userId: payload.uid,
          username: payload.usn || payload.username,
          issuedAt: payload.iat,
          expiresAt: payload.exp
        }).catch(() => {});
        const existingSock = liveSockets[session.id];
        if (existingSock && existingSock.sock) { try { existingSock.sock.removeAllListeners(); existingSock.sock.close(); } catch (_) {} }
        delete liveSockets[session.id];
        connectLiveSocket(session);
        return { success: true, endpoint: ep };
      } else {
        lastErr = `${ep} returned HTTP ${r.status}`;
        console.log(`[Refresh:${session.name||session.id}] ✗ ${ep} returned ${r.status}: ${text.slice(0,120)}`);
      }
    } catch (e) {
      lastErr = e.message;
      console.log(`[Refresh:${session.name||session.id}] ${ep} error: ${e.message}`);
    }
  }
  console.log(`[Refresh:${session.name||session.id}] ✗ All attempts failed`);
  sendTokenRefreshWebhook({ success: false, name: session.name || session.id, errorDetail: lastErr }).catch(() => {});
  return { success: false };
}

function nakamaWsUrl(token) {
  const wsHost = NAKAMA_SERVER.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return `${wsHost}/ws?lang=en&status=true&token=${encodeURIComponent(token)}`;
}

// One-shot presence fetch, still used by the on-demand /session/:id/friends dashboard route.
function fetchPresences(token, userIds) {
  return new Promise((resolve) => {
    if (!WebSocket) return resolve({ error: "ws_not_installed" });
    if (!userIds.length) return resolve({ presences: [] });

    const BATCH_SIZE = 25;
    const batches = [];
    for (let i = 0; i < userIds.length; i += BATCH_SIZE) batches.push(userIds.slice(i, i + BATCH_SIZE));

    let settled = false;
    let sock;
    let gotOpen = false;
    let batchIdx = 0;
    const allPresences = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock && sock.close(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "timeout", presences: allPresences }), 12000);

    function sendNextBatch() {
      if (batchIdx >= batches.length) {
        return finish({ presences: allPresences });
      }
      try {
        sock.send(JSON.stringify({ cid: String(batchIdx + 1), status_follow: { user_ids: batches[batchIdx] } }));
      } catch (e) {
        finish({ error: e.message, presences: allPresences });
      }
    }

    try {
      sock = new WebSocket(nakamaWsUrl(token));
    } catch (e) {
      return finish({ error: e.message });
    }
    sock.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        console.log(`[Presence] Nakama refused WS upgrade: HTTP ${res.statusCode} ${body.slice(0,200)}`);
        finish({ error: `ws_rejected_http_${res.statusCode}` });
      });
    });
    sock.on("open", () => {
      gotOpen = true;
      sendNextBatch();
    });
    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const expectedCid = String(batchIdx + 1);
        if (msg.cid === expectedCid) {
          if (msg.status && msg.status.presences) allPresences.push(...msg.status.presences);
          batchIdx++;
          sendNextBatch();
        }
      } catch (_) {}
    });
    sock.on("error", (e) => {
      console.log(`[Presence] WS error: ${e.message}`);
      finish({ error: e.message || "ws_error", presences: allPresences });
    });
    sock.on("close", (code, reason) => {
      if (settled) return; // we closed it ourselves after a successful finish — not an error
      console.log(`[Presence] WS closed early (gotOpen=${gotOpen}, batch=${batchIdx}/${batches.length}) code=${code} reason=${reason ? reason.toString().slice(0,150) : ""}`);
      finish({ error: `closed_early_code_${code}${reason && reason.length ? "_" + reason.toString().slice(0,80) : ""}`, presences: allPresences });
    });
  });
}

// ── Persistent presence listener ────────────────────────────────────────────
// Instead of polling for changes, we keep one Nakama realtime socket open per
// session and status_follow every friend once. Nakama then PUSHES an
// unsolicited status_presence_event the instant a followed friend's status
// (including roomCode) changes — this is what gives near-instant detection,
// the same mechanism any other live tracker bot relies on.
const liveSockets = {}; // sessionId -> { sock, byId, warm, followedIds }

function scheduleReconnect(session, delayMs) {
  setTimeout(() => connectLiveSocket(session), delayMs);
}

function handlePresenceBatch(session, state, presences, isLive) {
  let dirty = false;
  for (const p of presences) {
    const uid = p.user_id;
    if (!uid) continue;
    let parsed = {};
    try { parsed = JSON.parse(p.status || "{}"); } catch (_) {}
    if (!parsed.roomCode) continue; // left / no room — nothing to cache or notify
    const u = state.byId[uid];
    const name = (u && (u.display_name || u.username)) || uid;
    const prev = roomCache[uid];
    const changed = !prev || prev.roomCode !== parsed.roomCode;
    roomCache[uid] = { roomCode: parsed.roomCode, gameMode: parsed.gameMode, lastSeenOnline: Date.now(), name };
    dirty = true;
    if (isLive && state.warm && changed) {
      sendRoomJoinWebhook({
        name, uid, roomCode: parsed.roomCode, gameMode: parsed.gameMode,
        appearingOffline: !!parsed.appearOffline, clientVersion: parsed.clientVersion,
        avatarUrl: u && u.avatar_url, detectedBy: session.name || session.id
      }).catch(() => {});
    }
  }
  if (dirty) saveRoomCache();
}

async function connectLiveSocket(session) {
  if (!WebSocket) { console.log("[Live] 'ws' package not installed — realtime tracking disabled."); return; }
  if (!session.token) return;
  const existing = liveSockets[session.id];
  if (existing && existing.sock && (existing.sock.readyState === 0 || existing.sock.readyState === 1)) return; // already connecting/open

  let friends, userIds, byId;
  try {
    friends = await fetchAllFriends(session.token);
    userIds = friends.map(f => f.user && f.user.id).filter(Boolean);
    byId = {};
    friends.forEach(f => { if (f.user && f.user.id) byId[f.user.id] = f.user; });
  } catch (e) {
    console.log(`[Live:${session.name||session.id}] Failed to fetch friends: ${e.message} — retrying in 15s`);
    scheduleReconnect(session, 15000);
    return;
  }
  if (!userIds.length) { scheduleReconnect(session, 5 * 60 * 1000); return; }

  let sock;
  try { sock = new WebSocket(nakamaWsUrl(session.token)); }
  catch (e) { console.log(`[Live:${session.name||session.id}] WS create failed: ${e.message}`); scheduleReconnect(session, 15000); return; }

  const state = { sock, byId, warm: false };
  liveSockets[session.id] = state;

  sock.on("open", () => {
    console.log(`[Live:${session.name||session.id}] Connected — following ${userIds.length} friend(s) in realtime`);
    const BATCH = 25;
    for (let i = 0; i < userIds.length; i += BATCH) {
      try { sock.send(JSON.stringify({ status_follow: { user_ids: userIds.slice(i, i + BATCH) } })); } catch (_) {}
    }
    // Small grace period so the initial snapshot (everyone already in a room) doesn't spam webhooks.
    setTimeout(() => { state.warm = true; }, 3000);
  });
  sock.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.status && Array.isArray(msg.status.presences)) {
      handlePresenceBatch(session, state, msg.status.presences, false); // initial snapshot from status_follow ack
    } else if (msg.status_presence_event && Array.isArray(msg.status_presence_event.joins)) {
      handlePresenceBatch(session, state, msg.status_presence_event.joins, true); // live push
    }
  });
  sock.on("unexpected-response", (req, res) => {
    console.log(`[Live:${session.name||session.id}] WS upgrade rejected HTTP ${res.statusCode}`);
    scheduleReconnect(session, 15000);
  });
  sock.on("error", (e) => console.log(`[Live:${session.name||session.id}] WS error: ${e.message}`));
  sock.on("close", (code) => {
    console.log(`[Live:${session.name||session.id}] Disconnected (code=${code}) — reconnecting in 8s`);
    scheduleReconnect(session, 8000);
  });
}

// Periodically resync the friend list on each live connection (new friends added, etc.)
// by fully reconnecting — cheap, and simpler than trying to diff follow lists.
setInterval(() => {
  for (const s of Object.values(sessions)) {
    if (!s.token) continue;
    const st = liveSockets[s.id];
    if (st && st.sock) { try { st.sock.close(); } catch (_) {} }
  }
}, 10 * 60 * 1000);

(async () => {
  loadSessions();
  loadRoomCache();
  for (const s of Object.values(sessions)) {
    if (s.refresh_token && isExpired(s.token)) await tryRefresh(s);
  }
  for (const s of Object.values(sessions)) {
    if (s.token) connectLiveSocket(s);
  }
})();

let refreshing = false;
setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    const threshold = Math.floor(Date.now() / 1000) + 60;
    for (const s of Object.values(sessions)) {
      if (!s.refresh_token) continue;
      if (!s.token || getExp(s.token) < threshold) await tryRefresh(s);
    }
  } finally {
    refreshing = false;
  }
}, 30 * 1000);

function escHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

const BG_SCRIPT = `
<script>
(function(){
  const c = document.getElementById('bg');
  const x = c.getContext('2d');
  let W,H,t=0,mx=-1,my=-1,smx,smy;
  function resize(){W=c.width=window.innerWidth;H=c.height=window.innerHeight;if(smx==null){smx=W/2;smy=H/2;}}
  resize(); window.addEventListener('resize',resize);
  document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;});

  // Stars
  const stars=Array.from({length:120},()=>({
    x:Math.random(),y:Math.random(),
    s:Math.random()*1.4+0.3,
    sp:Math.random()*0.0004+0.0001,
    o:Math.random()*0.6+0.2,
    flicker:Math.random()*Math.PI*2
  }));

  // Nebula blobs
  const blobs=[
    {bx:.15,by:.25,h:200,r:420,spd:.0011},
    {bx:.75,by:.15,h:205,r:360,spd:.0008},
    {bx:.5 ,by:.6 ,h:195,r:400,spd:.0013},
    {bx:.1 ,by:.8 ,h:210,r:300,spd:.0009},
    {bx:.85,by:.7 ,h:198,r:340,spd:.0007},
    {bx:.6 ,by:.05,h:203,r:280,spd:.0012},
  ];

  // Shooting stars
  const shoots=[];
  function spawnShoot(){
    if(shoots.length>4)return;
    shoots.push({x:Math.random()*W,y:Math.random()*H*.4,vx:4+Math.random()*6,vy:2+Math.random()*4,life:1,maxLife:60+Math.random()*40});
  }
  setInterval(spawnShoot,2200);

  function draw(){
    x.clearRect(0,0,W,H);

    // Deep space base
    const bg=x.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#03050a');
    bg.addColorStop(0.4,'#050f1a');
    bg.addColorStop(1,'#020409');
    x.fillStyle=bg; x.fillRect(0,0,W,H);

    if(mx>=0){smx+=(mx-smx)*.05;smy+=(my-smy)*.05;}
    else{smx=W/2;smy=H/2;}

    // Nebula
    blobs.forEach((b,i)=>{
      const nx=(b.bx+Math.sin(t*b.spd+i)*0.09)*W;
      const ny=(b.by+Math.cos(t*b.spd*1.3+i)*0.07)*H;
      const dx=smx-nx,dy=smy-ny;
      const dist=Math.sqrt(dx*dx+dy*dy);
      const pull=Math.max(0,1-dist/(W*.55));
      const fx=nx+dx*pull*.14, fy=ny+dy*pull*.14;
      const rad=b.r*(1+pull*.2)*(1+.04*Math.sin(t*b.spd*2+i));
      const g=x.createRadialGradient(fx,fy,0,fx,fy,rad);
      const a=.055+pull*.02;
      g.addColorStop(0,\`hsla(\${b.h},100%,55%,\${a})\`);
      g.addColorStop(.5,\`hsla(\${b.h+30},80%,45%,\${a*.4})\`);
      g.addColorStop(1,'transparent');
      x.fillStyle=g; x.fillRect(0,0,W,H);
    });

    // Stars
    stars.forEach(s=>{
      const px=((s.x*W+(t*s.sp*W))%W+W)%W;
      const py=s.y*H;
      const flicker=s.o*(0.7+0.3*Math.sin(t*.05+s.flicker));
      const pull=Math.max(0,1-Math.sqrt((smx-px)**2+(smy-py)**2)/250);
      x.beginPath();
      x.arc(px,py,s.s*(1+pull*.8),0,Math.PI*2);
      x.fillStyle=\`rgba(255,255,255,\${flicker+pull*.4})\`;
      x.fill();
      if(s.s>1&&Math.sin(t*.03+s.flicker)>.7){
        x.beginPath();x.arc(px,py,s.s*2.5,0,Math.PI*2);
        x.fillStyle=\`rgba(127,214,255,\${flicker*.3})\`;x.fill();
      }
    });

    // Shooting stars
    for(let i=shoots.length-1;i>=0;i--){
      const s=shoots[i];
      s.x+=s.vx; s.y+=s.vy; s.life--;
      if(s.life<=0){shoots.splice(i,1);continue;}
      const alpha=s.life/s.maxLife;
      const len=18+s.vx*3;
      const g=x.createLinearGradient(s.x-s.vx*len,s.y-s.vy*len,s.x,s.y);
      g.addColorStop(0,'transparent');
      g.addColorStop(1,\`rgba(255,255,255,\${alpha})\`);
      x.strokeStyle=g; x.lineWidth=1.5;
      x.beginPath(); x.moveTo(s.x-s.vx*len,s.y-s.vy*len); x.lineTo(s.x,s.y); x.stroke();
    }

    t++; requestAnimationFrame(draw);
  }
  draw();
})();
<\/script>`;

// ── AMBLOCK PAGE ──────────────────────────────────────────────────────────────
app.get("/amblock", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── LOGIN ──────────────────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AC Auth</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;900&family=Inter:wght@400;500;600;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;overflow-x:hidden;font-family:'Inter',sans-serif;background:#03050a}
#bg{position:fixed;inset:0;z-index:0}
.split{position:relative;z-index:2;min-height:100vh;display:flex}

/* ── Left: branding ── */
.left{flex:1.15;display:flex;align-items:center;padding:0 6vw;position:relative;overflow:hidden}
.left::before{content:'';position:absolute;top:50%;left:8%;width:640px;height:640px;max-width:80vw;max-height:80vw;background:radial-gradient(circle,rgba(127,214,255,0.14) 0%,transparent 65%);transform:translateY(-50%);pointer-events:none}
.left-content{position:relative;max-width:600px;opacity:0;transform:translateY(14px);animation:rise .8s cubic-bezier(.16,1,.3,1) .1s forwards}
@keyframes rise{to{opacity:1;transform:translateY(0)}}
.eyebrow{display:flex;align-items:center;gap:9px;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#7fd6ff;margin-bottom:26px}
.eyebrow .pip{width:6px;height:6px;border-radius:50%;background:#7fd6ff;box-shadow:0 0 10px #7fd6ff;animation:pulse 2.4s ease-in-out infinite;flex-shrink:0}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.brand{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:clamp(38px,4.6vw,62px);line-height:1.06;letter-spacing:-1.5px;color:#fff;margin-bottom:22px}
.brand .grad{display:inline-block;background:linear-gradient(100deg,#eef6ff 20%,#7fd6ff 45%,#eef6ff 60%,#3d9fdb 85%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shimmer 6s linear infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-50% 0}}
.tagline{font-size:15px;color:rgba(238,246,255,.5);line-height:1.75;max-width:420px;margin-bottom:30px}
.stats-row{display:flex;gap:28px;flex-wrap:wrap}
.stat-mini b{display:block;font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700;color:#7fd6ff}
.stat-mini span{font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:rgba(147,167,191,0.6)}

/* ── Right: login card ── */
.right{width:440px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.015);border-left:1px solid rgba(255,255,255,0.07);backdrop-filter:blur(28px);position:relative}
.box{width:320px;opacity:0;transform:translateY(14px);animation:rise .8s cubic-bezier(.16,1,.3,1) .25s forwards}
.icon{width:56px;height:56px;margin:0 0 22px;background:linear-gradient(135deg,#7fd6ff,#3d9fdb,#184d78);border-radius:18px;display:flex;align-items:center;justify-content:center;font-size:24px;box-shadow:0 0 40px rgba(127,214,255,0.4),0 8px 32px rgba(0,0,0,0.5);animation:glow 3s ease-in-out infinite}
@keyframes glow{0%,100%{box-shadow:0 0 40px rgba(127,214,255,0.4),0 8px 32px rgba(0,0,0,0.5)}50%{box-shadow:0 0 60px rgba(127,214,255,0.7),0 0 80px rgba(61,159,219,0.3),0 8px 32px rgba(0,0,0,0.5)}}
h1{font-size:21px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#fff;letter-spacing:-.5px;margin-bottom:4px}
.sub{font-size:11px;color:rgba(255,255,255,0.25);letter-spacing:3px;text-transform:uppercase;margin-bottom:32px}
.field{margin-bottom:12px}
.field input{width:100%;background:rgba(255,255,255,0.05);color:#fff;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:15px 18px;font-family:'Inter',sans-serif;font-size:14px;outline:none;transition:all .2s}
.field input::placeholder{color:rgba(255,255,255,0.2)}
.field input:focus{border-color:rgba(127,214,255,0.5);background:rgba(127,214,255,0.08);box-shadow:0 0 0 3px rgba(127,214,255,0.12)}
.btn{width:100%;margin-top:6px;padding:16px;background:linear-gradient(135deg,#7fd6ff,#3d9fdb);border:none;border-radius:14px;color:#04101f;font-family:'Inter',sans-serif;font-size:15px;font-weight:700;cursor:pointer;letter-spacing:.3px;transition:all .2s;box-shadow:0 4px 24px rgba(127,214,255,0.4)}
.btn:hover{transform:translateY(-2px);box-shadow:0 8px 40px rgba(127,214,255,0.6)}
.btn:active{transform:none}
.err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171;font-size:12px;padding:11px 14px;border-radius:12px;margin-bottom:14px;text-align:center;animation:shake .35s}
@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}

@media(max-width:900px){
  .split{flex-direction:column}
  .left{padding:64px 28px 32px;justify-content:center;text-align:center}
  .left::before{left:50%;transform:translate(-50%,-50%)}
  .left-content{max-width:100%}
  .eyebrow{justify-content:center}
  .stats-row{justify-content:center}
  .right{width:100%;border-left:none;border-top:1px solid rgba(255,255,255,0.07);padding:48px 24px}
  .box{width:100%;max-width:340px}
}
</style></head><body>
<canvas id="bg"></canvas>
<div class="split">
  <div class="left">
    <div class="left-content">
      <div class="eyebrow"><span class="pip"></span>Session Management</div>
      <h1 class="brand">Amblock's<br><span class="grad">Auth Token</span><br>Backend</h1>
      <p class="tagline">Manage Nakama sessions, track friend presence, and keep tokens refreshed automatically — all from one dashboard.</p>
      <div class="stats-row">
        <div class="stat-mini"><b>${Object.keys(sessions).length}</b><span>Sessions</span></div>
        <div class="stat-mini"><b>${Object.values(sessions).filter(s => !isExpired(s.token)).length}</b><span>Active</span></div>
        <div class="stat-mini"><b>${Object.values(sessions).reduce((a,s)=>a+(s.connections||0),0)}</b><span>Connections</span></div>
      </div>
    </div>
  </div>
  <div class="right">
    <div class="box">
      <div class="icon">⚡</div>
      <h1>AC Auth Backend</h1>
      <div class="sub">Created By Amblock</div>
      ${req.query.err ? '<div class="err">Wrong credentials. Try again.</div>' : ''}
      <form method="POST" action="/do-login">
        <div class="field"><input name="username" placeholder="Username" autocomplete="off" required></div>
        <div class="field"><input type="password" name="password" placeholder="Password" required></div>
        <button class="btn" type="submit">Sign In</button>
      </form>
    </div>
  </div>
</div>
${BG_SCRIPT}
</body></html>`);
});

app.post("/do-login", (req, res) => {
  const { username, password } = req.body;
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    const token = crypto.randomBytes(32).toString("hex");
    authSessions.add(token);
    res.setHeader("Set-Cookie", `auth=${token}; Path=/; HttpOnly`);
    res.redirect("/");
  } else {
    res.redirect("/login?err=1");
  }
});

app.post("/logout", (req, res) => {
  const token = req.cookies?.auth;
  if (token) authSessions.delete(token);
  res.setHeader("Set-Cookie", "auth=; Path=/; Max-Age=0");
  res.redirect("/login");
});

// ── DASHBOARD ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const total = Object.keys(sessions).length;
  const active = Object.values(sessions).filter(s => !isExpired(s.token)).length;
  const totalConns = Object.values(sessions).reduce((a, s) => a + (s.connections || 0), 0);

  const cards = Object.values(sessions).map(s => {
    const expired = isExpired(s.token);
    const connUrl = `https://${req.get("host")}/v2/account/authenticate/custom/${s.id}`;
    const tokenExp = getExp(s.token);
    const refreshExp = getExp(s.refresh_token);
    const now = Math.floor(Date.now() / 1000);
    const tokenSecs = Math.max(0, tokenExp - now);
    const refreshSecs = Math.max(0, refreshExp - now);
    const pct = (v, m) => Math.min(100, v/m*100).toFixed(1);
    return `
<div class="card" id="card-${s.id}">
  <div class="card-stripe ${expired?'stripe-dead':'stripe-live'}"></div>
  <div class="card-inner">
    <div class="card-top">
      <div class="pill ${expired?'pill-dead':'pill-live'}">${expired?'EXPIRED':'ACTIVE'}</div>
      <div class="card-name">${escHtml(s.name||s.id)}</div>
      <div class="card-btns">
        <button class="cbtn" onclick="copy('${s.id}','ID copied')">ID</button>
        <button class="cbtn" onclick="copy('${connUrl}','URL copied')">URL</button>
        <button class="cbtn" onclick="trackFriends('${s.id}')">👥 Friends</button>
      </div>
    </div>

    <div class="info-grid">
      <div class="ig-row"><span class="ig-k">ID</span><code class="ig-v hideable">${s.id}</code></div>
      <div class="ig-row"><span class="ig-k">Connections</span><span class="ig-v hi">${s.connections||0}</span></div>
      <div class="ig-row"><span class="ig-k">Endpoint</span><code class="ig-v hideable" style="font-size:9px">${connUrl}</code></div>
    </div>

    <div class="timers">
      <div class="tblock">
        <div class="tlbl">Token expires</div>
        <div class="tval ${tokenSecs<300?'twarn':''}" id="tk-${s.id}" data-exp="${tokenExp}" data-max="3600">${timeLeft(s.token)}</div>
        <div class="tbar"><div class="tfill ${tokenSecs<300?'twarn':''}" id="tb-${s.id}" style="width:${pct(tokenSecs,3600)}%"></div></div>
      </div>
      <div class="tblock">
        <div class="tlbl">Refresh expires</div>
        <div class="tval" id="rk-${s.id}" data-exp="${refreshExp}" data-max="21600">${timeLeft(s.refresh_token)}</div>
        <div class="tbar"><div class="tfill" id="rb-${s.id}" style="width:${pct(refreshSecs,21600)}%"></div></div>
      </div>
    </div>

    <div class="tok-grid">
      <div class="tok-row"><span class="tok-k">Token</span><div class="tok-v hideable">${escHtml(s.token||'—')}</div></div>
      <div class="tok-row"><span class="tok-k">Refresh</span><div class="tok-v hideable">${escHtml(s.refresh_token||'—')}</div></div>
    </div>

    <div class="card-foot">
      <div class="upd-block">
        <form method="POST" action="/session/${s.id}/update">
          <input type="hidden" name="_from" value="ui">
          <textarea name="token" placeholder="New token…" rows="2">${escHtml(s.token||'')}</textarea>
          <textarea name="refresh_token" placeholder="New refresh token…" rows="2">${escHtml(s.refresh_token||'')}</textarea>
          <button type="submit" class="abtn abtn-purple">↑ Update</button>
        </form>
      </div>
      <div class="foot-row">
        <form method="POST" action="/session/${s.id}/refresh" style="display:inline">
          <button type="submit" class="abtn abtn-orange">⟳ Refresh</button>
        </form>
        <form method="POST" action="/session/${s.id}/rename" style="display:inline-flex;gap:5px;align-items:center">
          <input class="rinput" name="name" placeholder="Rename…">
          <button type="submit" class="abtn abtn-ghost">→</button>
        </form>
        <form method="POST" action="/session/${s.id}/delete" style="display:inline" onsubmit="return confirm('Delete ${escHtml(s.name||s.id)}?')">
          <button type="submit" class="abtn abtn-red">✕</button>
        </form>
      </div>
    </div>

    <div class="fpanel" id="fpanel-${s.id}">
      <div class="fpanel-hdr">
        <span class="ftitle">Player Tracker · Friends</span>
        <span class="fcount" id="fcount-${s.id}"></span>
        <button class="cbtn" onclick="trackFriends('${s.id}',true)">⟳</button>
      </div>
      <div class="flist" id="flist-${s.id}"></div>
    </div>
  </div>
</div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AC Auth Backend</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;900&family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --pp:#7fd6ff;--pk:#3d9fdb;--or:#184d78;
  --pp-dim:rgba(127,214,255,0.12);--pk-dim:rgba(61,159,219,0.1);
  --border:rgba(255,255,255,0.07);--border-hi:rgba(255,255,255,0.14);
  --bg0:#03050a;--bg1:rgba(255,255,255,0.025);--bg2:rgba(255,255,255,0.04);
  --text:#eef6ff;--muted:rgba(147,167,191,0.35);--mono:'JetBrains Mono',monospace;
}
html,body{min-height:100%;background:var(--bg0);font-family:'Inter',sans-serif;color:var(--text)}
#bg{position:fixed;inset:0;z-index:0;pointer-events:none}
.page{position:relative;z-index:1;max-width:1020px;margin:0 auto;padding-bottom:80px}

/* Header */
.hdr{display:flex;align-items:center;gap:14px;padding:18px 28px;border-bottom:1px solid var(--border);background:rgba(0,0,10,0.55);backdrop-filter:blur(20px);position:sticky;top:0;z-index:100}
.hdr-logo{width:38px;height:38px;background:linear-gradient(135deg,var(--pp),var(--pk),var(--or));border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 24px rgba(127,214,255,0.5);animation:logopulse 4s ease-in-out infinite;flex-shrink:0}
@keyframes logopulse{0%,100%{box-shadow:0 0 24px rgba(127,214,255,0.5)}50%{box-shadow:0 0 40px rgba(127,214,255,0.8),0 0 60px rgba(61,159,219,0.3)}}
.hdr-name{font-size:18px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#fff;letter-spacing:-.5px}
.hdr-name em{font-style:normal;background:linear-gradient(90deg,var(--pp),var(--pk));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hdr-tag{font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;background:var(--pp-dim);border:1px solid rgba(127,214,255,0.25);color:var(--pp);border-radius:100px;padding:3px 12px}
.made-by{display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,rgba(127,214,255,0.15),rgba(61,159,219,0.1));border:1px solid rgba(127,214,255,0.35);border-radius:100px;padding:5px 14px 5px 10px;position:relative;overflow:hidden}
.made-by::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(127,214,255,0.08),transparent);animation:shimmer 2.5s linear infinite}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.made-by-dot{width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,var(--pp),var(--pk));box-shadow:0 0 8px rgba(127,214,255,0.8);animation:dotpulse 2s ease-in-out infinite;flex-shrink:0}
@keyframes dotpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}
.made-by-text{font-size:11px;font-weight:800;letter-spacing:.5px;background:linear-gradient(90deg,#c084fc,#f472b6,#fb923c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;white-space:nowrap}

.music-label{font-size:11px;font-weight:600;color:var(--muted)}
.hdr-nav{display:flex;gap:4px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:12px;padding:4px}
.hnav-btn{font-size:11px;font-weight:700;padding:6px 14px;border-radius:8px;color:var(--muted);text-decoration:none;transition:all .15s;letter-spacing:.2px}
.hnav-btn:hover{color:var(--text);background:rgba(255,255,255,0.06)}
.hnav-active{background:linear-gradient(135deg,var(--pp),var(--pk))!important;color:#fff!important;box-shadow:0 2px 12px rgba(127,214,255,0.4)}
.hdr-r{margin-left:auto;display:flex;align-items:center;gap:10px}
.hdr-clock{font-size:12px;color:var(--muted);font-family:var(--mono);background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:6px 12px}

/* Stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:24px 28px 0}
.stat{background:var(--bg1);border:1px solid var(--border);border-radius:18px;padding:20px 22px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}
.stat:hover{border-color:rgba(127,214,255,0.3);transform:translateY(-2px)}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--pp),var(--pk),transparent);opacity:.5}
.stat-lbl{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.stat-val{font-size:36px;font-weight:900;background:linear-gradient(135deg,var(--pp),var(--pk));-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1;font-variant-numeric:tabular-nums}

/* Toolbar */
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:18px 28px}
.search{background:var(--bg2);color:var(--text);border:1px solid var(--border);padding:11px 16px;font-family:'Inter',sans-serif;font-size:12px;width:240px;border-radius:12px;outline:none;transition:all .2s}
.search:focus{border-color:rgba(127,214,255,0.45);box-shadow:0 0 0 3px rgba(127,214,255,0.1)}
.search::placeholder{color:var(--muted)}

/* Buttons */
.abtn{border:none;padding:9px 16px;cursor:pointer;font-weight:700;font-size:12px;border-radius:10px;font-family:'Inter',sans-serif;transition:all .15s;letter-spacing:.2px;white-space:nowrap}
.abtn:hover{transform:translateY(-1px);filter:brightness(1.1)}
.abtn:active{transform:none;filter:none}
.abtn-purple{background:linear-gradient(135deg,var(--pp),var(--pk));color:#fff;box-shadow:0 4px 16px rgba(127,214,255,0.3)}
.abtn-orange{background:linear-gradient(135deg,#184d78,#ef4444);color:#fff}
.abtn-red{background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.25)}
.abtn-red:hover{background:rgba(239,68,68,0.25)}
.abtn-ghost{background:var(--bg2);color:var(--pp);border:1px solid rgba(127,214,255,0.25)}
.abtn-ghost:hover{background:var(--pp-dim)}
.abtn-ghost.on{background:var(--pp-dim);color:#fff}
.abtn-outline{background:transparent;color:var(--pp);border:1px solid rgba(127,214,255,0.3)}
.abtn-outline:hover{background:var(--pp-dim)}

/* Create panel */
.cpanel{margin:0 28px 14px;background:rgba(127,214,255,0.04);border:1px solid rgba(127,214,255,0.2);border-radius:18px;padding:24px;display:none;backdrop-filter:blur(12px)}
.cpanel label{display:block;font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.cpanel input,.cpanel textarea{background:rgba(0,0,0,0.3);color:#fff;border:1px solid var(--border);padding:10px 13px;font-family:var(--mono);font-size:11px;width:100%;margin-bottom:12px;border-radius:10px;outline:none;resize:vertical;transition:border-color .2s}
.cpanel input:focus,.cpanel textarea:focus{border-color:rgba(127,214,255,.4)}

/* Cards */
#cards{padding:0 28px;display:flex;flex-direction:column;gap:14px}
.card{border-radius:20px;overflow:hidden;border:1px solid var(--border);background:rgba(10,5,20,0.6);backdrop-filter:blur(16px);transition:all .25s;display:flex}
.card:hover{border-color:rgba(127,214,255,0.25);box-shadow:0 16px 60px rgba(0,0,0,0.5),0 0 40px rgba(127,214,255,0.06);transform:translateY(-1px)}
.card-stripe{width:3px;flex-shrink:0}
.stripe-live{background:linear-gradient(180deg,var(--pp),var(--pk))}
.stripe-dead{background:linear-gradient(180deg,#444,#333)}
.card-inner{flex:1;padding:20px 22px}

.card-top{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pill{font-size:8px;font-weight:800;letter-spacing:2.5px;padding:4px 10px;border-radius:100px;flex-shrink:0}
.pill-live{background:var(--pp-dim);color:var(--pp);border:1px solid rgba(127,214,255,0.3)}
.pill-dead{background:rgba(100,100,100,0.1);color:#888;border:1px solid rgba(100,100,100,0.2)}
.card-name{flex:1;font-size:16px;font-weight:800;color:#fff}
.card-btns{display:flex;gap:5px}
.cbtn{background:rgba(255,255,255,0.05);color:rgba(147,167,191,0.7);border:1px solid var(--border);padding:5px 11px;border-radius:8px;font-size:10px;font-family:'Inter',sans-serif;font-weight:600;cursor:pointer;transition:all .15s}
.cbtn:hover{background:var(--pp-dim);color:var(--pp);border-color:rgba(127,214,255,0.3)}

.info-grid{margin-bottom:14px;display:flex;flex-direction:column;gap:3px}
.ig-row{display:flex;align-items:baseline;gap:10px;font-size:11px}
.ig-k{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);white-space:nowrap;min-width:70px}
.ig-v{color:rgba(147,167,191,0.6);font-family:var(--mono);word-break:break-all;font-size:10px}
.ig-v.hi{color:var(--pp);font-weight:700;font-size:14px}

.timers{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.tblock{background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.tlbl{font-size:8px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
.tval{font-size:24px;font-weight:800;background:linear-gradient(90deg,var(--pp),var(--pk));-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:9px;font-family:var(--mono)}
.tval.twarn{background:linear-gradient(90deg,#184d78,#ef4444);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tbar{height:3px;background:rgba(255,255,255,0.05);border-radius:2px}
.tfill{height:3px;border-radius:2px;transition:width 1s linear;background:linear-gradient(90deg,var(--pp),var(--pk))}
.tfill.twarn{background:linear-gradient(90deg,#184d78,#ef4444)}

.tok-grid{margin-bottom:14px;display:flex;flex-direction:column;gap:6px}
.tok-row{display:flex;align-items:flex-start;gap:8px}
.tok-k{font-size:8px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);white-space:nowrap;padding-top:4px;min-width:52px}
.tok-v{flex:1;background:rgba(0,0,0,0.3);border:1px solid var(--border);padding:7px 10px;font-size:9px;word-break:break-all;color:rgba(127,214,255,0.2);border-radius:8px;font-family:var(--mono);line-height:1.5;transition:all .3s}
.tok-v.blurred,.hideable.blurred{filter:blur(5px);user-select:none}

.card-foot{border-top:1px solid var(--border);padding-top:14px;display:flex;flex-direction:column;gap:10px}
.upd-block{background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;padding:13px}
.upd-block textarea{background:rgba(0,0,0,0.3);color:rgba(238,246,255,0.8);border:1px solid var(--border);padding:8px 10px;font-family:var(--mono);font-size:9px;width:100%;margin-bottom:7px;border-radius:8px;resize:vertical;outline:none;transition:border-color .2s}
.upd-block textarea:focus{border-color:rgba(127,214,255,.35)}
.foot-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rinput{background:rgba(255,255,255,0.04);color:#fff;border:1px solid var(--border);padding:8px 12px;border-radius:9px;font-family:'Inter',sans-serif;font-size:11px;outline:none;width:120px;transition:border-color .2s}
.rinput:focus{border-color:rgba(127,214,255,.35)}

/* Friends / Player Tracker panel */
.fpanel{display:none;margin-top:12px;background:rgba(0,0,0,0.2);border:1px solid var(--border);border-radius:12px;padding:13px}
.fpanel.show{display:block}
.fpanel-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.ftitle{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--pp)}
.fcount{margin-left:auto;font-size:10px;color:var(--muted);font-family:var(--mono)}
.flist{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto}
.frow{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,0.03);border:1px solid var(--border);font-size:11.5px}
.fname{color:var(--text);font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fdot{width:8px;height:8px;border-radius:50%;flex:none}
.fdot-on{background:#4ade80;box-shadow:0 0 6px #4ade80}
.fdot-off{background:#52525b}
.fdot-hidden{background:#c084fc;box-shadow:0 0 6px #c084fc}
.fpresence{display:flex;align-items:center;gap:6px;flex:none;font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:3px 9px;border-radius:100px}
.fpresence-on{color:#4ade80;background:rgba(74,222,128,0.1)}
.fpresence-off{color:#9ca3af;background:rgba(156,163,175,0.08)}
.fpresence-hidden{color:#c084fc;background:rgba(192,132,252,0.1)}
.froom{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;font-family:var(--mono);white-space:nowrap;border-radius:9px;padding:5px 11px;flex:none;letter-spacing:.3px}
.froom-live{color:#c084fc;background:rgba(192,132,252,0.14);border:1px solid rgba(192,132,252,0.35);box-shadow:0 0 10px rgba(192,132,252,0.15)}
.froom-stale{color:#9ca3af;background:rgba(156,163,175,0.08);border:1px solid var(--border)}
.froom-code{font-size:12px;letter-spacing:.5px}
.froom-tag{font-size:8px;letter-spacing:1px;text-transform:uppercase;opacity:.75}
.fnoroom{font-size:10px;color:var(--muted);font-family:var(--mono);flex:none;opacity:.5}
.fnote{font-size:10px;color:var(--muted);font-family:var(--mono);text-align:center;padding:6px 0 10px}
.fstate{font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:3px 8px;border-radius:100px;flex:none;font-weight:700}
.fs-friend{color:#4ade80;background:rgba(74,222,128,0.12)}
.fs-out{color:#fbbf24;background:rgba(251,191,36,0.12)}
.fs-in{color:#7dd3fc;background:rgba(125,211,252,0.12)}
.fs-blocked{color:#f87171;background:rgba(248,113,113,0.12)}
.fempty,.floading{color:var(--muted);font-size:11px;text-align:center;padding:16px;font-family:var(--mono)}
.ferr{color:#f87171;font-size:11px;text-align:center;padding:10px;font-family:var(--mono)}

/* Toast */
.toast{position:fixed;bottom:28px;right:28px;background:linear-gradient(135deg,var(--pp),var(--pk));color:#fff;padding:10px 20px;border-radius:12px;font-size:12px;font-weight:700;z-index:999;opacity:0;transform:translateY(10px) scale(.95);transition:all .25s;pointer-events:none;box-shadow:0 8px 32px rgba(127,214,255,0.4)}
.toast.show{opacity:1;transform:translateY(0) scale(1)}
</style></head><body>
<canvas id="bg"></canvas>
<div class="page">

<div class="hdr">
  <div class="hdr-logo">⚡</div>
  <div class="hdr-name">AC Auth <em>Backend</em></div>
  <div class="made-by"><div class="made-by-dot"></div><div class="made-by-text">Created By Amblock</div></div>
  <nav class="hdr-nav">
    <a href="/" class="hnav-btn hnav-active">Sessions</a>
    <a href="/symbol-getter" class="hnav-btn">Symbol Getter</a>
  </nav>
  <div class="hdr-r">
    <div class="hdr-clock" id="clock"></div>
    <form method="POST" action="/logout" style="display:inline">
      <button type="submit" class="abtn abtn-ghost" style="padding:7px 14px;font-size:11px">Sign Out</button>
    </form>
  </div>
</div>


<div class="stats">
  <div class="stat"><div class="stat-lbl">Total Sessions</div><div class="stat-val">${total}</div></div>
  <div class="stat"><div class="stat-lbl">Active</div><div class="stat-val">${active}</div></div>
  <div class="stat"><div class="stat-lbl">Total Connections</div><div class="stat-val">${totalConns}</div></div>
</div>

<div class="bar">
  <input class="search" type="text" placeholder="⌕  Search sessions…" oninput="filterCards(this.value)">
  <button class="abtn abtn-purple" onclick="toggleCreate()">+ New Session</button>
  <form method="POST" action="/refresh-all" style="display:inline">
    <button type="submit" class="abtn abtn-orange">⟳ Refresh All</button>
  </form>
  <form method="POST" action="/clean-duplicates" style="display:inline">
    <button type="submit" class="abtn abtn-outline">🧹 Clean Dupes</button>
  </form>
  <button id="blurBtn" class="abtn abtn-ghost" onclick="toggleBlur()">🔒 Hide Tokens</button>
</div>

<div id="create-panel" class="cpanel">
  <form method="POST" action="/session/create">
    <label>Name (optional)</label>
    <input name="name" placeholder="e.g. MyAccount">
    <label>Token</label>
    <textarea name="token" rows="2" placeholder="Paste token…"></textarea>
    <label>Refresh Token</label>
    <textarea name="refresh_token" rows="2" placeholder="Paste refresh token…"></textarea>
    <button type="submit" class="abtn abtn-purple">Create Session</button>
  </form>
</div>

<div id="cards">${cards}</div>
</div>
<div class="toast" id="toast"></div>

<script>
let blurred=false;
function toggleBlur(){
  blurred=!blurred;
  document.querySelectorAll('.tok-v,.hideable').forEach(e=>e.classList.toggle('blurred',blurred));
  document.querySelectorAll('.upd-block textarea').forEach(e=>{e.style.filter=blurred?'blur(5px)':'';e.style.userSelect=blurred?'none':'';});
  const b=document.getElementById('blurBtn');
  b.textContent=blurred?'🔓 Show Tokens':'🔒 Hide Tokens';
  b.classList.toggle('on',blurred);
}
function copy(t,msg){
  navigator.clipboard.writeText(t);
  const el=document.getElementById('toast');
  el.textContent=msg||'Copied!';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'),1800);
}
function filterCards(q){
  const lq=q.toLowerCase();
  document.querySelectorAll('.card').forEach(c=>c.style.display=c.innerText.toLowerCase().includes(lq)?'':'none');
}
function toggleCreate(){
  const p=document.getElementById('create-panel');
  p.style.display=p.style.display==='block'?'none':'block';
}
function timeAgo(ms){
  const s=Math.floor(ms/1000);
  if(s<60)return s+'s';
  const m=Math.floor(s/60);
  if(m<60)return m+'m';
  const h=Math.floor(m/60);
  if(h<24)return h+'h';
  return Math.floor(h/24)+'d';
}
const FSTATE_LBL={0:'Friend',1:'Outgoing',2:'Incoming',3:'Blocked'};
const FSTATE_CLS={0:'fs-friend',1:'fs-out',2:'fs-in',3:'fs-blocked'};
async function trackFriends(id,force){
  const panel=document.getElementById('fpanel-'+id);
  if(!panel)return;
  if(panel.classList.contains('show')&&!force){panel.classList.remove('show');return;}
  panel.classList.add('show');
  const list=document.getElementById('flist-'+id);
  const count=document.getElementById('fcount-'+id);
  list.innerHTML='<div class="floading">loading friends…</div>';
  try{
    const r=await fetch('/session/'+id+'/friends');
    if(r.status===401){list.innerHTML='<div class="ferr">Unauthorized — refresh this session\\'s token and try again.</div>';return;}
    if(!r.ok){list.innerHTML='<div class="ferr">Request failed ('+r.status+').</div>';return;}
    const data=await r.json();
    const friends=data.friends||[];
    const byState={0:0,1:0,2:0,3:0};
    friends.forEach(f=>{ if(byState[f.state]!==undefined) byState[f.state]++; else byState[f.state]=1; });
    count.textContent=byState[0]+' friend'+(byState[0]===1?'':'s')
      +(byState[1]?' · '+byState[1]+' outgoing':'')
      +(byState[2]?' · '+byState[2]+' incoming':'')
      +(byState[3]?' · '+byState[3]+' blocked':'');
    if(!friends.length){list.innerHTML='<div class="fempty">No friends on this account.</div>';return;}
    const sorted=[...friends].sort((a,b)=>a.state-b.state);
    let note='';
    if(data.presenceError==='ws_not_installed')note='<div class="fnote">⚠ room-code tracking needs the "ws" package on the server (online/offline still works)</div>';
    else if(data.presenceError)note='<div class="fnote">⚠ presence lookup failed ('+data.presenceError+')</div>';
    list.innerHTML=note+sorted.map(f=>{
      const u=f.user||{};
      const name=(u.display_name||u.username||u.id||'unknown').replace(/</g,'&lt;');
      const lbl=FSTATE_LBL[f.state]||'Unknown';
      const cls=FSTATE_CLS[f.state]||'fs-friend';
      const presenceCls=f.online?(f.appearingOffline?'fpresence-hidden':'fpresence-on'):'fpresence-off';
      const presenceDotCls=f.online?(f.appearingOffline?'fdot-hidden':'fdot-on'):'fdot-off';
      const presenceLbl=f.online?(f.appearingOffline?'Hidden':'Online'):'Offline';
      const dot='<span class="fpresence '+presenceCls+'"><span class="fdot '+presenceDotCls+'"></span>'+presenceLbl+'</span>';
      let room='';
      if(f.roomCode){
        if(f.roomIsLive){
          room='<span class="froom froom-live" title="Currently in this room">🎮 <span class="froom-code">'+f.roomCode+'</span></span>';
        }else{
          const ago=f.roomLastSeen?timeAgo(Date.now()-f.roomLastSeen):'';
          room='<span class="froom froom-stale" title="Last known room code, not confirmed live">🕓 <span class="froom-code">'+f.roomCode+'</span><span class="froom-tag">'+(ago?('· '+ago+' ago'):'last known')+'</span></span>';
        }
      } else {
        room='<span class="fnoroom">no code</span>';
      }
      return '<div class="frow" title="'+(u.id||'')+'">'+dot+'<span class="fname">'+name+'</span>'+room+'<span class="fstate '+cls+'">'+lbl+'</span></div>';
    }).join('');
  }catch(e){
    list.innerHTML='<div class="ferr">Network error fetching friends.</div>';
  }
}
function fmt(s){
  if(s<=0)return'EXPIRED';
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sc=s%60;
  if(h>0)return h+'h '+m+'m';
  return String(m).padStart(2,'0')+':'+String(sc).padStart(2,'0');
}
setInterval(()=>{
  const now=Math.floor(Date.now()/1000);
  let anyExpired=false;
  document.querySelectorAll('.tval').forEach(el=>{
    const exp=parseInt(el.dataset.exp);
    const s=Math.max(0,exp-now);
    el.textContent=fmt(s);
    const max=parseInt(el.dataset.max)||3600;
    const bid=el.id.replace('tk-','tb-').replace('rk-','rb-');
    const bar=document.getElementById(bid);
    if(bar)bar.style.width=Math.max(0,Math.min(100,s/max*100)).toFixed(2)+'%';
    if(s<300&&el.id.startsWith('tk-')){el.classList.add('twarn');if(bar)bar.classList.add('twarn');}
    if(s<=0&&el.id.startsWith('tk-'))anyExpired=true;
  });
  if(anyExpired){
    fetch('/try-refresh').finally(()=>location.reload());
  }
},1000);
(function tick(){document.getElementById('clock').textContent=new Date().toLocaleTimeString();setTimeout(tick,1000);})();



</script>
${BG_SCRIPT}
</body></html>`);
});

// ── Session CRUD ───────────────────────────────────────────────────────────────
app.post("/session/create",(req,res)=>{
  const id=crypto.randomBytes(8).toString("hex");
  const{name,token,refresh_token}=req.body;
  sessions[id]={id,name:name||id,token:token?.trim()||"",refresh_token:refresh_token?.trim()||"",connections:0};
  saveSessions();
  if (sessions[id].token) connectLiveSocket(sessions[id]);
  if(req.headers["accept"]?.includes("application/json")) return res.json({ok:true,id});
  res.redirect("/");
});
app.post("/session/:id/update",(req,res)=>{
  const s=sessions[req.params.id];
  if(!s)return res.status(404).json({error:"Not found"});
  if(req.body.token)s.token=req.body.token.trim();
  if(req.body.refresh_token)s.refresh_token=req.body.refresh_token.trim();
  saveSessions();
  if(req.body.token){
    const ex=liveSockets[s.id];
    if(ex&&ex.sock){try{ex.sock.removeAllListeners();ex.sock.close();}catch(_){}}
    delete liveSockets[s.id];
    connectLiveSocket(s);
  }
  req.body._from==="ui"?res.redirect("/"):res.json({ok:true});
});
app.post("/session/:id/rename",(req,res)=>{
  const s=sessions[req.params.id];
  if(!s)return res.status(404).json({error:"Not found"});
  s.name=req.body.name?.trim()||s.name;saveSessions();res.redirect("/");
});
app.post("/session/:id/refresh",async(req,res)=>{
  const s=sessions[req.params.id];
  if(!s)return res.status(404).json({error:"Not found"});
  await tryRefresh(s);res.redirect("/");
});
app.post("/session/:id/delete",(req,res)=>{
  const ex=liveSockets[req.params.id];
  if(ex&&ex.sock){try{ex.sock.removeAllListeners();ex.sock.close();}catch(_){}}
  delete liveSockets[req.params.id];
  delete sessions[req.params.id];saveSessions();res.redirect("/");
});
app.post("/refresh-all",async(req,res)=>{
  for(const s of Object.values(sessions))await tryRefresh(s);
  if(req.headers["accept"]?.includes("application/json")) return res.json({ok:true});
  res.redirect("/");
});
app.post("/clean-duplicates",(req,res)=>{
  const seen=new Map();
  for(const[id,s]of Object.entries(sessions)){
    const key=s.refresh_token||id;
    if(seen.has(key)){delete sessions[id];}
    else seen.set(key,id);
  }
  saveSessions();res.redirect("/");
});

// ── API ────────────────────────────────────────────────────────────────────────
app.get("/v2/account/authenticate/custom/:client",(req,res)=>{
  const clientId = req.params.client;
  let s = sessions[clientId];
  if(!s) s = Object.values(sessions).find(sess=>{
    try{ return JSON.parse(Buffer.from(sess.token.split(".")[1],"base64").toString()).uid === clientId; }catch{return false;}
  });
  if(!s) s = Object.values(sessions)[0];
  if(s){console.log(`[Auth:GET] ${clientId} → ${s.name||s.id}`);return res.json({token:s.token,refresh_token:s.refresh_token,created:false});}
  res.json({token:"",refresh_token:"",created:false});
});
app.post("/v2/account/authenticate/custom/:client",(req,res)=>{
  const clientId = req.params.client;
  // First try direct key match
  let s = sessions[clientId];
  // Then try matching by uid in token payload
  if(!s) s = Object.values(sessions).find(sess=>{
    try{ return JSON.parse(Buffer.from(sess.token.split(".")[1],"base64").toString()).uid === clientId; }catch{return false;}
  });
  // Fallback to first session
  if(!s) s = Object.values(sessions)[0];
  if(s){s.connections=(s.connections||0)+1;saveSessions();console.log(`[Auth] ${clientId} → ${s.name||s.id}`);return res.json({token:s.token,refresh_token:s.refresh_token,created:false});}
  res.json({token:"",refresh_token:"",created:false});
});
app.post("/v2/account/authenticate/refresh",(req,res)=>{
  const first=Object.values(sessions)[0];
  res.json({token:first?.token||"",refresh_token:first?.refresh_token||"",created:false});
});
app.get("/v2/account",async(req,res)=>{
  // Match session by Bearer token in Authorization header, fallback to any valid session
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  let s = bearerToken ? Object.values(sessions).find(s=>s.token===bearerToken) : null;
  if(!s) s = Object.values(sessions).find(s=>!isExpired(s.token));
  if(!s)return res.status(401).json({error:"No valid session"});
  console.log(`[/v2/account] Serving account for ${s.name||s.id}`);
  try{const u=await fetch(`${NAKAMA_SERVER}/v2/account`,{headers:{"Authorization":`Bearer ${s.token}`,"User-Agent":"UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)","x-unity-version":"6000.3.12f1"}});res.json(await u.json());}
  catch(e){console.log(`[/v2/account] Error: ${e.message}`);res.status(500).json({});}
});
app.post("/v2/account",async(req,res)=>{
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  let s = bearerToken ? Object.values(sessions).find(s=>s.token===bearerToken) : null;
  if(!s) s = Object.values(sessions).find(s=>!isExpired(s.token));
  if(!s)return res.status(401).json({error:"No valid session"});
  console.log(`[POST /v2/account] Serving account for ${s.name||s.id}`);
  try{const u=await fetch(`${NAKAMA_SERVER}/v2/account`,{headers:{"Authorization":`Bearer ${s.token}`,"User-Agent":"UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)","x-unity-version":"6000.3.12f1"}});res.json(await u.json());}
  catch(e){console.log(`[POST /v2/account] Error: ${e.message}`);res.status(500).json({});}
});
async function fetchAllFriends(token){
  const all=[];
  let cursor="";
  let pages=0;
  while(pages<50){ // hard cap so a bug can't loop forever
    const url=`${NAKAMA_SERVER}/v2/friend?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`;
    const u=await fetch(url,{
      headers:{
        "Authorization":`Bearer ${token}`,
        "User-Agent":"UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)",
        "x-unity-version":"6000.3.12f1"
      }
    });
    const text=await u.text();
    if(!u.ok){
      const err=new Error(`Nakama ${u.status}: ${text.slice(0,150)}`);
      err.status=u.status;
      throw err;
    }
    const data=JSON.parse(text);
    const page=data.friends||[];
    all.push(...page);
    pages++;
    if(!data.cursor||page.length===0) break;
    cursor=data.cursor;
  }
  return all;
}

app.get("/session/:id/friends",async(req,res)=>{
  const s=sessions[req.params.id];
  if(!s)return res.status(404).json({error:"Not found"});
  if(!s.token)return res.status(400).json({error:"No token on session"});
  try{
    const friends=await fetchAllFriends(s.token);
    const userIds=friends.map(f=>f.user&&f.user.id).filter(Boolean);

    const presenceResult=await fetchPresences(s.token,userIds);
    const presenceMap={};
    if(presenceResult.presences){
      for(const p of presenceResult.presences){
        let parsed={};
        try{parsed=JSON.parse(p.status||"{}");}catch(_){}
        presenceMap[p.user_id]={roomCode:parsed.roomCode||null,gameMode:parsed.gameMode,appearOffline:!!parsed.appearOffline,clientVersion:parsed.clientVersion||null};
      }
    } else if(presenceResult.error){
      console.log(`[Presence:${s.name||s.id}] ${presenceResult.error}`);
    }

    let cacheDirty=false;
    const pendingWebhooks=[];
    const enriched=friends.map(f=>{
      const uid=f.user&&f.user.id;
      const pres=uid?presenceMap[uid]:null;
      const restOnline=!!(f.user&&f.user.online);
      // A presence entry existing at all means they have an active socket connected —
      // appearOffline is just an in-game privacy toggle, not an actual disconnect, so it
      // should NOT hide online/room-code status from this tracker.
      const wsOnline=!!pres;
      const online=restOnline||wsOnline;
      const appearingOffline=!!(pres&&pres.appearOffline);
      const name=(f.user&&(f.user.display_name||f.user.username))||uid;

      // Fresh room code from this lookup — always surfaced if we have live presence,
      // regardless of their appearOffline preference.
      const liveRoomCode=pres?(pres.roomCode||null):null;

      if(uid&&liveRoomCode){
        const prev=roomCache[uid];
        const isNewJoin=!!prev&&prev.roomCode!==liveRoomCode;
        roomCache[uid]={roomCode:liveRoomCode,gameMode:pres.gameMode,lastSeenOnline:Date.now(),name};
        cacheDirty=true;
        if(isNewJoin){
          pendingWebhooks.push({
            name, uid, roomCode:liveRoomCode, gameMode:pres.gameMode,
            appearingOffline, clientVersion:pres.clientVersion,
            avatarUrl:f.user&&f.user.avatar_url, detectedBy:s.name||s.id
          });
        }
      }

      const cached=uid?roomCache[uid]:null;
      const roomCode=liveRoomCode||(cached?cached.roomCode:null);
      const roomIsLive=!!liveRoomCode;

      return{
        ...f,
        online,
        appearingOffline,
        roomCode,
        roomIsLive,
        roomLastSeen:(!roomIsLive&&cached)?cached.lastSeenOnline:null,
        gameMode:pres?pres.gameMode:(cached?cached.gameMode:null)
      };
    });
    if(cacheDirty)saveRoomCache();
    pendingWebhooks.forEach(ev=>sendRoomJoinWebhook(ev).catch(()=>{}));

    res.json({friends:enriched,presenceError:presenceResult.error||null});
  }catch(e){
    console.log(`[Friends:${s.name||s.id}] Error: ${e.message}`);
    res.status(e.status||500).json({error:e.message});
  }
});
app.post("/update-tokens",(req,res)=>{
  const{token,refresh_token,id}=req.body;
  if(!token||!refresh_token)return res.status(400).json({error:"token and refresh_token required"});
  const target=(id&&sessions[id])?sessions[id]:Object.values(sessions)[0];
  if(!target)return res.status(404).json({error:"No session found"});
  target.token=token;target.refresh_token=refresh_token;saveSessions();
  res.json({ok:true});
});
app.get("/try-refresh",async(req,res)=>{
  const results={};
  for(const s of Object.values(sessions))results[s.id]=await tryRefresh(s);
  res.json(results);
});

// ── SYMBOL GETTER PAGE ────────────────────────────────────────────────────────
app.get("/symbol-getter", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Symbol Getter — AC Auth</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700;900&family=Inter:wght@400;500;600;700;900&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --pp:#7fd6ff;--pk:#3d9fdb;--or:#184d78;
  --pp-dim:rgba(127,214,255,0.12);
  --border:rgba(255,255,255,0.07);--border-hi:rgba(255,255,255,0.14);
  --bg0:#03050a;--bg1:rgba(255,255,255,0.025);--bg2:rgba(255,255,255,0.04);
  --bg3:#1a1a1a;
  --text:#eef6ff;--muted:rgba(147,167,191,0.35);--mono:'JetBrains Mono',monospace;
  --success:#50fa7b;--danger:#ff5555;
}
html,body{min-height:100%;background:var(--bg0);font-family:'Inter',sans-serif;color:var(--text)}
#bg{position:fixed;inset:0;z-index:0;pointer-events:none}
.page{position:relative;z-index:1;max-width:1020px;margin:0 auto;padding-bottom:80px}
.hdr{display:flex;align-items:center;gap:14px;padding:18px 28px;border-bottom:1px solid var(--border);background:rgba(0,0,10,0.55);backdrop-filter:blur(20px);position:sticky;top:0;z-index:100}
.hdr-logo{width:38px;height:38px;background:linear-gradient(135deg,var(--pp),var(--pk),var(--or));border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 24px rgba(127,214,255,0.5);animation:logopulse 4s ease-in-out infinite;flex-shrink:0}
@keyframes logopulse{0%,100%{box-shadow:0 0 24px rgba(127,214,255,0.5)}50%{box-shadow:0 0 40px rgba(127,214,255,0.8),0 0 60px rgba(61,159,219,0.3)}}
.hdr-name{font-size:18px;font-weight:700;font-family:'Space Grotesk',sans-serif;color:#fff;letter-spacing:-.5px}
.hdr-name em{font-style:normal;background:linear-gradient(90deg,var(--pp),var(--pk));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.made-by{display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,rgba(127,214,255,0.15),rgba(61,159,219,0.1));border:1px solid rgba(127,214,255,0.35);border-radius:100px;padding:5px 14px 5px 10px;position:relative;overflow:hidden}
.made-by::before{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(127,214,255,0.08),transparent);animation:shimmer 2.5s linear infinite}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.made-by-dot{width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,var(--pp),var(--pk));box-shadow:0 0 8px rgba(127,214,255,0.8);animation:dotpulse 2s ease-in-out infinite;flex-shrink:0}
@keyframes dotpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.7)}}
.made-by-text{font-size:11px;font-weight:800;letter-spacing:.5px;background:linear-gradient(90deg,#c084fc,#f472b6,#fb923c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;white-space:nowrap}
.hdr-nav{display:flex;gap:4px;background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:12px;padding:4px}
.hnav-btn{font-size:11px;font-weight:700;padding:6px 14px;border-radius:8px;color:var(--muted);text-decoration:none;transition:all .15s;letter-spacing:.2px}
.hnav-btn:hover{color:var(--text);background:rgba(255,255,255,0.06)}
.hnav-active{background:linear-gradient(135deg,var(--pp),var(--pk))!important;color:#fff!important;box-shadow:0 2px 12px rgba(127,214,255,0.4)}
.hdr-r{margin-left:auto;display:flex;align-items:center;gap:10px}
.hdr-clock{font-size:12px;color:var(--muted);font-family:var(--mono);background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:6px 12px}
.abtn{border:none;padding:9px 16px;cursor:pointer;font-weight:700;font-size:12px;border-radius:10px;font-family:'Inter',sans-serif;transition:all .15s;letter-spacing:.2px;white-space:nowrap}
.abtn:hover{transform:translateY(-1px);filter:brightness(1.1)}
.abtn-ghost{background:var(--bg2);color:var(--pp);border:1px solid rgba(127,214,255,0.25)}
.abtn-ghost:hover{background:var(--pp-dim)}

/* Symbol Getter content */
.sg-wrap{padding:32px 28px}
.sg-title{font-size:26px;font-weight:900;color:#fff;letter-spacing:-.5px;margin-bottom:6px}
.sg-sub{font-size:13px;color:var(--muted);margin-bottom:6px}
.sg-by{font-size:11px;color:rgba(147,167,191,0.2);letter-spacing:.5px;margin-bottom:28px}
.drop-zone{border:1.5px dashed var(--border-hi);border-radius:18px;padding:3.5rem 2rem;text-align:center;cursor:pointer;transition:background .15s,border-color .15s;margin-bottom:1.5rem;user-select:none;background:var(--bg1)}
.drop-zone:hover,.drop-zone.drag{background:rgba(127,214,255,0.06);border-color:rgba(127,214,255,0.4)}
.drop-zone svg{width:36px;height:36px;color:var(--muted);display:block;margin:0 auto 14px}
.dz-title{font-size:15px;font-weight:600;color:var(--text)}
.dz-hint{font-size:13px;color:var(--muted);margin-top:5px}
#file-input{display:none}
.progress{height:2px;background:rgba(255,255,255,0.05);border-radius:2px;margin-bottom:1rem;display:none;overflow:hidden}
.progress.show{display:block}
.progress-bar{height:100%;width:0%;background:linear-gradient(90deg,var(--pp),var(--pk));border-radius:2px;transition:width .3s}
.status{font-size:12px;color:var(--muted);margin-bottom:1.25rem;display:none;font-family:var(--mono)}
.status.show{display:block}
.status.err{color:var(--danger)}
.status.ok{color:var(--success)}
.outputs{display:flex;flex-direction:column;gap:14px}
.out-card{background:var(--bg1);border:1px solid var(--border);border-radius:18px;overflow:hidden;display:none}
.out-card.show{display:block}
.out-header{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--border);background:rgba(255,255,255,0.02)}
.out-header-left{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:700;font-family:var(--mono);color:#fff}
.badge{font-size:11px;padding:2px 10px;border-radius:99px;background:var(--pp-dim);color:var(--pp);border:1px solid rgba(127,214,255,0.25);font-family:'Inter',sans-serif}
.dl-btn{display:flex;align-items:center;gap:6px;font-size:12px;font-family:'Inter',sans-serif;padding:6px 16px;border-radius:9px;border:1px solid var(--border-hi);background:transparent;color:var(--text);cursor:pointer;transition:background .12s;font-weight:600}
.dl-btn:hover{background:var(--pp-dim);border-color:rgba(127,214,255,0.35);color:var(--pp)}
.dl-btn svg{width:13px;height:13px}
pre{padding:18px;font-size:11px;color:rgba(147,167,191,0.5);font-family:var(--mono);overflow:auto;max-height:240px;line-height:1.7;white-space:pre;background:rgba(0,0,0,0.3)}
.toast{position:fixed;bottom:28px;right:28px;background:linear-gradient(135deg,var(--pp),var(--pk));color:#fff;padding:10px 20px;border-radius:12px;font-size:12px;font-weight:700;z-index:999;opacity:0;transform:translateY(10px) scale(.95);transition:all .25s;pointer-events:none;box-shadow:0 8px 32px rgba(127,214,255,0.4)}
.toast.show{opacity:1;transform:translateY(0) scale(1)}
</style></head><body>
<canvas id="bg"></canvas>
<div class="page">

<div class="hdr">
  <div class="hdr-logo">⚡</div>
  <div class="hdr-name">AC Auth <em>Backend</em></div>
  <div class="made-by"><div class="made-by-dot"></div><div class="made-by-text">Created By Amblock</div></div>
  <nav class="hdr-nav">
    <a href="/" class="hnav-btn">Sessions</a>
    <a href="/symbol-getter" class="hnav-btn hnav-active">Symbol Getter</a>
  </nav>
  <div class="hdr-r">
    <div class="hdr-clock" id="clock"></div>
    <form method="POST" action="/logout" style="display:inline">
      <button type="submit" class="abtn abtn-ghost" style="padding:7px 14px;font-size:11px">Sign Out</button>
    </form>
  </div>
</div>

<div class="sg-wrap">
  <div class="sg-title">Symbol Getter</div>
  <div class="sg-sub">Get symbols from libil2cpp.so and generate output files</div>
  <div class="sg-by">BY AMBLOCK</div>

  <div class="drop-zone" id="dz">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <div class="dz-title">Drop libil2cpp.so here</div>
    <div class="dz-hint">or click to browse — processed entirely in your browser</div>
  </div>
  <input type="file" id="file-input" accept=".so">

  <div class="progress" id="prog"><div class="progress-bar" id="prog-bar"></div></div>
  <div class="status" id="status"></div>

  <div class="outputs">
    <div class="out-card" id="card-json">
      <div class="out-header">
        <div class="out-header-left">SymbolMap.json <span class="badge" id="cnt">0 symbols</span></div>
        <button class="dl-btn" onclick="dl('SymbolMap.json','json')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
      <pre id="pre-json"></pre>
    </div>
    <div class="out-card" id="card-headers">
      <div class="out-header">
        <div class="out-header-left">Il2Cpp-Headers.hpp</div>
        <button class="dl-btn" onclick="dl('Il2Cpp-Headers.hpp','headers')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
      <pre id="pre-headers"></pre>
    </div>
    <div class="out-card" id="card-method">
      <div class="out-header">
        <div class="out-header-left">Il2CppMethodNames.hpp</div>
        <button class="dl-btn" onclick="dl('Il2CppMethodNames.hpp','method')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
      <pre id="pre-method"></pre>
    </div>
    <div class="out-card" id="card-frida">
      <div class="out-header">
        <div class="out-header-left">Frida-Map.js</div>
        <button class="dl-btn" onclick="dl('Frida-Map.js','frida')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download
        </button>
      </div>
      <pre id="pre-frida"></pre>
    </div>
  </div>
</div>
</div>
<div class="toast" id="toast"></div>

<script>
const IL2CPP_API = [
  "il2cpp_init","il2cpp_init_utf16","il2cpp_shutdown","il2cpp_set_config_dir",
  "il2cpp_set_data_dir","il2cpp_set_temp_dir","il2cpp_set_commandline_arguments","il2cpp_set_commandline_arguments_utf16",
  "il2cpp_set_config_utf16","il2cpp_set_config","il2cpp_set_memory_callbacks","il2cpp_memory_pool_set_region_size",
  "il2cpp_memory_pool_get_region_size","il2cpp_get_corlib","il2cpp_add_internal_call","il2cpp_resolve_icall",
  "il2cpp_alloc","il2cpp_free","il2cpp_array_class_get","il2cpp_array_length",
  "il2cpp_array_get_byte_length","il2cpp_array_new","il2cpp_array_new_specific","il2cpp_array_new_full",
  "il2cpp_bounded_array_class_get","il2cpp_array_element_size","il2cpp_assembly_get_image","il2cpp_class_enum_basetype",
  "il2cpp_class_from_system_type","il2cpp_class_is_inited","il2cpp_class_is_generic","il2cpp_class_is_inflated",
  "il2cpp_class_is_assignable_from","il2cpp_class_is_subclass_of","il2cpp_class_has_parent","il2cpp_class_from_il2cpp_type",
  "il2cpp_class_from_name","il2cpp_class_get_element_class","il2cpp_class_get_events","il2cpp_class_get_fields",
  "il2cpp_class_get_nested_types","il2cpp_class_get_interfaces","il2cpp_class_get_properties","il2cpp_class_get_property_from_name",
  "il2cpp_class_get_field_from_name","il2cpp_class_get_methods","il2cpp_class_get_method_from_name","il2cpp_class_get_name",
  "il2cpp_class_get_namespace","il2cpp_class_get_parent","il2cpp_class_get_declaring_type","il2cpp_class_instance_size",
  "il2cpp_class_num_fields","il2cpp_class_is_valuetype","il2cpp_class_is_blittable","il2cpp_class_value_size",
  "il2cpp_class_get_flags","il2cpp_class_is_abstract","il2cpp_class_is_interface","il2cpp_class_array_element_size",
  "il2cpp_class_from_type","il2cpp_class_get_type","il2cpp_class_get_type_token","il2cpp_class_has_attribute",
  "il2cpp_class_has_references","il2cpp_class_is_enum","il2cpp_class_get_image","il2cpp_class_get_assemblyname",
  "il2cpp_class_get_rank","il2cpp_class_get_data_size","il2cpp_class_get_static_field_data","il2cpp_stats_dump_to_file",
  "il2cpp_stats_get_value","il2cpp_domain_get","il2cpp_domain_assembly_open","il2cpp_domain_get_assemblies",
  "il2cpp_raise_exception","il2cpp_exception_from_name_msg","il2cpp_get_exception_argument_null","il2cpp_format_exception",
  "il2cpp_format_stack_trace","il2cpp_unhandled_exception","il2cpp_native_stack_trace","il2cpp_field_get_name",
  "il2cpp_field_get_flags","il2cpp_field_get_from_reflection","il2cpp_field_get_parent","il2cpp_field_get_object",
  "il2cpp_field_get_offset","il2cpp_field_get_type","il2cpp_field_get_value","il2cpp_field_get_value_object",
  "il2cpp_field_has_attribute","il2cpp_field_set_value","il2cpp_field_set_value_object","il2cpp_field_static_get_value",
  "il2cpp_field_static_set_value","il2cpp_field_is_literal","il2cpp_gc_collect","il2cpp_gc_collect_a_little",
  "il2cpp_gc_start_incremental_collection","il2cpp_gc_enable","il2cpp_gc_disable","il2cpp_gc_is_disabled",
  "il2cpp_gc_set_mode","il2cpp_gc_is_incremental","il2cpp_gc_get_max_time_slice_ns","il2cpp_gc_set_max_time_slice_ns",
  "il2cpp_gc_get_used_size","il2cpp_gc_get_heap_size","il2cpp_gc_foreach_heap","il2cpp_stop_gc_world",
  "il2cpp_start_gc_world","il2cpp_gc_alloc_fixed","il2cpp_gc_free_fixed","il2cpp_gchandle_new",
  "il2cpp_gchandle_new_weakref","il2cpp_gchandle_get_target","il2cpp_gchandle_foreach_get_target","il2cpp_gc_wbarrier_set_field",
  "il2cpp_gc_has_strict_wbarriers","il2cpp_gc_set_external_allocation_tracker","il2cpp_gc_set_external_wbarrier_tracker","il2cpp_gchandle_free",
  "il2cpp_object_header_size","il2cpp_array_object_header_size","il2cpp_offset_of_array_length_in_array_object_header","il2cpp_offset_of_array_bounds_in_array_object_header",
  "il2cpp_allocation_granularity","il2cpp_unity_liveness_allocate_struct","il2cpp_unity_liveness_calculation_from_root","il2cpp_unity_liveness_calculation_from_statics",
  "il2cpp_unity_liveness_finalize","il2cpp_unity_liveness_free_struct","il2cpp_method_get_return_type","il2cpp_method_get_from_reflection",
  "il2cpp_method_get_object","il2cpp_method_get_name","il2cpp_method_is_generic","il2cpp_method_is_inflated",
  "il2cpp_method_is_instance","il2cpp_method_get_param_count","il2cpp_method_get_param","il2cpp_method_get_class",
  "il2cpp_method_has_attribute","il2cpp_method_get_declaring_type","il2cpp_method_get_flags","il2cpp_method_get_token",
  "il2cpp_method_get_param_name","il2cpp_profiler_install","il2cpp_profiler_set_events","il2cpp_profiler_install_enter_leave",
  "il2cpp_profiler_install_allocation","il2cpp_profiler_install_gc","il2cpp_profiler_install_fileio","il2cpp_profiler_install_thread",
  "il2cpp_property_get_name","il2cpp_property_get_get_method","il2cpp_property_get_set_method","il2cpp_property_get_parent",
  "il2cpp_property_get_flags","il2cpp_object_get_class","il2cpp_object_get_size","il2cpp_object_get_virtual_method",
  "il2cpp_object_new","il2cpp_object_unbox","il2cpp_value_box","il2cpp_monitor_enter",
  "il2cpp_monitor_try_enter","il2cpp_monitor_exit","il2cpp_monitor_pulse","il2cpp_monitor_pulse_all",
  "il2cpp_monitor_wait","il2cpp_monitor_try_wait","il2cpp_runtime_invoke_convert_args","il2cpp_runtime_invoke",
  "il2cpp_runtime_class_init","il2cpp_runtime_object_init","il2cpp_runtime_object_init_exception","il2cpp_runtime_unhandled_exception_policy_set",
  "il2cpp_string_length","il2cpp_string_chars","il2cpp_string_new","il2cpp_string_new_wrapper",
  "il2cpp_string_new_utf16","il2cpp_string_new_len","il2cpp_string_intern","il2cpp_string_is_interned",
  "il2cpp_thread_current","il2cpp_thread_attach","il2cpp_thread_detach","il2cpp_is_vm_thread",
  "il2cpp_current_thread_walk_frame_stack","il2cpp_thread_walk_frame_stack","il2cpp_current_thread_get_top_frame","il2cpp_thread_get_top_frame",
  "il2cpp_current_thread_get_frame_at","il2cpp_thread_get_frame_at","il2cpp_current_thread_get_stack_depth","il2cpp_thread_get_stack_depth",
  "il2cpp_set_default_thread_affinity","il2cpp_override_stack_backtrace","il2cpp_type_get_object","il2cpp_type_get_type",
  "il2cpp_type_get_class_or_element_class","il2cpp_type_get_name","il2cpp_type_get_assembly_qualified_name","il2cpp_type_get_reflection_name",
  "il2cpp_type_is_byref","il2cpp_type_get_attrs","il2cpp_type_equals","il2cpp_type_is_static",
  "il2cpp_type_is_pointer_type","il2cpp_image_get_assembly","il2cpp_image_get_name","il2cpp_image_get_filename",
  "il2cpp_image_get_entry_point","il2cpp_image_get_class_count","il2cpp_image_get_class","il2cpp_capture_memory_snapshot",
  "il2cpp_free_captured_memory_snapshot","il2cpp_set_find_plugin_callback","il2cpp_register_log_callback","il2cpp_debugger_set_agent_options",
  "il2cpp_is_debugger_attached","il2cpp_register_debugger_agent_transport","il2cpp_debug_foreach_method","il2cpp_debug_get_method_info",
  "il2cpp_unity_install_unitytls_interface","il2cpp_custom_attrs_from_class","il2cpp_custom_attrs_from_method","il2cpp_custom_attrs_from_field",
  "il2cpp_custom_attrs_has_attr","il2cpp_custom_attrs_get_attr","il2cpp_custom_attrs_construct","il2cpp_custom_attrs_free",
  "il2cpp_type_get_name_chunked","il2cpp_class_set_userdata","il2cpp_class_get_userdata_offset","il2cpp_class_for_each",
  "il2cpp_unity_set_android_network_up_state_func"
];

const SKIP_RE = /^(_Z|SystemNative|Java_|pthread|__cxa|__start|__stop|NLSocket|ZStream|Flush|Dll[CG]|Globalization|JNI_|ReadEvents|mono_pal|__dynamic|__gxx|UnityAds|CloseN|CreateN)/;
let outputs = {};

const dz = document.getElementById('dz');
const fi = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const progEl = document.getElementById('prog');
const progBar = document.getElementById('prog-bar');

dz.addEventListener('click', () => fi.click());
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); processFile(e.dataTransfer.files[0]); });
fi.addEventListener('change', () => processFile(fi.files[0]));

function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = 'status show' + (cls ? ' '+cls : ''); }
function setProgress(p) { progEl.className = 'progress show'; progBar.style.width = p + '%'; if (p >= 100) setTimeout(() => { progEl.className = 'progress'; }, 700); }

function r32(b,o){return((b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0);}
function r64(b,o){return r32(b,o+4)*0x100000000+r32(b,o);}
function r16(b,o){return b[o]|(b[o+1]<<8);}
function cstr(b,o){let s='';while(o<b.length&&b[o]!==0)s+=String.fromCharCode(b[o++]);return s;}

function extractObfSymbols(buf) {
  if(buf[0]!==0x7f||buf[1]!==0x45||buf[2]!==0x4c||buf[3]!==0x46)throw new Error('Not an ELF file');
  const is64=buf[4]===2;
  const entries=[];
  if(is64){
    const shoff=r64(buf,40),shentsz=r16(buf,58),shnum=r16(buf,60);
    const secs=[];
    for(let i=0;i<shnum;i++){const b=Number(shoff)+i*shentsz;secs.push({type:r32(buf,b+4),off:r64(buf,b+24),size:r64(buf,b+32),link:r32(buf,b+40),entsz:r64(buf,b+56)});}
    for(const s of secs){
      if(s.type!==11&&s.type!==2)continue;
      const strsec=secs[s.link];const esz=Number(s.entsz)||24;const cnt=Math.floor(Number(s.size)/esz);
      for(let j=0;j<cnt;j++){const b=Number(s.off)+j*esz;const nm=r32(buf,b);const info=buf[b+4];const shndx=r16(buf,b+6);const addr=r64(buf,b+8);const bind=info>>4;
        if(shndx!==0&&shndx!==0xfff1&&bind===1){const name=cstr(buf,Number(strsec.off)+nm);if(name&&!SKIP_RE.test(name)&&/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(name))entries.push({name,addr:Number(addr)});}}
    }
  } else {
    const shoff=r32(buf,32),shentsz=r16(buf,46),shnum=r16(buf,48);
    const secs=[];
    for(let i=0;i<shnum;i++){const b=shoff+i*shentsz;secs.push({type:r32(buf,b+4),off:r32(buf,b+16),size:r32(buf,b+20),link:r32(buf,b+24),entsz:r32(buf,b+36)});}
    for(const s of secs){
      if(s.type!==11&&s.type!==2)continue;
      const strsec=secs[s.link];const esz=s.entsz||16;const cnt=Math.floor(s.size/esz);
      for(let j=0;j<cnt;j++){const b=s.off+j*esz;const nm=r32(buf,b);const addr=r32(buf,b+4);const info=buf[b+12];const shndx=r16(buf,b+14);const bind=info>>4;
        if(shndx!==0&&shndx!==0xfff1&&bind===1){const name=cstr(buf,strsec.off+nm);if(name&&!SKIP_RE.test(name)&&/^[A-Za-z_][A-Za-z0-9_]{2,}$/.test(name))entries.push({name,addr});}}
    }
  }
  entries.sort((a,b)=>a.addr-b.addr);
  return [...new Map(entries.map(e=>[e.name,e])).values()].sort((a,b)=>a.addr-b.addr).map(e=>e.name);
}

function buildMap(syms){const map={};const len=Math.min(syms.length,IL2CPP_API.length);for(let i=0;i<len;i++)map[IL2CPP_API[i]]=syms[i];return map;}
function ts(){return new Date().toLocaleString('en-US',{month:'2-digit',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});}
function genJSON(map){const obj={"__header":"// Generated by amblock at "+ts()+"  [Symbol-Map]"};for(const[k,v]of Object.entries(map))obj[k]=v;return JSON.stringify(obj,null,4);}
function genHeaders(map){let s="#pragma once\\n\\n// Generated by amblock at "+ts()+"  [Il2Cpp-Headers]\\n\\n";for(const[k,v]of Object.entries(map))s+="#define symbol_"+k+" \\""+v+"\\"\\n";return s;}
function genMethod(map){let s="#pragma once\\n\\n// Generated by amblock at "+ts()+"  [Il2CppMethodNames]\\n\\n";for(const[k,v]of Object.entries(map))s+="#define BNM_IL2CPP_API_"+k+" \\""+v+"\\"\\n";return s;}
function genFrida(map){const entries=Object.entries(map);let s="// Generated by amblock at "+ts()+"  [Frida-Map]\\n\\nIl2Cpp.$config.exports = {\\n";entries.forEach(([k,v],i)=>s+="    "+k+": () => Il2Cpp.module.findExportByName(\\""+v+"\\")"+((i<entries.length-1)?',':'')+"\\n");s+='};';return s;}

async function processFile(file){
  if(!file)return;
  if(!file.name.endsWith('.so')){setStatus('file must be a .so library','err');return;}
  setStatus('reading file...');setProgress(10);
  const buf=new Uint8Array(await file.arrayBuffer());
  setProgress(40);setStatus('parsing ELF symbol table...');
  let syms;try{syms=extractObfSymbols(buf);}catch(e){setStatus('ELF error: '+e.message,'err');return;}
  setProgress(75);setStatus('found '+syms.length+' symbols — mapping to IL2CPP API...');
  const map=buildMap(syms);const cnt=Object.keys(map).length;
  outputs.json=genJSON(map);outputs.headers=genHeaders(map);outputs.method=genMethod(map);outputs.frida=genFrida(map);
  setProgress(100);setStatus('done — mapped '+cnt+' symbols','ok');
  document.getElementById('cnt').textContent=cnt+' symbols';
  document.getElementById('pre-json').textContent=outputs.json.slice(0,3000)+(outputs.json.length>3000?'\\n...':'');
  document.getElementById('pre-headers').textContent=outputs.headers.slice(0,3000)+(outputs.headers.length>3000?'\\n...':'');
  document.getElementById('pre-method').textContent=outputs.method.slice(0,3000)+(outputs.method.length>3000?'\\n...':'');
  document.getElementById('pre-frida').textContent=outputs.frida.slice(0,3000)+(outputs.frida.length>3000?'\\n...':'');
  ['json','headers','method','frida'].forEach(id=>document.getElementById('card-'+id).classList.add('show'));
}

function dl(filename,key){if(!outputs[key])return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([outputs[key]],{type:'text/plain'}));a.download=filename;a.click();}

(function tick(){document.getElementById('clock').textContent=new Date().toLocaleTimeString();setTimeout(tick,1000);})();
</script>
${BG_SCRIPT}
</body></html>`);
});

app.all("*",(req,res)=>{
  console.log(`[Unhandled] ${req.method} ${req.path}`);
  res.status(200).json({});
});
app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
