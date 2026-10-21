// Footwork & Steel online server.
// Pairs players (quick match or a private room code) and relays messages between the two.
// Also runs free-for-all parties of up to 8: a code, a host, a list of players, and a relay to everyone in the party.
// No dependencies: plain Node.js with its own small WebSocket implementation.
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const NET_VERSION = 1;               // must match NET_VERSION in the game
const MAX_MESSAGE = 64 * 1024;       // bytes
const MAX_RATE = 240;                // messages per second per player
const ROOM_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const players = new Set();
let queue = [];                      // players waiting for a quick match
const rooms = new Map();             // code -> player waiting in a private room
const parties = new Map();           // code -> free-for-all party
const PARTY_MAX = 8;
const PARTY_STALE = 10 * 60 * 1000;  // a fight that never reports back can be restarted after this long

/* ---------- HTTP: a health check and a status line ---------- */
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(`Footwork & Steel server. ${players.size} player${players.size === 1 ? "" : "s"} connected, ${parties.size} part${parties.size === 1 ? "y" : "ies"}.\n`);
});

/* ---------- WebSocket handshake ---------- */
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if ((req.headers.upgrade || "").toLowerCase() !== "websocket" || !key) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);
  const p = { socket, buf: Buffer.alloc(0), frag: [], alive: true, open: true, name: "Fencer", troop: "sword", partner: null, role: null, party: null, pid: 0, fin: false,
    room: null, waiting: false, rate: 0, rateT: Date.now(), hello: false };
  players.add(p);
  socket.on("data", d => { try { onData(p, d); } catch (e) { drop(p); } });
  socket.on("close", () => drop(p));
  socket.on("error", () => drop(p));
});

/* ---------- WebSocket frames ---------- */
function onData(p, d) {
  p.buf = Buffer.concat([p.buf, d]);
  while (p.buf.length >= 2) {
    const b0 = p.buf[0], b1 = p.buf[1], fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (p.buf.length < 4) return; len = p.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (p.buf.length < 10) return; const hi = p.buf.readUInt32BE(2); len = p.buf.readUInt32BE(6); if (hi) return drop(p); off = 10; }
    if (len > MAX_MESSAGE) return drop(p);
    if (!masked) return drop(p);                       // clients must mask their frames
    if (p.buf.length < off + 4 + len) return;
    const mask = p.buf.subarray(off, off + 4), data = Buffer.from(p.buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    p.buf = p.buf.subarray(off + 4 + len);
    if (op === 0x8) { sendFrame(p, 0x8, Buffer.alloc(0)); return drop(p); }
    if (op === 0x9) { sendFrame(p, 0xA, data); continue; }
    if (op === 0xA) { p.alive = true; continue; }
    if (op === 0x1 || op === 0x0) {
      p.frag.push(data);
      if (!fin) { if (p.frag.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE) return drop(p); continue; }
      const text = Buffer.concat(p.frag).toString("utf8"); p.frag = [];
      p.alive = true;
      onMessage(p, text);
    }
  }
}
function sendFrame(p, op, payload) {
  if (!p.open) return;
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
  head[0] = 0x80 | op;
  try { p.socket.write(Buffer.concat([head, payload])); } catch (e) { drop(p); }
}
const send = (p, obj) => sendFrame(p, 0x1, Buffer.from(JSON.stringify(obj)));

/* ---------- matchmaking and relay ---------- */
const clean = (s, n) => String(s || "").replace(/[^\p{L}\p{N} ._'-]/gu, "").trim().slice(0, n);
function onMessage(p, text) {
  const now = Date.now();
  if (now - p.rateT > 1000) { p.rateT = now; p.rate = 0; }
  if (++p.rate > MAX_RATE) return;
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== "string") return;
  if (m.t === "hello") {
    if (m.v !== NET_VERSION) return send(p, { t: "error", msg: "This game and the server are different versions. Update both to the same release." });
    p.name = clean(m.name, 16) || "Fencer"; p.troop = clean(m.troop, 24) || "sword"; p.hello = true;
    return send(p, { t: "welcome", v: NET_VERSION, online: players.size });
  }
  if (!p.hello) return;
  if (m.t === "troop") {
    const t = clean(m.troop, 24) || p.troop, n = clean(m.name, 16) || p.name, changed = t !== p.troop || n !== p.name;
    p.troop = t; p.name = n;
    if (changed && p.party && !p.party.started) partyUpdate(p.party);
    return;
  }
  if (m.t === "pcreate") return partyCreate(p);
  if (m.t === "pjoin") return partyJoin(p, clean(m.code, 8).toUpperCase());
  if (m.t === "pstart") return partyStart(p);
  if (m.t === "pleave") { partyLeave(p); return; }
  if (m.t === "pfin") return partyFin(p);
  if (m.t === "prelay") {
    const party = p.party;
    if (!party || !party.started || m.d === undefined) return;
    const out = { t: "prelay", from: p.pid, d: m.d };
    for (const q of party.members) if (q !== p) send(q, out);
    return;
  }
  if (m.t === "relay") { if (p.partner) send(p.partner, { t: "relay", d: m.d }); return; }
  if (m.t === "quick") {
    partyLeave(p); unwait(p); if (p.partner) return;
    const other = queue.find(q => q !== p && q.open && !q.partner);
    if (other) { queue = queue.filter(q => q !== other); return pair(other, p); }
    queue.push(p); p.waiting = true;
    return send(p, { t: "waiting", online: players.size });
  }
  if (m.t === "create") {
    partyLeave(p); unwait(p); if (p.partner) return;
    let code;
    code = newCode();
    rooms.set(code, p); p.room = code; p.waiting = true;
    return send(p, { t: "room", code });
  }
  if (m.t === "join") {
    partyLeave(p); unwait(p); if (p.partner) return;
    const code = clean(m.code, 8).toUpperCase(), host = rooms.get(code);
    if (!host || !host.open || host === p) return send(p, { t: "error", msg: `No room called ${code || "that"}. Check the code with your friend.` });
    rooms.delete(code); host.room = null;
    return pair(host, p);
  }
  if (m.t === "cancel") { unwait(p); return send(p, { t: "idle", online: players.size }); }
  if (m.t === "leave") { leave(p); return send(p, { t: "idle", online: players.size }); }
}
function newCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => ROOM_LETTERS[crypto.randomInt(ROOM_LETTERS.length)]).join(""); } while (rooms.has(code) || parties.has(code));
  return code;
}

/* ---------- free-for-all parties ---------- */
const member = q => ({ id: q.pid, name: q.name, troop: q.troop });
function partyUpdate(party) {   // tell everyone who is in the party and who hosts it
  const members = party.members.map(member);
  for (const q of party.members) send(q, { t: "party", code: party.code, you: q.pid, host: party.host.pid, members, started: party.started });
}
function partyCreate(p) {
  partyLeave(p); unwait(p); if (p.partner) return;
  const code = newCode(), party = { code, host: p, members: [p], nextId: 1, started: false, startedAt: 0 };
  p.pid = party.nextId++; p.party = party; p.fin = false;
  parties.set(code, party);
  partyUpdate(party);
}
function partyJoin(p, code) {
  partyLeave(p); unwait(p); if (p.partner) return;
  const party = parties.get(code);
  if (!party) return send(p, { t: "error", msg: `No party called ${code || "that"}. Check the code with the host.` });
  if (party.started) return send(p, { t: "error", msg: "That party is already in a fight. Try again when it ends." });
  if (party.members.length >= PARTY_MAX) return send(p, { t: "error", msg: `That party is full (${PARTY_MAX} players).` });
  p.pid = party.nextId++; p.party = party; p.fin = false;
  party.members.push(p);
  partyUpdate(party);
}
function partyStart(p) {
  const party = p.party;
  if (!party || party.host !== p || party.members.length < 2) return;
  if (party.started && Date.now() - party.startedAt < PARTY_STALE) return;
  party.started = true; party.startedAt = Date.now();
  for (const q of party.members) q.fin = false;
  const order = party.members.map(q => q.pid);
  for (let i = order.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }   // random spots round the edge
  for (const q of party.members) send(q, { t: "pgo", order });
}
function partyFin(p) {          // each player reports when the fight is over for them; when all have, the party is open again
  const party = p.party;
  if (!party || !party.started) return;
  p.fin = true;
  partyCheckDone(party);
}
function partyCheckDone(party) {
  if (!party.started || !party.members.every(q => q.fin)) return;
  party.started = false;
  for (const q of party.members) q.fin = false;
  partyUpdate(party);
}
function partyLeave(p) {
  const party = p.party;
  if (!party) return;
  p.party = null; p.fin = false;
  party.members = party.members.filter(q => q !== p);
  if (!party.members.length) { parties.delete(party.code); return; }
  if (party.host === p) party.host = party.members[0];
  if (party.started) for (const q of party.members) send(q, { t: "pgone", id: p.pid });
  partyUpdate(party);
  partyCheckDone(party);
}

function pair(host, guest) {
  for (const q of [host, guest]) unwait(q);
  host.partner = guest; guest.partner = host; host.role = "host"; guest.role = "guest";
  const seed = crypto.randomInt(1 << 30);
  send(host, { t: "match", role: "host", you: { name: host.name, troop: host.troop }, them: { name: guest.name, troop: guest.troop }, seed });
  send(guest, { t: "match", role: "guest", you: { name: guest.name, troop: guest.troop }, them: { name: host.name, troop: host.troop }, seed });
}
function unwait(p) {
  queue = queue.filter(q => q !== p);
  if (p.room && rooms.get(p.room) === p) rooms.delete(p.room);
  p.room = null; p.waiting = false;
}
function leave(p) {
  const o = p.partner;
  p.partner = null; p.role = null;
  if (o) { o.partner = null; o.role = null; send(o, { t: "gone" }); }
}
function drop(p) {
  if (!p.open) return;
  p.open = false;
  partyLeave(p); unwait(p); leave(p); players.delete(p);
  try { p.socket.destroy(); } catch (e) {}
}

/* ---------- keep connections alive and clear dead ones ---------- */
setInterval(() => {
  for (const p of players) {
    if (!p.alive) { drop(p); continue; }
    p.alive = false; sendFrame(p, 0x9, Buffer.alloc(0));
  }
}, 25000);

server.listen(PORT, () => console.log(`Footwork & Steel server listening on port ${PORT}`));
