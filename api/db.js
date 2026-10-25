/* Bếp nhỏ - cầu nối an toàn giữa web và Upstash Redis (chạy trên Vercel).
   Token Upstash nằm trong biến môi trường của Vercel, không bao giờ gửi xuống máy khách.
   - Admin (gửi kèm mật khẩu đã băm): đọc ghi toàn bộ dữ liệu của quán.
   - Khách: chỉ xem thực đơn (không có giá vốn) + liên hệ quán, chỉ đọc đơn của chính mình,
     chỉ tạo đơn mới (giá tính lại theo thực đơn thật) / huỷ đơn đang chờ, và gửi đánh giá. */
const crypto = require('crypto');

const BASE = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const KEYS = new Set(['menu', 'orders', 'reviews', 'exp', 'cfg'].map(t => 'rq:' + t));
const DEFAULT_HASH = crypto.createHash('sha256').update('admin123').digest('hex');

const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function redis(cmds) {
  const r = await fetch(BASE() + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN(), 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('upstash ' + r.status);
  return r.json();
}
const one = async cmd => (await redis([cmd]))[0].result;
const toMap = arr => { const m = {}; for (let i = 0; i < (arr || []).length; i += 2) m[arr[i]] = arr[i + 1]; return m; };

let passCache = { v: '', t: 0 };
async function adminHash() {
  if (Date.now() - passCache.t < 20000) return passCache.v;
  const rec = parse(await one(['HGET', 'rq:cfg', 'pass']));
  passCache = { v: rec && rec.v ? rec.v : DEFAULT_HASH, t: Date.now() };
  return passCache.v;
}
async function isAdmin(h) {
  if (typeof h !== 'string' || h.length !== 64) return false;
  return same(h, await adminHash());
}

function adminOk(c) {
  if (!Array.isArray(c)) return false;
  const op = String(c[0]).toUpperCase();
  if (op === 'HGETALL') return c.length === 2 && KEYS.has(c[1]);
  if (op === 'HSET') return c.length === 4 && KEYS.has(c[1]) && typeof c[2] === 'string' && c[2].length <= 120 && typeof c[3] === 'string' && c[3].length <= 1500000;
  if (op === 'GET') return c.length === 2 && c[1] === 'rq:ver';
  if (op === 'SET') return c.length === 3 && c[1] === 'rq:ver' && typeof c[2] === 'string' && c[2].length <= 40;
  return false;
}

async function saveOrder(id, value) {
  const inc = parse(value);
  if (!inc || inc.id !== id || !/^[a-z0-9]{6,40}$/.test(id)) return { error: 'denied' };
  const ex = parse(await one(['HGET', 'rq:orders', id]));
  if (ex) { // khách chỉ được huỷ đơn của mình khi quán chưa xử lý
    if (ex.status === 'pending' && !ex.del && inc.del === true) {
      ex.del = true; ex.u = Number(inc.u) || Date.now();
      await one(['HSET', 'rq:orders', id, JSON.stringify(ex)]);
      return { result: 1 };
    }
    return { error: 'denied' };
  }
  const menu = toMap(await one(['HGETALL', 'rq:menu']));
  const items = [];
  for (const it of (Array.isArray(inc.items) ? inc.items : []).slice(0, 40)) {
    const m = parse(menu[it && it.id]); const qty = parseInt(it && it.qty, 10);
    if (!m || m.del || m.on === false || !(qty >= 1 && qty <= 99)) return { error: 'denied' };
    items.push({ id: m.id, name: m.name, price: +m.price, cost: +m.cost || 0, qty, note: str(it.note, 200) });
  }
  const name = str(inc.name, 80), addr = str(inc.addr, 300), phone = str(inc.phone, 20);
  if (!items.length || !name || !addr || !phone) return { error: 'denied' };
  const order = {
    id, date: /^\d{4}-\d{2}-\d{2}$/.test(inc.date) ? inc.date : new Date().toISOString().slice(0, 10),
    time: /^\d{2}:\d{2}$/.test(inc.time) ? inc.time : '00:00',
    name, phone, mood: str(inc.mood, 40), items, addr, note: str(inc.note, 500),
    total: items.reduce((s, i) => s + i.price * i.qty, 0),
    status: 'pending', shipper: '', adminNote: '', u: Number(inc.u) || Date.now()
  };
  await one(['HSET', 'rq:orders', id, JSON.stringify(order)]);
  return { result: 1 };
}

async function saveReview(id, value) {
  const inc = parse(value);
  if (!inc || inc.id !== id || !/^[a-z0-9]{6,40}$/.test(id)) return { error: 'denied' };
  if (await one(['HGET', 'rq:reviews', id])) return { error: 'denied' };
  const text = str(inc.text, 2000); if (!text) return { error: 'denied' };
  await one(['HSET', 'rq:reviews', id, JSON.stringify({
    id, name: str(inc.name, 60) || 'Ẩn danh', text,
    date: /^\d{4}-\d{2}-\d{2}$/.test(inc.date) ? inc.date : '', time: /^\d{2}:\d{2}$/.test(inc.time) ? inc.time : '',
    read: false, u: Number(inc.u) || Date.now()
  })]);
  return { result: 1 };
}

async function guest(c, myIds) {
  if (!Array.isArray(c)) return { error: 'denied' };
  const op = String(c[0]).toUpperCase(), key = c[1];
  if (op === 'GET' && key === 'rq:ver') return { result: await one(c) };
  if (op === 'SET' && key === 'rq:ver' && typeof c[2] === 'string' && c[2].length <= 40) return { result: await one(c) };
  if (op === 'HGETALL' && KEYS.has(key)) {
    const arr = (await one(['HGETALL', key])) || [], out = [];
    for (let i = 0; i < arr.length; i += 2) {
      const f = arr[i], v = arr[i + 1];
      if (key === 'rq:menu') { const m = parse(v); if (m) { delete m.cost; out.push(f, JSON.stringify(m)); } }
      else if (key === 'rq:cfg') { if (f === 'contact') out.push(f, v); }
      else if (key === 'rq:orders') { if (myIds.has(f)) out.push(f, v); }
    }
    return { result: out };
  }
  if (op === 'HSET' && c.length === 4 && typeof c[2] === 'string' && typeof c[3] === 'string' && c[3].length <= 20000) {
    if (key === 'rq:orders') return saveOrder(c[2], c[3]);
    if (key === 'rq:reviews') return saveReview(c[2], c[3]);
  }
  return { error: 'denied' };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!BASE() || !TOKEN()) {
    if (req.method === 'GET') return res.status(200).json({ ok: true, ready: false });
    return res.status(500).json({ error: 'no-db' });
  }
  if (req.method === 'GET') return res.status(200).json({ ok: true, ready: true });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  let cmds = req.body;
  if (typeof cmds === 'string') cmds = parse(cmds);
  if (!Array.isArray(cmds) || cmds.length > 1000) return res.status(400).json({ error: 'bad-request' });
  try {
    if (await isAdmin(req.headers['x-admin'])) {
      const idx = [], valid = [];
      cmds.forEach((c, i) => { if (adminOk(c)) { idx.push(i); valid.push(c); } });
      const out = cmds.map(() => ({ error: 'denied' }));
      if (valid.length) (await redis(valid)).forEach((r, k) => { out[idx[k]] = r; });
      if (valid.some(c => String(c[0]).toUpperCase() === 'HSET' && c[1] === 'rq:cfg' && c[2] === 'pass')) passCache.t = 0;
      return res.status(200).json({ admin: true, out });
    }
    const myIds = new Set(String(req.headers['x-orders'] || '').split(',').filter(Boolean).slice(0, 60));
    const out = [];
    for (const c of cmds.slice(0, 200)) out.push(await guest(c, myIds).catch(() => ({ error: 'fail' })));
    return res.status(200).json({ admin: false, out });
  } catch (e) {
    return res.status(502).json({ error: 'upstream' });
  }
};
