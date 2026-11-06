const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const RADIUS = +process.env.RADIUS_M || 500; // alcance em metros

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript'],
  '/social.js': ['social.js', 'text/javascript'],
  '/social2.js': ['social2.js', 'text/javascript'],
  '/config.js': ['config.js', 'text/javascript'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/admin': ['admin.html', 'text/html; charset=utf-8']
};
const server = http.createServer((q, r) => {
  r.setHeader('Access-Control-Allow-Origin', '*'); r.setHeader('Access-Control-Allow-Headers', 'x-token,content-type');
  if (q.method === 'OPTIONS') { r.writeHead(204); return r.end(); }
  const pth = q.url.split('?')[0];
  if (q.method === 'POST' && pth === '/upload') return upload(q, r);
  if (pth.startsWith('/admin/')) return admin(q, r, pth);
  const mm = /^\/media\/([a-f0-9]{24}\.(?:jpg|png|webp|gif|mp4|webm|mov))$/.exec(pth);
  if (mm) return media(q, r, mm[1], new URL(q.url, 'http://x').searchParams.get('a') === ADMIN);
  if (q.url.split('?')[0] === '/vapid') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ key: vapidKey })); }
  const f = files[q.url.split('?')[0]];
  if (!f) { r.writeHead(404); return r.end('404'); }
  r.writeHead(200, { 'Content-Type': f[1] });
  fs.createReadStream(path.join(__dirname, 'public', f[0])).pipe(r);
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

const DB = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { names: {}, linked: [], reqs: {}, blocks: {}, queue: {}, reports: [] };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB, 'utf8')) }; } catch {}
let saveTimer;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(DB + '.tmp', JSON.stringify(db), e => { if (!e) fs.rename(DB + '.tmp', DB, () => {}); }), 300); };
const users = new Map();      // pid -> {pid,name,lat,lng,vis,ws}
const linked = new Set(db.linked);   // pares com conversa aceita
const reqs = new Map(Object.entries(db.reqs)); // "de>para" -> texto
const key = (a, b) => [a, b].sort().join('|');
const rad = x => x * Math.PI / 180;
function dist(a, b) {
  const dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
const out = (u, o) => u && u.ws && u.ws.readyState === 1 && u.ws.send(JSON.stringify(o));
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
function rel(a, b) {
  if (linked.has(key(a.pid, b.pid))) return 'chat';
  if (reqs.has(a.pid + '>' + b.pid)) return 'sent';
  if (reqs.has(b.pid + '>' + a.pid)) return 'recv';
  return 'none';
}
// Cada pessoa só recebe quem está visível e dentro do raio. Quem está invisível não vê ninguém.
// A posição enviada aos outros é arredondada (~11 m) e nunca inclui o token de acesso.
function push(u) {
  if (!u.ws || u.lat == null) return;
  const list = [];
  if (u.vis) for (const o of users.values()) {
    if (o === u || !o.ws || !o.vis || o.lat == null || blocked(u.pid, o.pid)) continue;
    const d = dist(u, o);
    if (d > RADIUS) continue;
    const r = rel(u, o);
    list.push({ id: o.pid, name: o.name, lat: +o.lat.toFixed(4), lng: +o.lng.toFixed(4),
      d: Math.round(d / 10) * 10, rel: r, text: r === 'recv' ? reqs.get(o.pid + '>' + u.pid) : undefined });
  }
  out(u, { t: 'near', list });
}
const pushAll = () => users.forEach(push);

// Notificações push (Web Push). As chaves vêm de VAPID_PUBLIC/VAPID_PRIVATE ou são geradas na primeira execução.
let webpush = null; try { webpush = require('web-push'); } catch {}
let vapidKey = null;
db.subs = db.subs || {};
if (webpush) {
  const keys = process.env.VAPID_PUBLIC ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : (db.vapid || webpush.generateVAPIDKeys());
  if (!process.env.VAPID_PUBLIC) db.vapid = keys;
  webpush.setVapidDetails('mailto:' + (process.env.VAPID_CONTACT || 'admin@example.com'), keys.publicKey, keys.privateKey);
  vapidKey = keys.publicKey; persist();
}
function sendPush(u, o) {
  if (!webpush) return;
  const n = o.t === 'msg' ? { title: o.name, body: o.text.slice(0, 120) }
    : o.t === 'accepted' ? { title: 'Perto', body: o.name + ' aceitou seu pedido' } : null;
  if (!n) return;
  for (const sub of (db.subs[u.pid] || []).slice()) {
    webpush.sendNotification(sub, JSON.stringify({ ...n, from: o.from })).catch(e => {
      if (e.statusCode === 404 || e.statusCode === 410) { db.subs[u.pid] = (db.subs[u.pid] || []).filter(x => x.endpoint !== sub.endpoint); persist(); }
    });
  }
}
const sync = () => { db.linked = [...linked]; db.reqs = Object.fromEntries(reqs); persist(); };
const blocked = (a, b) => (db.blocks[a] || []).includes(b) || (db.blocks[b] || []).includes(a);
for (const [pid, n] of Object.entries(db.names)) users.set(pid, { pid, name: n, lat: null, lng: null, vis: true, ws: null });
function limited(u, k, max, ms) {
  u.rl = u.rl || {};
  const now = Date.now(), a = (u.rl[k] || []).filter(x => now - x < ms);
  a.push(now); u.rl[k] = a;
  return a.length > max;
}
// Entrega na hora se a pessoa está online; senão guarda e entrega quando ela voltar.
function deliver(u, o) {
  if (u.ws && u.ws.readyState === 1) return out(u, o);
  const q = db.queue[u.pid] = db.queue[u.pid] || [];
  q.push(o); if (q.length > 200) q.shift(); sendPush(u, o);
  persist();
}
function flush(u) {
  const q = db.queue[u.pid] || []; delete db.queue[u.pid];
  q.forEach(o => out(u, o));
  for (const [k, text] of reqs) {
    const [from, to] = k.split('>');
    if (to === u.pid && !blocked(from, to)) out(u, { t: 'req', from, name: (users.get(from) || {}).name || 'Alguém', text });
  }
  persist();
}
const LIM = { req: [5, 60000], msg: [20, 10000], pos: [30, 60000], report: [5, 3600000], block: [20, 60000], push: [10, 60000],
  post: [10, 3600000], like: [60, 60000], comment: [20, 60000], react: [60, 60000], hist: [60, 60000], feed: [30, 60000], delpost: [20, 60000], offsync: [10, 60000], flag: [10, 3600000], justify: [10, 3600000], follow: [60, 60000], story: [20, 3600000], stories: [60, 60000], sview: [300, 60000], profile: [10, 3600000], myprof: [30, 60000], deck: [60, 60000], swipe: [200, 60000] };

// ---- mídia, posts e histórico de conversas ----
const rid = () => crypto.randomBytes(12).toString('hex');
const UP = path.join(path.dirname(DB), 'uploads'); fs.mkdirSync(UP, { recursive: true });
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const MT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const MAXUP = 30 * 1024 * 1024;
db.posts = db.posts || []; db.hist = db.hist || {}; db.off = db.off || {}; db.mo = db.mo || {}; db.hm = db.hm || {}; db.cases = db.cases || []; db.strikes = db.strikes || { rep: {}, own: {} }; db.banned = db.banned || {}; db.follows = db.follows || {}; db.stories = db.stories || []; db.prof = db.prof || {}; db.swipes = db.swipes || {};
const okMedia = (x, pid) => x && db.mo[x.id] === pid && /^[a-f0-9]{24}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(String(x.id)) ? { id: x.id, kind: /\.(mp4|webm|mov)$/.test(x.id) ? 'video' : 'image' } : null;
function upload(q, r) {
  const tok = String(q.headers['x-token'] || ''), ext = EXT[String(q.headers['content-type'] || '').split(';')[0]];
  const pid = /^[\w-]{16,64}$/.test(tok) && crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
  const u = pid && users.get(pid);
  if (!u || !ext) { r.writeHead(400); return r.end('{}'); }
  if (limited(u, 'up', 20, 3600000)) { r.writeHead(429); return r.end('{}'); }
  const id = rid() + '.' + ext, fp = path.join(UP, id), w = fs.createWriteStream(fp); let n = 0, bad = false;
  q.on('data', d => { n += d.length; if (n > MAXUP && !bad) { bad = true; q.unpipe(w); w.destroy(); fs.unlink(fp, () => {}); r.writeHead(413); r.end('{}'); } });
  q.pipe(w);
  w.on('finish', () => { if (!bad) { db.mo[id] = u.pid; persist(); r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ id })); } });
}
function media(q, r, id, adm) {
  const fp = path.join(UP, id);
  if (db.hm[id] && !adm) { r.writeHead(404); return r.end(); }
  fs.stat(fp, (e, st) => {
    if (e) { r.writeHead(404); return r.end(); }
    const hd = { 'Content-Type': MT[id.split('.')[1]], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
    const rg = /bytes=(\d*)-(\d*)/.exec(q.headers.range || '');
    if (rg) {
      const a = rg[1] ? +rg[1] : 0, b = rg[2] ? Math.min(+rg[2], st.size - 1) : st.size - 1;
      if (a > b) { r.writeHead(416); return r.end(); }
      r.writeHead(206, { ...hd, 'Content-Range': 'bytes ' + a + '-' + b + '/' + st.size, 'Content-Length': b - a + 1 });
      return fs.createReadStream(fp, { start: a, end: b }).pipe(r);
    }
    r.writeHead(200, { ...hd, 'Content-Length': st.size }); fs.createReadStream(fp).pipe(r);
  });
}
const everyone = o => users.forEach(u => u.ws && out(u, o));

// ---- moderação: denúncia oculta na hora; o dono justifica; um admin permite ou remove ----
const ADMIN = process.env.ADMIN_TOKEN || crypto.randomBytes(12).toString('hex');
if (!process.env.ADMIN_TOKEN) console.log('Token de admin (defina ADMIN_TOKEN para fixar): ' + ADMIN + '  | painel em /admin');
const STK = ['🥳','😻','🤣','😭','😡','🥰','😎','🙌','💪','🎉','🔥','💯','🤝','🙈','🍻','🫶','🤔','😴','🤯','👻'];
const msgView = pid => x => x.removed ? { id: x.id, from: x.from, ts: x.ts, removed: true } : x.hidden ? { id: x.id, from: x.from, ts: x.ts, hidden: true, case: x.from === pid ? x.case : undefined } : x;
const medOf = o => o && (o.media || o.photo);
const find = c => c.kind === 'post' ? db.posts.find(x => x.id === c.ref.id) : c.kind === 'story' ? db.stories.find(x => x.id === c.ref.id)
  : c.kind === 'profile' ? db.prof[c.ref.id] : (db.hist[c.ref.k] || []).find(x => x.id === c.ref.id);
function locate(kind, id, me, withPid) {
  const snap = (o, t, md) => ({ o, owner: null, snap: { text: t, media: md } });
  let l = null;
  if (kind === 'post') { const o = db.posts.find(x => x.id === id); if (o) l = { o, owner: o.pid, snap: { text: o.text, media: o.media } }; }
  else if (kind === 'story') { const o = db.stories.find(x => x.id === id); if (o) l = { o, owner: o.pid, snap: { text: o.text, media: o.media } }; }
  else if (kind === 'profile') { const o = db.prof[id]; if (o) l = { o, owner: id, snap: { text: o.bio, media: o.photo } }; }
  else if (kind === 'msg') {
    const w = users.get(withPid); if (!w || !linked.has(key(me.pid, w.pid))) return null;
    const hk = key(me.pid, w.pid), o = (db.hist[hk] || []).find(x => x.id === id);
    if (o) l = { o, owner: o.from, snap: { text: o.text, media: o.media }, ref: { k: hk } };
  }
  return l;
}
function setHid(c, on) {
  const o = find(c); if (!o) return null;
  o.hidden = on || undefined; o.case = on ? c.id : undefined;
  const md = medOf(o); if (md) { if (on) db.hm[md.id] = 1; else delete db.hm[md.id]; }
  return o;
}
function refresh(c, o, removed) {
  const ow = users.get(c.owner);
  if (c.kind === 'post') {
    everyone(removed || o.hidden ? { t: 'postdel', post: c.ref.id } : { t: 'postupd', p: o });
    if (!removed && o.hidden && ow) out(ow, { t: 'postupd', p: o });
  } else if (c.kind === 'msg') c.ref.k.split('|').forEach((pid, i, a) => { const u = users.get(pid); if (u) deliver(u, { t: 'msgmod', with: a[1 - i], m: msgView(pid)(o) }); });
}
function decide(c, action, note) {
  const o = find(c), ow = users.get(c.owner), st = db.strikes;
  c.status = action === 'allow' ? 'allowed' : 'removed'; c.note = clean(note, 300); c.at = Date.now();
  if (o) {
    if (action === 'allow') { setHid(c, false); st.rep[c.reporter] = (st.rep[c.reporter] || 0) + 1; }
    else {
      const md = medOf(o); if (md) { fs.unlink(path.join(UP, md.id), () => {}); delete db.hm[md.id]; }
      if (c.kind === 'post') db.posts.splice(db.posts.indexOf(o), 1);
      else if (c.kind === 'story') db.stories.splice(db.stories.indexOf(o), 1);
      else if (c.kind === 'profile') { o.removed = true; o.photo = null; o.hidden = undefined; }
      else { o.text = ''; o.media = null; o.st = undefined; o.removed = true; o.hidden = undefined; }
      st.own[c.owner] = (st.own[c.owner] || 0) + 1;
      if (st.own[c.owner] >= 3) { db.banned[c.owner] = Date.now(); if (ow && ow.ws) { out(ow, { t: 'err', msg: 'Conta suspensa por violações repetidas.' }); ow.ws.close(); } }
    }
    refresh(c, o, action === 'remove');
  }
  if (ow) deliver(ow, { t: 'info', msg: action === 'allow' ? 'Um moderador liberou seu conteúdo.' : 'Um moderador removeu seu conteúdo por violar as regras.' });
  persist();
}
function admin(q, r, pth) {
  const t = Buffer.from(String(q.headers['x-admin'] || '')), a = Buffer.from(ADMIN);
  const reply = (c, o) => { r.writeHead(c, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
  if (t.length !== a.length || !crypto.timingSafeEqual(t, a)) return reply(401, {});
  if (pth === '/admin/cases') return reply(200, db.cases.slice(-100).reverse());
  if (q.method === 'POST' && pth === '/admin/decide') {
    let b = ''; q.on('data', d => { if (b.length < 10000) b += d; });
    q.on('end', () => {
      try {
        const m = JSON.parse(b), c = db.cases.find(x => x.id === m.case);
        if (!c || !['open', 'justified'].includes(c.status) || !['allow', 'remove'].includes(m.action)) return reply(400, {});
        decide(c, m.action, m.note); reply(200, { ok: 1 });
      } catch { reply(400, {}); }
    });
    return;
  }
  reply(404, {});
}

wss.on('connection', ws => {
  let me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      if (!/^[\w-]{16,64}$/.test(m.tok)) return ws.close();
      const pid = crypto.createHash('sha256').update(m.tok).digest('hex').slice(0, 12);
      if (db.banned[pid]) { out({ ws }, { t: 'err', msg: 'Conta suspensa.' }); return ws.close(); }
      me = users.get(pid) || { pid, lat: null, lng: null, vis: true };
      if (me.ws && me.ws !== ws) me.ws.close();
      me.ws = ws; me.name = clean(m.name, 24) || 'Anônimo';
      users.set(pid, me);
      out(me, { t: 'welcome', id: pid }); out(me, { t: 'following', list: db.follows[pid] || [] }); db.names[pid] = me.name; flush(me); return;
    }
    if (!me) return;
    const lim = LIM[m.t];
    if (lim && limited(me, m.t, lim[0], lim[1])) return m.t === 'pos' ? undefined : out(me, { t: 'err', msg: 'Muitas ações seguidas. Aguarde um pouco.' });
    const to = users.get(m.to);
    switch (m.t) {
      case 'pos':
        if (Math.abs(m.lat) <= 90 && Math.abs(m.lng) <= 180) { me.lat = +m.lat; me.lng = +m.lng; }
        pushAll(); break;
      case 'vis': me.vis = !!m.on; pushAll(); break;
      case 'req': {
        if (!to || to === me || !me.vis || !to.vis || me.lat == null || to.lat == null ||
            dist(me, to) > RADIUS || rel(me, to) !== 'none' || blocked(me.pid, to.pid))
          return out(me, { t: 'err', msg: 'Não foi possível enviar o pedido.' });
        const text = clean(m.text, 200) || 'Oi!';
        reqs.set(me.pid + '>' + to.pid, text); sync();
        out(to, { t: 'req', from: me.pid, name: me.name, text });
        pushAll(); break;
      }
      case 'resp': {
        const k = to && to.pid + '>' + me.pid;
        if (!to || !reqs.has(k)) return;
        const reqText = reqs.get(k); reqs.delete(k);
        if (m.ok) { linked.add(key(me.pid, to.pid)); (db.hist[key(me.pid, to.pid)] = db.hist[key(me.pid, to.pid)] || []).push({ id: rid(), from: to.pid, text: reqText, ts: Date.now() }); }
        deliver(to, { t: m.ok ? 'accepted' : 'declined', from: me.pid, name: me.name }); sync();
        pushAll(); break;
      }
      case 'push': {
        const sb = m.sub;
        if (!sb || typeof sb.endpoint !== 'string' || !sb.endpoint.startsWith('https://') || !sb.keys) return;
        const l = (db.subs[me.pid] || []).filter(x => x.endpoint !== sb.endpoint);
        l.push({ endpoint: sb.endpoint, keys: { p256dh: String(sb.keys.p256dh), auth: String(sb.keys.auth) } });
        db.subs[me.pid] = l.slice(-3); persist(); break;
      }
      case 'flag': {
        const reason = clean(m.reason, 300), l = locate(m.kind, m.id, me, m.with);
        if (!reason || !l || l.owner === me.pid || l.o.hidden || l.o.removed) return;
        const auto = (db.strikes.rep[me.pid] || 0) < 3;   // quem teve 3 denúncias recusadas deixa de ocultar automaticamente
        const c = { id: rid(), kind: m.kind, ref: { id: m.id, k: l.ref && l.ref.k }, owner: l.owner, ownerName: (users.get(l.owner) || {}).name, reporter: me.pid, reporterName: me.name, reason, ts: Date.now(), status: 'open', snap: l.snap, auto };
        db.cases.push(c); if (db.cases.length > 2000) db.cases.shift();
        if (auto) { const o = setHid(c, true); refresh(c, o); const ow = users.get(l.owner); if (ow) deliver(ow, { t: 'review', case: c.id, kind: c.kind }); }
        persist(); out(me, { t: 'info', msg: auto ? 'Denúncia enviada. O conteúdo ficou oculto até a análise de um moderador.' : 'Denúncia enviada para análise.' }); break;
      }
      case 'justify': {
        const c = db.cases.find(x => x.id === m.case), text = clean(m.text, 500);
        if (!c || !text || c.owner !== me.pid || !['open', 'justified'].includes(c.status)) return;
        c.just = text; c.status = 'justified'; persist();
        out(me, { t: 'info', msg: 'Justificativa enviada. Um moderador vai analisar.' }); break;
      }
      case 'follow': {
        if (!to || to === me) return;
        const f = db.follows[me.pid] = db.follows[me.pid] || [], i = f.indexOf(to.pid);
        if (i < 0) f.push(to.pid); else f.splice(i, 1);
        persist(); out(me, { t: 'following', list: f }); break;
      }
      case 'story': {
        const md = okMedia(m.media, me.pid);
        if (!md || db.stories.filter(x => x.pid === me.pid).length >= 20) return;
        db.stories.push({ id: rid(), pid: me.pid, name: me.name, media: md, text: clean(m.text, 200), ts: Date.now(), views: [] });
        persist(); out(me, { t: 'info', msg: 'Story publicado por 24 h.' }); break;
      }
      case 'stories': {
        const old = Date.now() - 86400000;
        db.stories = db.stories.filter(x => { if (x.ts > old || x.hidden) return true; fs.unlink(path.join(UP, x.media.id), () => {}); return false; });
        out(me, { t: 'stories', list: db.stories.filter(x => !blocked(me.pid, x.pid) && (!x.hidden || x.pid === me.pid)).map(x => ({ ...x, views: x.pid === me.pid ? x.views.length : undefined })) }); break;
      }
      case 'sview': {
        const x = db.stories.find(y => y.id === m.id);
        if (x && !x.hidden && !x.views.includes(me.pid) && x.views.length < 500) { x.views.push(me.pid); persist(); } break;
      }
      case 'myprof': { const pr = db.prof[me.pid]; out(me, { t: 'profile', p: pr && !pr.removed ? pr : null }); break; }
      case 'profile': {
        // Modo Match: só para adultos (confirmação de idade declarada pela pessoa).
        const ph = okMedia(m.photo, me.pid);
        if (db.prof[me.pid] && db.prof[me.pid].removed) return out(me, { t: 'err', msg: 'Seu perfil foi removido pela moderação.' });
        if (!m.adult) return out(me, { t: 'err', msg: 'O Match é só para maiores de 18 anos.' });
        if (!ph || ph.kind !== 'image') return out(me, { t: 'err', msg: 'Escolha uma foto de perfil.' });
        db.prof[me.pid] = { pid: me.pid, name: me.name, bio: clean(m.bio, 300), photo: ph, adult: true, ts: Date.now() };
        persist(); out(me, { t: 'profile', p: db.prof[me.pid] }); break;
      }
      case 'deck': {
        if (!db.prof[me.pid] || db.prof[me.pid].removed) return;
        const sw = db.swipes[me.pid] = db.swipes[me.pid] || {};
        const list = Object.values(db.prof).filter(x => x.pid !== me.pid && !(x.pid in sw) && !x.hidden && !x.removed && !blocked(me.pid, x.pid)).map(x => {
          const o = users.get(x.pid), km = o && o.lat != null && me.lat != null ? Math.max(1, Math.round(dist(me, o) / 1000)) : null;
          return { pid: x.pid, name: x.name, bio: x.bio, photo: x.photo, d: km };
        }).sort((a, b) => (a.d == null) - (b.d == null) || a.d - b.d);
        out(me, { t: 'deck', list: list.slice(0, 20) }); break;
      }
      case 'swipe': {
        const mp = db.prof[me.pid], tp = to && db.prof[to.pid];
        if (!mp || mp.removed || !tp || tp.removed || to === me) return;
        const sw = db.swipes[me.pid] = db.swipes[me.pid] || {};
        if (to.pid in sw) return; sw[to.pid] = !!m.like;
        if (m.like && (db.swipes[to.pid] || {})[me.pid]) {   // curtida dos dois lados = match: libera a conversa
          linked.add(key(me.pid, to.pid)); sync();
          deliver(me, { t: 'match', pid: to.pid, name: to.name }); deliver(to, { t: 'match', pid: me.pid, name: me.name });
        }
        persist(); break;
      }
      case 'offsync': {
        // Mensagens trocadas offline: cada celular envia só o que ELE escreveu. A conversa só aparece quando
        // os dois lados declaram ter se conectado (consentimento mútuo); aí as mensagens são unidas por horário.
        const peers = m.peers && typeof m.peers === 'object' ? m.peers : {};
        for (const pid of Object.keys(peers).slice(0, 50)) {
          const o = users.get(pid);
          if (!o || o === me || blocked(me.pid, pid)) continue;
          const k = key(me.pid, pid), list = [], ids = [];
          for (const x of (Array.isArray(peers[pid]) ? peers[pid] : []).slice(0, 200)) {
            const id = String((x && x.id) || ''), text = clean(x && x.t, 1000), md = okMedia(x && x.media, me.pid);
            if (!/^[\w-]{6,40}$/.test(id) || (!text && !md)) continue;
            list.push({ id, from: me.pid, text, media: md, ts: Math.min(+x.ts || Date.now(), Date.now()) }); ids.push(id);
          }
          const merge = arr => {
            const hl = db.hist[k] = db.hist[k] || [], have = new Set(hl.map(y => y.id));
            arr.forEach(y => { if (!have.has(y.id)) { hl.push(y); have.add(y.id); } });
            hl.sort((a, b) => a.ts - b.ts); if (hl.length > 500) hl.splice(0, hl.length - 500);
          };
          if (!linked.has(k)) {
            if (!db.off[k] && Object.keys(db.off).length > 5000) continue;
            const pend = db.off[k] = db.off[k] || {}, cur = pend[me.pid] = pend[me.pid] || [];
            list.forEach(y => { if (!cur.some(z => z.id === y.id)) cur.push(y); });
            if (cur.length > 200) cur.splice(0, cur.length - 200);
            if (!pend[pid]) { out(me, { t: 'offack', pid, ids, linked: false }); continue; }
            linked.add(k); merge(Object.values(pend).flat()); delete db.off[k]; sync();
          } else merge(list);
          out(me, { t: 'offack', pid, ids, linked: true });
        }
        persist(); break;
      }
      case 'hist': {
        const w = users.get(m.with);
        if (!w || !linked.has(key(me.pid, w.pid))) return;
        return out(me, { t: 'hist', with: w.pid, list: (db.hist[key(me.pid, w.pid)] || []).slice(-200).map(msgView(me.pid)) });
      }
      case 'react': {
        if (!to || !linked.has(key(me.pid, to.pid))) return;
        const x = (db.hist[key(me.pid, to.pid)] || []).find(y => y.id === m.mid), em = String(m.emoji || '').slice(0, 8);
        if (!x || !em || x.hidden || x.removed) return;
        x.r = x.r || {}; if (x.r[me.pid] === em) delete x.r[me.pid]; else x.r[me.pid] = em;
        persist(); out(me, { t: 'react', with: to.pid, mid: x.id, r: x.r }); out(to, { t: 'react', with: me.pid, mid: x.id, r: x.r }); break;
      }
      case 'post': {
        const md = okMedia(m.media, me.pid), text = clean(m.text, 1000);
        if (!text && !md) return;
        const p = { id: rid(), pid: me.pid, name: me.name, text, media: md, ts: Date.now(), likes: [], comments: [] };
        db.posts.unshift(p); if (db.posts.length > 2000) db.posts.pop(); persist();
        users.forEach(u => u.ws && !blocked(u.pid, me.pid) && out(u, { t: 'post', p })); break;
      }
      case 'feed': {
        const f = db.follows[me.pid] || [];
        const list = db.posts.filter(p => !blocked(me.pid, p.pid) && (!p.hidden || p.pid === me.pid) && (m.only !== 'following' || p.pid === me.pid || f.includes(p.pid)) && (!m.videos || (p.media && p.media.kind === 'video'))).slice(0, 40);
        out(me, { t: 'feed', videos: !!m.videos, list }); break;
      }
      case 'like': case 'comment': {
        const p = db.posts.find(x => x.id === m.post);
        if (!p || blocked(me.pid, p.pid) || (p.hidden && p.pid !== me.pid)) return;
        if (m.t === 'like') { const i = p.likes.indexOf(me.pid); if (i < 0) p.likes.push(me.pid); else p.likes.splice(i, 1); }
        else { const text = clean(m.text, 300); if (!text) return; p.comments.push({ id: rid(), pid: me.pid, name: me.name, text, ts: Date.now() }); if (p.comments.length > 200) p.comments.shift(); }
        persist(); users.forEach(u => u.ws && !blocked(u.pid, p.pid) && out(u, { t: 'postupd', p })); break;
      }
      case 'delpost': {
        const i = db.posts.findIndex(x => x.id === m.post && x.pid === me.pid);
        if (i < 0) return;
        db.posts.splice(i, 1); persist(); everyone({ t: 'postdel', post: m.post }); break;
      }
      case 'block': {
        if (!to || to === me) return;
        const b = db.blocks[me.pid] = db.blocks[me.pid] || [];
        if (!b.includes(to.pid)) b.push(to.pid);
        linked.delete(key(me.pid, to.pid)); reqs.delete(me.pid + '>' + to.pid); reqs.delete(to.pid + '>' + me.pid);
        sync(); pushAll(); break;
      }
      case 'report':
        if (!to || to === me) return;
        db.reports.push({ from: me.pid, about: to.pid, name: to.name, reason: clean(m.reason, 200), ts: Date.now() });
        if (db.reports.length > 1000) db.reports.shift();
        persist(); out(me, { t: 'info', msg: 'Denúncia enviada. Obrigado.' }); break;
      case 'msg':
        if (!to || !linked.has(key(me.pid, to.pid)))
          return out(me, { t: 'err', msg: 'Conversa não autorizada.' });
        const md = okMedia(m.media, me.pid), msg = { id: rid(), from: me.pid, text: clean(m.text, 1000), media: md, st: STK.includes(m.st) ? m.st : undefined, ts: Date.now() };
        if (!msg.text && !md && !msg.st) return;
        const hk = key(me.pid, to.pid), hl = db.hist[hk] = db.hist[hk] || [];
        hl.push(msg); if (hl.length > 500) hl.shift(); persist();
        deliver(to, { t: 'msg', name: me.name, ...msg });
        out(me, { t: 'sent', to: to.pid, ...msg });
        break;
    }
  });
  ws.on('close', () => { if (me && me.ws === ws) { me.ws = null; pushAll(); } });
});
setInterval(pushAll, 5000);
server.listen(PORT, () => console.log('Perto rodando em http://localhost:' + PORT));
