/* Bếp nhỏ - logic ứng dụng (đặt món, quản trị, đồng bộ Upstash) */
/* Mã đồng bộ: dán mã vào đây để mọi thiết bị tự kết nối (hoặc nhập trong Admin > Cài đặt) */
const SYNC_CODE = '';

const T = ['menu','orders','reviews','exp','cfg'];
const MOODS = [['😄','Vui vẻ'],['🥰','Hạnh phúc'],['😌','Bình yên'],['😴','Mệt mỏi'],['😢','Buồn'],['😤','Căng thẳng']];
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => (Math.round(n)||0).toLocaleString('vi-VN') + 'đ';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const pad = n => String(n).padStart(2,'0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
const live = t => Object.values(S[t]).filter(x => !x.del);

let S = {menu:{},orders:{},reviews:{},exp:{},cfg:{}};
try { const l = JSON.parse(localStorage.getItem('rq_data')); if (l) S = {...S, ...l}; } catch(e){}
const save = () => { try { localStorage.setItem('rq_data', JSON.stringify(S)); } catch(e){} };
const decodeCode = c => { try { const [url,token] = atob(String(c).trim()).split('|'); return url && token ? {url:url.replace(/\/$/,''), token} : null; } catch(e){ return null; } };
try { const p = new URLSearchParams(location.search).get('code'); if (p && decodeCode(p)) { localStorage.setItem('rq_code', p.replace(/ /g,'+')); history.replaceState(null,'',location.pathname); } } catch(e){}
const getCode = () => localStorage.getItem('rq_code') || SYNC_CODE;
let API = false, adminKey = '';   /* API = đang chạy trên Vercel có /api/db */
let myOrders = []; try { myOrders = JSON.parse(localStorage.getItem('rq_my')) || []; } catch(e){}
let pu = {}; try { pu = JSON.parse(localStorage.getItem('rq_pu')) || {}; } catch(e){}
const up = () => API ? {url:'/api/db', token:'', api:true} : (decodeCode(getCode()) || {url:'',token:''});

let role = null, view = 'orders', cview = 'menu', sync_state = 'off';
let C = {qty:{}, notes:{}, mood:'', name:'', phone:'', addr:'', note:''};
let F = {date: today(), status:'all', from: today().slice(0,8)+'01', to: today()};

/* ---------- Đám mây ---------- */
async function pipe(cmds){
  const u = up(); if (!u.url) throw 'no-up';
  if (u.api) {
    for (let a = 0; a < 3; a++) {
      const h = {'Content-Type':'application/json'};
      if (adminKey) h['x-admin'] = adminKey; else if (myOrders.length) h['x-orders'] = myOrders.slice(-40).join(',');
      const r = await fetch(u.url, {method:'POST', headers:h, body:JSON.stringify(cmds)});
      if (!r.ok) throw 'http ' + r.status;
      const j = await r.json();
      if (adminKey && !j.admin) {
        if (a < 2) { await new Promise(f => setTimeout(f, 2500)); continue; }
        adminKey = ''; role = null; toast('Phiên admin hết hiệu lực, hãy đăng nhập lại', true); render(); throw 'auth';
      }
      return j.out;
    }
  }
  const r = await fetch(u.url + '/pipeline', {method:'POST', headers:{Authorization:'Bearer '+u.token}, body:JSON.stringify(cmds)});
  if (!r.ok) throw 'http ' + r.status;
  return r.json();
}
async function put(t, rec){
  rec.u = Date.now(); S[t][rec.id] = rec; save();
  try { await pipe([['HSET','rq:'+t, rec.id, JSON.stringify(rec)], ['SET','rq:ver', String(Date.now())]]); setSync('ok'); if (up().api && !adminKey) markPushed([[t+'/'+rec.id, rec.u]]); } catch(e){ pending = true; setSync(up().url ? 'err' : 'off'); }
}
function setSync(s){ sync_state = s; const e = $('#sync'); if (e) e.innerHTML = syncHtml(); }
const syncHtml = () => `<span class="dot ${sync_state}"></span> ${{ok:'Đã đồng bộ',err:'Chưa đồng bộ (sẽ thử lại)',off:'Chưa kết nối đám mây'}[sync_state]||'Đang đồng bộ…'}`;
let lastVer = null, pending = false, tick = 0;
function markPushed(list){ list.forEach(([k,u]) => pu[k] = u); try { localStorage.setItem('rq_pu', JSON.stringify(pu)); } catch(e){} }
async function sync(force){
  if (!up().url) return setSync('off');
  try {
    if (!force && !pending && lastVer !== null) {   /* chỉ 1 lệnh GET khi không có gì mới */
      const v = (await pipe([['GET','rq:ver']]))[0].result;
      if (v === lastVer) return setSync('ok');
    }
    setSync('...');
    const res = await pipe(T.map(t => ['HGETALL','rq:'+t]).concat([['GET','rq:ver']]));
    const push = [], marks = []; let newOrders = 0, guestMode = up().api && !adminKey;
    T.forEach((t,i) => {
      const arr = res[i].result || [], cloud = {};
      for (let k=0;k<arr.length;k+=2) cloud[arr[k]] = JSON.parse(arr[k+1]);
      for (const id in cloud) if (!S[t][id] || cloud[id].u > S[t][id].u) { if (t==='orders' && !S[t][id]) newOrders++; S[t][id] = cloud[id]; }
      for (const id in S[t]) { const l = S[t][id], c = cloud[id];
        if ((c ? l.u > c.u : true) && (!guestMode || (pu[t+'/'+id]||0) < l.u)) { push.push(['HSET','rq:'+t, id, JSON.stringify(l)]); marks.push([t+'/'+id, l.u]); } }
    });
    let ver = res[T.length].result;
    if (push.length) { ver = String(Date.now()); await pipe(push.concat([['SET','rq:ver',ver]])); if (guestMode) markPushed(marks); }
    lastVer = ver; pending = false;
    save(); setSync('ok');
    if (role==='admin' && newOrders) toast(`Có ${newOrders} đơn mới`);
    if (role && (!document.activeElement || !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))) render();
  } catch(e){ pending = true; setSync('err'); }
}
setInterval(() => { if (document.visibilityState!=='visible') return; tick++; if (role==='admin' || cview==='done' || tick%4===0) sync(); }, 15000);

function toast(m, err){ const d = document.createElement('div'); d.className='toast' + (err ? ' err' : ''); d.textContent=m; document.body.append(d); setTimeout(()=>d.remove(),2600); }
async function sha(s){ try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); } catch(e){ return s; } }

/* ---------- Dữ liệu mặc định ---------- */
const IMG_BO = 'img/com-bo.jpg', IMG_GA = 'img/com-ga.jpg';
function seed(){
  if (API && !adminKey) return;
  if (up().url && sync_state !== 'ok') return;
  const ms = Object.values(S.menu), isPh = m => /^Món đặc trưng số/.test(m.name) && !m.img;
  ms.filter(m => !m.del && isPh(m)).forEach(m => put('menu', {...m, del:true}));
  const real = ms.filter(m => !m.del && !isPh(m));
  if (!real.length && !S.menu.m_bo && !S.menu.m_ga) {
    S.menu.m_bo = {id:'m_bo',name:'Cơm bò',price:45000,cost:0,emoji:'🍚',img:IMG_BO,on:true,u:1};
    S.menu.m_ga = {id:'m_ga',name:'Cơm gà',price:45000,cost:0,emoji:'🍗',img:IMG_GA,on:true,u:1};
    save(); pending = true; sync(true);
  }
}

let lastId = (()=>{ try { return localStorage.getItem('rq_last') || ''; } catch(e){ return ''; } })(), D = {}, A = {img:''}, _cf = null;
function ask(msg, fn, label='Xoá'){
  _cf = fn; const d = document.createElement('div'); d.className='modal'; d.id='ask';
  d.innerHTML = `<div class="card"><h3 style="font-size:26px">Xác nhận</h3><p>${esc(msg)}</p><div class="row"><button class="btn ghost" onclick="$('#ask').remove()">Không</button><button class="btn" style="background:var(--rose);color:#fff" onclick="$('#ask').remove();_cf&&_cf()">${esc(label)}</button></div></div>`;
  document.body.append(d);
}
function showText(t){ const d=document.createElement('div'); d.className='modal'; d.id='ask'; d.innerHTML=`<div class="card"><h3 style="font-size:26px">Sao chép link</h3><input id="lk" readonly value="${esc(t)}" style="margin:10px 0"><button class="btn" onclick="$('#ask').remove()">Xong</button></div>`; document.body.append(d); $('#lk').select(); }
function delOrder(id){ const o=S.orders[id]; ask(`Xoá đơn của ${o.name} (${money(o.total)})? Không thể hoàn tác.`, () => { upd(id,'del',true,1); toast('Đã xoá đơn'); }, 'Xoá đơn'); }
function delExp(id){ const e=S.exp[id]; ask(`Xoá khoản chi ${money(e.amount)}${e.note?' - '+e.note:''}?`, () => { put('exp',{...e,del:true}); render(); toast('Đã xoá khoản chi'); }); }
function delReview(id){ ask('Xoá đánh giá này?', () => { put('reviews',{...S.reviews[id],del:true}); render(); }); }
function readAll(){ live('reviews').filter(r=>!r.read).forEach(r=>put('reviews',{...r,read:true})); render(); }
function clearCart(){ ask('Bỏ tất cả món đã chọn?', () => { C.qty={}; C.notes={}; render(); }, 'Bỏ hết'); }
function ask1(id){ ask(`Bỏ "${S.menu[id].name}" khỏi đơn?`, () => { C.qty[id]=0; delete C.notes[id]; render(); }, 'Bỏ món'); }
function cancelBtn(){ const o=S.orders[lastId]; return o && !o.del && o.status==='pending' ? '<button class="btn rose" style="margin-right:8px" onclick="cancelMine()">Huỷ đơn này</button>' : ''; }
function cancelMine(){ ask('Huỷ đơn bạn vừa đặt?', () => { const o=S.orders[lastId]; if (!o || o.status!=='pending') return toast('Quán đã nhận đơn, không huỷ được'); put('orders',{...o,del:true}); lastId=''; toast('Đã huỷ đơn'); cview='menu'; render(); }, 'Huỷ đơn'); }

/* ---------- Khung ---------- */
function render(){
  document.body.classList.toggle('in', !!role);
  if (!role) return $('#app').innerHTML = loginHtml();
  $('#app').innerHTML = role==='admin' ? adminHtml() : custHtml();
}
const LOGO = '<svg class="logo" viewBox="0 0 64 44" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 24 32 5l26 19"/><path d="M47 13V6h5v11"/><path d="M24 37v-6a5 5 0 0 1 2-9 6 6 0 0 1 12 0 5 5 0 0 1 2 9v6z"/></svg>';
function topbar(title, extra=''){
  return `<div class="top">${LOGO}<h1 class="brand">Bếp nhỏ<span class="sub">${title}</span></h1><span class="mute" id="sync">${syncHtml()}</span>${extra}<button class="btn ghost sm" onclick="logout()">Thoát</button></div>`;
}
async function logout(){
  if (adminKey) { await sync(true); if (sync_state === 'ok' && !pending) { S = {menu:{},orders:{},reviews:{},exp:{},cfg:{}}; pu = {}; save(); markPushed([]); lastVer = null; } adminKey = ''; }
  role=null; C={qty:{},notes:{},mood:'',name:'',phone:'',addr:'',note:''}; cview='menu'; render(); }

/* ---------- Đăng nhập ---------- */
function loginHtml(){
  return `<div class="center"><div style="color:var(--gold);display:flex;justify-content:center">${LOGO.replace('class="logo"','class="logo" style="width:96px;height:66px"')}</div>
  <h1 class="brand" style="font-size:68px;line-height:1.05">Bếp nhỏ</h1><div class="tagline">Cơm ngon - Ấm bụng - Hạnh phúc</div>
  <div class="mute" style="margin-top:14px">Chọn vai trò để bắt đầu</div>
  <div class="choice"><div class="card" onclick="enterCustomer()">🍚<br>Khách hàng</div>
  <div class="card" onclick="askAdmin()">🔑<br>Admin</div></div>
  <div id="adm" style="display:none;margin-top:18px;text-align:left"><label>Mật khẩu admin</label>
  <input type="password" id="pw" onkeydown="if(event.key==='Enter')loginAdmin()" autocomplete="current-password">
  <button class="btn" style="margin-top:12px;width:100%" onclick="loginAdmin()">Đăng nhập</button></div></div>`;
}
async function loginAdmin(){
  const h = await sha($('#pw').value);
  if (up().api) {
    let ok = false;
    try { const r = await fetch('/api/db', {method:'POST', headers:{'Content-Type':'application/json','x-admin':h}, body:'[]'}); ok = (await r.json()).admin === true; }
    catch(e){ return toast('Cần có mạng để đăng nhập admin', true); }
    if (!ok) { toast('Sai mật khẩu', true); $('#pw').value=''; return; }
    adminKey = h; S.menu = {}; S.cfg = {}; lastVer = null; role = 'admin'; view = 'orders'; render();
    sync(true).then(() => { seed(); render(); });
    return;
  }
  const stored = S.cfg.pass ? S.cfg.pass.v : await sha('admin123');
  if (h === stored) { role='admin'; view='orders'; render(); sync(); } else { toast('Sai mật khẩu'); $('#pw').value=''; }
}
function loadMe(){ try { const m = JSON.parse(localStorage.getItem('rq_cust')); if (m) { C.name = C.name || m.name || ''; C.phone = C.phone || m.phone || ''; C.addr = C.addr || m.addr || ''; } } catch(e){} }
function enterCustomer(){ role='customer'; cview='menu'; loadMe(); render(); sync(); }
function askAdmin(){ $('#adm').style.display='block'; $('#pw').focus(); }

/* ================= KHÁCH HÀNG ================= */
function custHtml(){
  const tabs = `<div class="tabs"><div class="tab ${cview==='menu'||cview==='mood'||cview==='info'?'on':''}" onclick="cview='menu';render()">Gọi món</div><div class="tab ${cview==='review'?'on':''}" onclick="cview='review';render()">Hòm thư góp ý</div></div>`;
  if (cview==='review') return topbar('Hòm thư góp ý') + tabs + reviewHtml();
  if (cview==='done') {
    const o = S.orders[lastId], ok = o && !o.del, fin = ok && o.status==='done';
    return topbar('Cảm ơn bạn') + `<div class="center card"><div style="font-size:54px">${fin?'🎉':'✅'}</div><h2>Đã nhận đơn của bạn</h2>
    ${ok?`<div class="tag ${fin?'done':''}" style="font-size:14px;padding:4px 14px">${fin?'✅ Đơn đã được xử lý':'⏳ Quán đang chuẩn bị'}</div>${o.shipper?`<p>Người giao: <b>${esc(o.shipper)}</b></p>`:''}
    <div class="lines" style="margin:14px 0;text-align:left">${o.items.map(i=>`${i.qty} × ${esc(i.name)}`).join('<br>')}<div class="price" style="margin-top:6px"><b>${money(o.total)}</b></div></div>`:''}
    <p class="mute">Trạng thái tự cập nhật, bạn không cần tải lại trang.</p>${contactHtml()}${cancelBtn()}<button class="btn" onclick="cview='menu';render()">Đặt thêm</button></div>`;
  }
  if (cview==='mood') return topbar('Hôm nay bạn thế nào?') + moodHtml();
  if (cview==='info') return topbar('Thông tin giao hàng') + infoHtml();
  const items = live('menu');
  const cards = items.map(m => {
    const q = C.qty[m.id]||0;
    return `<div class="card dish"><div class="img">${m.img?`<img src="${m.img}" alt="${esc(m.name)}">`:esc(m.emoji||'🍽️')}</div>
    <div class="body"><h3 style="font-size:24px">${esc(m.name)}</h3><div class="price">${money(m.price)}</div>
    ${m.on===false?'<span class="tag">Tạm hết</span>':`<div class="qty"><button onclick="chg('${m.id}',-1)">−</button><b>${q}</b><button onclick="chg('${m.id}',1)">+</button>${q?`<button class="btn rose sm" style="margin-left:auto" onclick="ask1('${m.id}')">Bỏ món</button>`:''}</div>
    ${q?`<input placeholder="Lưu ý cho món này (ít cay, không hành…)" value="${esc(C.notes[m.id]||'')}" oninput="C.notes['${m.id}']=this.value"><div class="chips">${QN.map(t=>`<span class="chip ${(C.notes[m.id]||'').includes(t)?'on':''}" onclick="addNote('${m.id}','${t}')">${t}</span>`).join('')}</div>`:''}`}</div></div>`;
  }).join('');
  return topbar('Thực đơn hôm nay') + tabs + contactHtml() + trackBanner() + (items.length ? `<div class="grid menu">${cards}</div>` : '<p class="mute">Quán chưa có món nào.</p>') + cartBar();
}
function trackBanner(){
  const o = S.orders[lastId]; if (!o || o.del || o.date !== today()) return '';
  return `<div class="card" style="margin-bottom:14px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px"><span>Đơn gần nhất lúc ${o.time}: ${o.status==='done'?'✅ đã xử lý':'⏳ đang chuẩn bị'}</span><button class="btn ghost sm" onclick="cview='done';render()">Xem</button></div>`;
}
const digits = p => String(p||'').replace(/[^\d+]/g,'');
function contactHtml(){
  const c = S.cfg.contact; if (!c || !c.phone) return '';
  return `<div class="contact"><span class="mute">Cần hỗ trợ?</span><a class="btn sm" href="tel:${digits(c.phone)}">📞 Gọi quán</a><a class="btn sage sm" href="https://zalo.me/${digits(c.zalo||c.phone)}" target="_blank" rel="noopener">💬 Nhắn Zalo</a></div>`;
}
const QN = ['Ít cay','Không hành','Không rau','Ít cơm','Thêm cơm'];
function addNote(id,t){ const a=(C.notes[id]||'').split(',').map(x=>x.trim()).filter(Boolean), k=a.indexOf(t); k>=0 ? a.splice(k,1) : a.push(t); C.notes[id]=a.join(', '); render(); }
const cartInfo = () => { let n=0,t=0; live('menu').forEach(m => { const q=C.qty[m.id]||0; n+=q; t+=q*m.price; }); return {n,t}; };
function cartBar(){ const {n,t} = cartInfo(); return `<div class="bar"><div class="row" style="flex:none;gap:12px"><span><b>${n}</b> món · <span class="price">${money(t)}</span></span>${n?'<button class="btn rose sm" style="flex:none;min-width:0" onclick="clearCart()">Xoá giỏ</button>':''}</div><button class="btn" ${n?'':'disabled style="opacity:.4"'} onclick="cview='mood';render()">Tiếp tục</button></div>`; }
function chg(id,d){ C.qty[id] = Math.max(0,(C.qty[id]||0)+d); render(); }
function moodHtml(){
  return `<p class="mute">Cho quán biết để món ăn thêm phần ấm áp nhé.</p><div class="moods">${MOODS.map(([e,l]) => `<div class="mood ${C.mood===e+' '+l?'on':''}" onclick="C.mood='${e} ${l}';render()"><i>${e}</i>${l}</div>`).join('')}</div>
  <div class="row" style="margin-top:20px;flex:none"><button class="btn ghost" style="flex:none" onclick="cview='menu';render()">Quay lại</button><button class="btn" style="flex:none" ${C.mood?'':'disabled style="opacity:.4"'} onclick="cview='info';render()">Tiếp tục</button></div>`;
}
function infoHtml(){
  return `<div class="card" style="max-width:520px"><div class="mute">Các mục có dấu <span style="color:var(--rose)">*</span> là bắt buộc.</div>
  <label>Tên của bạn <span class="req">*</span></label><input id="f_name" value="${esc(C.name)}" oninput="C.name=this.value;this.classList.remove('bad')">
  <label>Số điện thoại <span class="req">*</span></label><input id="f_phone" type="tel" inputmode="tel" value="${esc(C.phone)}" oninput="C.phone=this.value;this.classList.remove('bad')">
  <label>Địa chỉ nhận món <span class="req">*</span></label><textarea id="f_addr" placeholder="Số nhà, đường, phường/xã…" oninput="C.addr=this.value;this.classList.remove('bad')">${esc(C.addr)}</textarea>
  <label>Ghi chú thêm (không bắt buộc)</label><textarea oninput="C.note=this.value">${esc(C.note)}</textarea>
  <label style="display:flex;gap:8px;align-items:center;color:var(--text);font-size:14px;margin-top:12px"><input type="checkbox" style="width:auto" ${C.remember!==false?'checked':''} onchange="C.remember=this.checked"> Nhớ thông tin này cho lần đặt sau</label>
  <div class="row" style="margin-top:16px"><button class="btn ghost" onclick="cview='mood';render()">Quay lại</button><button class="btn" onclick="confirmOrder()">Xem lại đơn</button></div></div>`;
}
const phoneOk = p => /^(\+?84|0)\d{8,10}$/.test(String(p).replace(/[\s.\-()]/g,''));
function missing(){
  const m = [];
  if (!live('menu').some(x => C.qty[x.id] > 0)) m.push(['', 'Chưa chọn món nào']);
  if (!C.mood) m.push(['', 'Chưa chọn tâm trạng']);
  if (!C.name.trim()) m.push(['f_name', 'Vui lòng nhập tên']);
  if (!C.phone.trim()) m.push(['f_phone', 'Vui lòng nhập số điện thoại']);
  else if (!phoneOk(C.phone)) m.push(['f_phone', 'Số điện thoại chưa đúng (ví dụ 0901234567)']);
  if (C.addr.trim().length < 5) m.push(['f_addr', 'Vui lòng nhập địa chỉ đầy đủ']);
  return m;
}
function confirmOrder(){
  const miss = missing();
  if (miss.length) {
    document.querySelectorAll('.bad').forEach(e => e.classList.remove('bad'));
    miss.forEach(([id]) => id && $('#'+id).classList.add('bad'));
    const first = miss.find(x => x[0]);
    if (first) $('#'+first[0]).focus();
    return toast(miss[0][1], true);
  }
  const {t} = cartInfo();
  const lines = live('menu').filter(m=>C.qty[m.id]).map(m => `<div>${C.qty[m.id]} × ${esc(m.name)} <span class="mute">${C.notes[m.id]?'— '+esc(C.notes[m.id]):''}</span></div>`).join('');
  const d = document.createElement('div'); d.className='modal'; d.id='cm';
  d.innerHTML = `<div class="card"><h2>Xác nhận đặt món</h2><div class="lines" style="margin:12px 0">${lines}</div>
  <div><b>${esc(C.name)}</b> · ${esc(C.phone)}</div><div class="mute">📍 ${esc(C.addr)}</div><div class="mute">Tâm trạng: ${esc(C.mood)}</div>${C.note?`<div class="mute">📝 ${esc(C.note)}</div>`:''}
  <h3 style="margin:12px 0;font-size:26px" class="price">Tổng: ${money(t)}</h3>
  <div class="row"><button class="btn ghost" onclick="$('#cm').remove()">Sửa lại</button><button class="btn" onclick="submitOrder()">Chắc chắn đặt món</button></div></div>`;
  document.body.append(d);
}
async function submitOrder(){
  $('#cm')?.remove();
  const miss = missing(); if (miss.length) { cview = C.mood ? 'info' : 'mood'; render(); return toast(miss[0][1], true); }
  const items = live('menu').filter(m=>C.qty[m.id]).map(m => ({id:m.id,name:m.name,price:m.price,cost:+m.cost||0,qty:C.qty[m.id],note:C.notes[m.id]||''}));
  const now = new Date();
  const o = {id:uid(), date:dstr(now), time:`${pad(now.getHours())}:${pad(now.getMinutes())}`, name:C.name.trim(), phone:C.phone.trim(), mood:C.mood, items, addr:C.addr.trim(), note:C.note.trim(), total:items.reduce((s,i)=>s+i.price*i.qty,0), status:'pending', shipper:'', adminNote:''};
  try { if (C.remember !== false) localStorage.setItem('rq_cust', JSON.stringify({name:C.name,phone:C.phone,addr:C.addr})); else localStorage.removeItem('rq_cust'); } catch(e){}
  C = {qty:{},notes:{},mood:'',name:'',phone:'',addr:'',note:''}; loadMe();
  lastId=o.id; myOrders.push(o.id); try { localStorage.setItem('rq_last', lastId); localStorage.setItem('rq_my', JSON.stringify(myOrders.slice(-60))); } catch(e){} const pr = put('orders', o); cview='done'; render();
  await pr;
}
function reviewHtml(){
  return `<div class="card" style="max-width:560px;margin:auto"><div class="quote">“Đánh giá của bạn là bài học của bọn mình”</div>
  <label>Tên (có thể bỏ trống)</label><input id="rn"><label>Trải nghiệm của bạn</label><textarea id="rt" style="min-height:120px"></textarea>
  <button class="btn" style="margin-top:14px;width:100%" onclick="sendReview()">Gửi đánh giá</button></div>`;
}
async function sendReview(){
  const text = $('#rt').value.trim(); if (!text) return toast('Hãy viết vài dòng nhé');
  const r = {id:uid(), name:$('#rn').value.trim()||'Ẩn danh', text, date:today(), time:new Date().toTimeString().slice(0,5), read:false};
  $('#rt').value=''; toast('Đã gửi. Cảm ơn bạn!'); await put('reviews', r);
}

/* ================= ADMIN ================= */
function adminHtml(){
  const unread = live('reviews').filter(r=>!r.read).length;
  const tabs = [['orders','Đơn hàng'],['menu','Thực đơn'],['stats','Thống kê'],['analysis','Phân tích'],['inbox','Hòm thư'+(unread?` (${unread})`:'')],['settings','Cài đặt']];
  return topbar('Quản lý quán') + `<div class="tabs">${tabs.map(([k,l]) => `<div class="tab ${view===k?'on':''}" onclick="view='${k}';render()">${l}</div>`).join('')}</div>` + ({orders:ordersHtml,menu:menuAdminHtml,stats:statsHtml,analysis:analysisHtml,inbox:inboxHtml,settings:settingsHtml}[view])();
}
const ordersOn = d => live('orders').filter(o => o.date===d).sort((a,b)=>b.time.localeCompare(a.time));
function ordersHtml(){
  const all = ordersOn(F.date), list = all.filter(o => F.status==='all' || o.status===F.status);
  const done = all.filter(o=>o.status==='done');
  const dishes = {}; all.forEach(o=>o.items.forEach(i=>dishes[i.name]=(dishes[i.name]||0)+i.qty));
  const ships = (S.cfg.shippers?.v||[]).map(s=>`<option value="${esc(s)}">`).join('');
  return `<div class="row" style="margin-bottom:14px;flex:none"><div style="flex:none"><input type="date" value="${F.date}" onchange="F.date=this.value;render()"></div>
  <div style="flex:none"><select onchange="F.status=this.value;render()">${[['all','Tất cả'],['pending','Chờ xử lý'],['done','Đã xử lý']].map(([v,l])=>`<option value="${v}" ${F.status===v?'selected':''}>${l}</option>`).join('')}</select></div>
  <button class="btn ghost sm" style="flex:none" onclick="sync(true);toast('Đang đồng bộ…')">Làm mới</button></div>
  <div class="grid stats"><div class="card stat"><b>${all.length}</b><span>Đơn trong ngày</span></div><div class="card stat"><b>${new Set(all.map(o=>o.name.toLowerCase()+o.phone)).size}</b><span>Khách đặt</span></div>
  <div class="card stat"><b>${done.length}/${all.length}</b><span>Đã xử lý</span></div><div class="card stat"><b>${money(done.reduce((s,o)=>s+o.total,0))}</b><span>Tiền thu (đơn xong)</span></div>
  <div class="card stat"><b>${money(done.reduce((s,o)=>s+o.total-orderCost(o),0))}</b><span>Lãi gộp (đơn xong)</span></div>
  <div class="card stat"><b>${money(all.filter(o=>o.status!=='done').reduce((s,o)=>s+o.total,0))}</b><span>Đang chờ</span></div></div>
  ${Object.keys(dishes).length?`<p class="mute">Món đã đặt: ${Object.entries(dishes).map(([n,q])=>`${esc(n)} ×${q}`).join(' · ')}</p>`:''}
  <datalist id="ships">${ships}</datalist>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(330px,1fr))">${list.map(o => `<div class="card order ${o.status}">
    <div class="oh"><b class="nm">${esc(o.name)}</b><a class="ph" href="tel:${esc(o.phone)}">${esc(o.phone)}</a><span class="mute">${o.time}</span><span class="tag ${o.status==='done'?'done':''}">${o.status==='done'?'Đã xử lý':'Chờ xử lý'}</span></div>
    <div class="it">${o.items.map(i=>`<b>${i.qty}×</b> ${esc(i.name)}${i.note?` <em>(${esc(i.note)})</em>`:''}`).join(' &nbsp;+&nbsp; ')}</div>
    <div class="ad">📍 ${esc(o.addr)}</div>
    <div class="mute">${esc(o.mood)}${o.note?' · 📝 '+esc(o.note):''}</div>
    <div class="of"><b class="price tot">${money(o.total)}</b><span class="mute" style="white-space:nowrap">lãi ${money(o.total-orderCost(o))}</span><input list="ships" placeholder="Người ship" value="${esc(o.shipper)}" onchange="upd('${o.id}','shipper',this.value)"></div>
    <input placeholder="Ghi chú thêm (thông tin ship, giờ giao…)" value="${esc(o.adminNote)}" onchange="upd('${o.id}','adminNote',this.value)">
    <div class="row"><button class="btn ${o.status==='done'?'ghost':'sage'} sm" onclick="upd('${o.id}','status','${o.status==='done'?'pending':'done'}',1)">${o.status==='done'?'Mở lại':'Hoàn thành đơn'}</button>
    <button class="btn rose sm" onclick="delOrder('${o.id}')">Xoá</button></div></div>`).join('') || '<p class="mute">Không có đơn nào.</p>'}</div>`;
}
function upd(id,k,v,re){ const o = {...S.orders[id], [k]:v}; put('orders',o); if (re) render(); }

/* ---- Thực đơn ---- */
function menuAdminHtml(){
  return `<div class="card" style="margin-bottom:16px"><h3>Thêm món mới</h3>
  <div class="row" style="align-items:flex-start;margin-top:8px"><div id="apv" class="pv">${A.img?`<img src="${A.img}">`:'🍽️'}</div>
  <div style="flex:3;min-width:220px;display:grid;gap:8px"><input id="nn" placeholder="Tên món"><input id="np" type="number" min="0" placeholder="Giá bán (đ)"><input id="nc" type="number" min="0" placeholder="Giá vốn / chi phí làm 1 phần (đ)">
  <label class="btn ghost sm" style="cursor:pointer;text-align:center">Chọn ảnh từ máy<input type="file" accept="image/*" hidden onchange="aimg(this)"></label></div></div>
  <button class="btn" style="margin-top:12px" onclick="addDish()">OK, thêm món</button></div>
  <div class="grid menu">${live('menu').map(m0 => { const m = D[m0.id] ? {...m0,...D[m0.id]} : m0; return `<div class="card dish"><div class="img" id="pv${m.id}">${m.img?`<img src="${m.img}">`:esc(m.emoji||'🍽️')}</div><div class="body">
  <input value="${esc(m.name)}" oninput="dset('${m.id}','name',this.value)" placeholder="Tên món"><label style="margin:2px 0 0">Giá bán (đ)</label><input type="number" min="0" value="${m.price}" oninput="dset('${m.id}','price',this.value)">
  <label style="margin:2px 0 0">Giá vốn / 1 phần (đ)</label><input type="number" min="0" value="${m.cost ?? ''}" placeholder="Nhập chi phí bỏ ra" oninput="dset('${m.id}','cost',this.value)">
  <div class="mute" id="mg${m.id}">${margin(m)}</div>
  <div class="row"><label class="btn ghost sm" style="cursor:pointer;text-align:center">Chọn ảnh<input type="file" accept="image/*" hidden onchange="dimg('${m.id}',this)"></label><button class="btn ghost sm" onclick="noImg('${m.id}')">Bỏ ảnh</button></div>
  <button class="btn sage" onclick="dsave('${m.id}')">OK, lưu thay đổi</button>
  <div class="row"><button class="btn ghost sm" onclick="toggleDish('${m.id}')">${m.on===false?'Bật lại món':'Đánh dấu hết món'}</button><button class="btn rose sm" onclick="delDish('${m.id}')">Xoá món</button></div></div></div>`; }).join('')}</div>`;
}
function pickImg(inp,cb){
  const f = inp.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { const img = new Image();
    img.onload = () => { const s = Math.min(1, 640/Math.max(img.width,img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width*s); c.height = Math.round(img.height*s); c.getContext('2d').drawImage(img,0,0,c.width,c.height); cb(c.toDataURL('image/jpeg',.75)); inp.value=''; };
    img.onerror = () => toast('Không đọc được ảnh, hãy chọn file JPG hoặc PNG');
    img.src = rd.result; };
  rd.onerror = () => toast('Không đọc được file');
  rd.readAsDataURL(f);
}
function aimg(inp){ pickImg(inp, d => { A.img = d; $('#apv').innerHTML = `<img src="${d}">`; toast('Đã chọn ảnh'); }); }
function addDish(){
  const name = $('#nn').value.trim(), price = +$('#np').value, cost = $('#nc').value;
  if (!name || !(price>0)) return toast('Nhập tên món và giá bán', true);
  if (cost === '' || +cost < 0) return toast('Nhập giá vốn (có thể là 0)', true);
  if (+cost > price) toast('Lưu ý: giá vốn đang cao hơn giá bán', true);
  put('menu',{id:'m'+uid(),name,price,cost:+cost,img:A.img,emoji:'🍽️',on:true}); A.img=''; toast('Đã thêm món'); render();
}
const margin = m => { const p=+m.price||0, c=+m.cost||0; return m.cost==null||m.cost==='' ? 'Chưa nhập giá vốn' : `Lãi ${money(p-c)}/phần (${p?Math.round((p-c)/p*100):0}%)`; };
function dset(id,k,v){ if (!D[id]) D[id] = {}; D[id][k] = v; const e=$('#mg'+id); if (e) e.textContent = margin({...S.menu[id],...D[id]}); }
function dimg(id,inp){ pickImg(inp, d => { dset(id,'img',d); $('#pv'+id).innerHTML = `<img src="${d}">`; toast('Đã chọn ảnh, bấm OK để lưu'); }); }
function noImg(id){ dset(id,'img',''); $('#pv'+id).innerHTML = '🍽️'; toast('Đã bỏ ảnh, bấm OK để lưu'); }
function dsave(id){
  const d = D[id]; if (!d) return toast('Chưa có thay đổi nào');
  const m = {...S.menu[id], ...d}; m.name = String(m.name).trim(); m.price = +m.price;
  if (!m.name || !(m.price>0)) return toast('Nhập tên món và giá hợp lệ', true);
  if (m.cost === '' || m.cost == null || +m.cost < 0) return toast('Nhập giá vốn (có thể là 0)', true);
  m.cost = +m.cost; if (m.cost > m.price) toast('Lưu ý: giá vốn đang cao hơn giá bán', true);
  put('menu', m); delete D[id]; toast('Đã lưu món'); render();
}
function toggleDish(id){ put('menu',{...S.menu[id], on: S.menu[id].on===false}); render(); }
function delDish(id){ ask(`Xoá món "${S.menu[id].name}"? Khách sẽ không còn thấy món này.`, () => { put('menu',{...S.menu[id],del:true}); delete D[id]; toast('Đã xoá món'); render(); }, 'Xoá món'); }

/* ---- Thống kê ---- */
const orderCost = o => o.items.reduce((t,i) => t + (i.cost ?? S.menu[i.id]?.cost ?? 0) * i.qty, 0);
function range(){ const out=[]; for (let d=new Date(F.from+'T00:00'); dstr(d)<=F.to && out.length<400; d.setDate(d.getDate()+1)) out.push(dstr(d)); return out; }
function agg(){
  const m = {}; range().forEach(d => m[d]={d,n:0,done:0,rev:0,cogs:0,pend:0,exp:0});
  live('orders').forEach(o => { const r=m[o.date]; if(!r) return; r.n++; if(o.status==='done'){r.done++;r.rev+=o.total;r.cogs+=orderCost(o);} else r.pend+=o.total; });
  live('exp').forEach(e => { if(m[e.date]) m[e.date].exp += e.amount; });
  return Object.values(m).map(r => ({...r, profit:r.rev-r.cogs-r.exp}));
}
function dishStats(){
  const d = {};
  live('orders').filter(o=>o.date>=F.from&&o.date<=F.to&&o.status==='done').forEach(o => o.items.forEach(i => {
    const x = d[i.name] = d[i.name] || {q:0,v:0,c:0}; x.q += i.qty; x.v += i.qty*i.price; x.c += i.qty*(i.cost ?? S.menu[i.id]?.cost ?? 0); }));
  return d;
}
const rangeBar = () => `<div class="row" style="flex:none;margin-bottom:14px"><div style="flex:none"><input type="date" value="${F.from}" onchange="F.from=this.value;render()"></div><div style="flex:none"><input type="date" value="${F.to}" onchange="F.to=this.value;render()"></div></div>`;
function statsHtml(){
  const a = agg(), sum = k => a.reduce((t,r)=>t+r[k],0), rev=sum('rev'), cogs=sum('cogs'), ex=sum('exp'), pr=rev-cogs-ex;
  const exps = live('exp').filter(e=>e.date>=F.from&&e.date<=F.to).sort((x,y)=>y.date.localeCompare(x.date));
  return rangeBar() + `<div class="grid stats"><div class="card stat"><b>${money(rev)}</b><span>Tổng thu</span></div><div class="card stat"><b>${money(cogs)}</b><span>Giá vốn món (tự tính)</span></div><div class="card stat"><b>${money(ex)}</b><span>Chi phí khác</span></div><div class="card stat"><b style="color:${pr>=0?'var(--sage)':'var(--rose)'}">${money(pr)}</b><span>Lợi nhuận</span></div></div>
  <p class="mute">Giá vốn được tự cộng từ các đơn đã bấm "Hoàn thành", theo giá vốn lúc khách đặt. Chi phí khác là các khoản bạn ghi thủ công bên dưới.</p>
  <button class="btn" onclick="exportXls()" style="margin-bottom:16px">Xuất file Excel</button>
  <div class="card scroll" style="margin-bottom:16px"><table><tr><th>Ngày</th><th class="n">Đơn</th><th class="n">Đã xử lý</th><th class="n">Thu</th><th class="n">Giá vốn</th><th class="n">Chi khác</th><th class="n">Lợi nhuận</th></tr>
  ${a.filter(r=>r.n||r.exp).map(r=>`<tr><td>${r.d}</td><td class="n">${r.n}</td><td class="n">${r.done}</td><td class="n">${money(r.rev)}</td><td class="n">${money(r.cogs)}</td><td class="n">${money(r.exp)}</td><td class="n" style="color:${r.profit>=0?'var(--sage)':'var(--rose)'}">${money(r.profit)}</td></tr>`).join('')||'<tr><td colspan="7" class="mute">Chưa có dữ liệu trong khoảng này.</td></tr>'}</table></div>
  <div class="card"><h3>Ghi chi phí khác</h3><div class="row"><input id="ed" type="date" value="${today()}"><input id="en" placeholder="Nội dung (ga, điện nước, tiền ship…)"><input id="ea" type="number" placeholder="Số tiền"></div>
  <button class="btn" style="margin-top:12px" onclick="addExp()">Lưu khoản chi</button>
  <table style="margin-top:12px">${exps.map(e=>`<tr><td>${e.date}</td><td>${esc(e.note)}</td><td class="n">${money(e.amount)}</td><td class="n"><button class="btn rose sm" onclick="delExp('${e.id}')">Xoá</button></td></tr>`).join('')}</table></div>`;
}
function addExp(){ const amount=+$('#ea').value, note=$('#en').value.trim(); if(!(amount>0)) return toast('Nhập số tiền', true); put('exp',{id:uid(),date:$('#ed').value||today(),note,amount}); render(); }
function exportXls(){
  const a = agg(), inR = o => o.date>=F.from && o.date<=F.to, ds = dishStats();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(a.map(r=>({'Ngày':r.d,'Số đơn':r.n,'Đơn đã xử lý':r.done,'Tiền thu':r.rev,'Giá vốn món':r.cogs,'Chi phí khác':r.exp,'Lợi nhuận':r.profit,'Đang chờ thu':r.pend}))), 'Theo ngày');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(live('orders').filter(inR).sort((x,y)=>(x.date+x.time).localeCompare(y.date+y.time)).map(o=>({'Ngày':o.date,'Giờ':o.time,'Khách':o.name,'SĐT':o.phone,'Tâm trạng':o.mood,'Món':o.items.map(i=>`${i.qty}x ${i.name}${i.note?' ('+i.note+')':''}`).join('; '),'Địa chỉ':o.addr,'Ghi chú':o.note,'Người ship':o.shipper,'Ghi chú admin':o.adminNote,'Tổng tiền':o.total,'Giá vốn':orderCost(o),'Lãi gộp':o.total-orderCost(o),'Trạng thái':o.status==='done'?'Đã xử lý':'Chờ xử lý'}))), 'Đơn hàng');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Object.entries(ds).map(([n,v])=>({'Món':n,'Số phần':v.q,'Doanh thu':v.v,'Giá vốn':v.c,'Lãi gộp':v.v-v.c}))), 'Theo món');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(live('exp').filter(inR).map(e=>({'Ngày':e.date,'Nội dung':e.note,'Số tiền':e.amount}))), 'Chi phí khác');
  XLSX.writeFile(wb, `thong-ke_${F.from}_${F.to}.xlsx`);
}

/* ---- Phân tích ---- */
function analysisHtml(){
  const a = agg(), act = a.filter(r=>r.rev||r.exp||r.cogs), ds = dishStats();
  const orders = live('orders').filter(o=>o.date>=F.from&&o.date<=F.to&&o.status==='done'), mood = {};
  orders.forEach(o => mood[o.mood] = (mood[o.mood]||0) + 1);
  const rev = a.reduce((t,r)=>t+r.rev,0), pr = a.reduce((t,r)=>t+r.profit,0);
  const best = [...act].sort((x,y)=>y.profit-x.profit)[0];
  const last = act[act.length-1], prev = act[act.length-2];
  const delta = last && prev && prev.profit>0 ? Math.round((last.profit-prev.profit)/prev.profit*100) : null;
  const W = Math.max(act.length*46+40, 320), H = 220, mx = Math.max(1,...act.map(r=>Math.max(r.rev,r.cogs+r.exp)));
  const bars = act.map((r,i) => { const x=30+i*46, h1=r.rev/mx*150, h2=(r.cogs+r.exp)/mx*150;
    return `<rect x="${x}" y="${180-h1}" width="18" height="${h1}" fill="#dca55c" rx="3"/><rect x="${x+20}" y="${180-h2}" width="18" height="${h2}" fill="#b96a60" rx="3"/><text x="${x+19}" y="198" fill="#a3ab9c" font-size="10" text-anchor="middle">${r.d.slice(8)}/${r.d.slice(5,7)}</text>`; }).join('');
  return rangeBar() + `<div class="grid stats"><div class="card stat"><b>${orders.length?money(rev/orders.length):'0đ'}</b><span>Giá trị TB mỗi đơn</span></div>
  <div class="card stat"><b>${rev?Math.round(pr/rev*100)+'%':'—'}</b><span>Biên lợi nhuận (sau mọi chi phí)</span></div>
  <div class="card stat"><b>${best?best.d.slice(5):'—'}</b><span>Ngày lãi cao nhất${best?' ('+money(best.profit)+')':''}</span></div>
  <div class="card stat"><b style="color:${delta>=0?'var(--sage)':'var(--rose)'}">${delta===null?'—':(delta>0?'+':'')+delta+'%'}</b><span>Lãi ngày gần nhất so với ngày trước</span></div></div>
  <div class="card scroll" style="margin-bottom:16px"><h3>Thu và chi theo ngày</h3><div class="mute"><span style="color:#dca55c">■</span> Thu &nbsp; <span style="color:#b96a60">■</span> Chi (giá vốn + chi khác)</div>
  ${act.length?`<svg width="${W}" height="${H}"><line x1="24" x2="${W}" y1="180" y2="180" stroke="#37443c"/>${bars}</svg>`:'<p class="mute">Chưa có dữ liệu thu chi trong khoảng này.</p>'}</div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="card scroll"><h3>Món bán chạy và lãi</h3><table><tr><th>Món</th><th class="n">Phần</th><th class="n">Doanh thu</th><th class="n">Lãi gộp</th></tr>${Object.entries(ds).sort((x,y)=>y[1].q-x[1].q).map(([n,v])=>`<tr><td>${esc(n)}</td><td class="n">${v.q}</td><td class="n">${money(v.v)}</td><td class="n">${money(v.v-v.c)}</td></tr>`).join('')||'<tr><td colspan="4" class="mute">Chưa có đơn hoàn thành</td></tr>'}</table></div>
  <div class="card"><h3>Tâm trạng khách</h3><table>${Object.entries(mood).sort((x,y)=>y[1]-x[1]).map(([n,v])=>`<tr><td>${esc(n)}</td><td class="n">${v} đơn</td></tr>`).join('')||'<tr><td class="mute">Chưa có dữ liệu</td></tr>'}</table></div></div>`;
}

/* ---- Hòm thư ---- */
function inboxHtml(){
  const l = live('reviews').sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  return l.length ? `<div class="row" style="flex:none;margin-bottom:12px"><button class="btn ghost sm" style="flex:none" onclick="readAll()">Đánh dấu đã đọc tất cả</button></div><div class="grid" style="max-width:700px">${l.map(r=>`<div class="card"><div class="row" style="flex:none;justify-content:space-between"><b>${esc(r.name)} ${r.read?'':'<span class="tag">Mới</span>'}</b><span class="mute">${r.date} ${r.time}</span></div>
  <p style="white-space:pre-wrap">${esc(r.text)}</p><div class="row" style="flex:none">${r.read?'':`<button class="btn sage sm" style="flex:none" onclick="put('reviews',{...S.reviews['${r.id}'],read:true});render()">Đã đọc</button>`}<button class="btn rose sm" style="flex:none" onclick="delReview('${r.id}')">Xoá</button></div></div>`).join('')}</div>` : '<p class="mute">Chưa có đánh giá nào.</p>';
}

/* ---- Cài đặt ---- */
function settingsHtml(){
  const u = up();
  return `<div class="grid" style="max-width:560px"><div class="card"><h3>Đổi mật khẩu admin</h3>
  <label>Mật khẩu hiện tại</label><input id="pw0" type="password" autocomplete="current-password">
  <label>Mật khẩu mới</label><input id="pw1" type="password" autocomplete="new-password">
  <label>Nhập lại mật khẩu mới</label><input id="pw2" type="password" autocomplete="new-password">
  <button class="btn" style="margin-top:12px" onclick="chgPass()">Lưu mật khẩu</button></div>
  ${shipHtml()}
  <div class="card"><h3>Liên hệ quán</h3><p class="mute">Hiện nút Gọi và Nhắn Zalo cho khách ở màn hình đặt món. Để trống số điện thoại nếu không muốn hiện.</p>
  <label>Số điện thoại quán</label><input id="ct_phone" type="tel" value="${esc(S.cfg.contact?.phone||'')}" placeholder="0901234567">
  <label>Số Zalo (để trống nếu trùng số điện thoại)</label><input id="ct_zalo" type="tel" value="${esc(S.cfg.contact?.zalo||'')}">
  <button class="btn" style="margin-top:12px" onclick="saveContact()">Lưu liên hệ</button></div>
  <div class="card"><h3>Đồng bộ đám mây</h3>${API ? `<p>✅ Đang dùng Upstash gắn với Vercel. Khách chỉ cần mở địa chỉ web, không cần mã đồng bộ.</p><div class="row" style="margin-top:12px"><button class="btn ghost" onclick="copyLink()">Sao chép link cho khách</button></div>` : `<p class="mute">Chỉ cần dán mã đồng bộ một lần. Dữ liệu luôn được giữ trong máy và tự đẩy lên khi có mạng.</p>
  <label>Mã đồng bộ</label><input id="code" value="${esc(getCode())}" placeholder="Dán mã đồng bộ vào đây">
  <div class="row" style="margin-top:12px"><button class="btn" onclick="saveCode()">Lưu và đồng bộ</button><button class="btn ghost" onclick="copyLink()">Sao chép link cho khách</button></div>
  <details style="margin-top:14px"><summary class="mute" style="cursor:pointer">Chưa có mã? Tạo từ Upstash</summary><label>REST URL</label><input id="uu"><label>REST Token</label><input id="ut"><button class="btn ghost sm" style="margin-top:10px" onclick="makeCode()">Tạo mã</button></details>`}
  <button class="btn ghost sm" style="margin-top:14px" onclick="backup()">Tải bản sao lưu</button></div></div>`;
}
function saveCode(){ const c=$('#code').value.trim(); if (c && !decodeCode(c)) return toast('Mã không hợp lệ'); localStorage.setItem('rq_code',c); lastVer = null; sync(true); toast('Đang đồng bộ…'); }
function makeCode(){ const u=$('#uu').value.trim(), t=$('#ut').value.trim(); if(!u||!t) return toast('Nhập đủ URL và Token'); $('#code').value = btoa(u+'|'+t); toast('Đã tạo mã, bấm Lưu và đồng bộ'); }
function copyLink(){ const c=getCode(); if(!API && !decodeCode(c)) return toast('Chưa có mã đồng bộ'); const l=location.origin+location.pathname+(API?'':'?code='+encodeURIComponent(c)); (navigator.clipboard?navigator.clipboard.writeText(l):Promise.reject()).then(()=>toast('Đã sao chép link'),()=>showText(l)); }
const curPass = async () => S.cfg.pass ? S.cfg.pass.v : await sha('admin123');
async function chgPass(){
  const p0=$('#pw0').value, p1=$('#pw1').value, p2=$('#pw2').value;
  if (await sha(p0) !== await curPass()) return toast('Mật khẩu hiện tại chưa đúng', true);
  if (p1.length < 4) return toast('Mật khẩu mới tối thiểu 4 ký tự', true);
  if (p1 !== p2) return toast('Hai lần nhập mật khẩu mới chưa khớp', true);
  if (p1 === p0) return toast('Mật khẩu mới phải khác mật khẩu cũ', true);
  ask('Đổi mật khẩu admin? Các thiết bị khác sẽ phải dùng mật khẩu mới.', async () => { const nh = await sha(p1); await put('cfg',{id:'pass',v:nh}); if (adminKey) adminKey = nh; ['pw0','pw1','pw2'].forEach(i=>{ const e=$('#'+i); if(e) e.value=''; }); toast('Đã đổi mật khẩu'); }, 'Đổi mật khẩu');
}
function saveContact(){
  const phone = $('#ct_phone').value.trim(), zalo = $('#ct_zalo').value.trim();
  if (phone && !phoneOk(phone)) return toast('Số điện thoại chưa đúng', true);
  if (zalo && !phoneOk(zalo)) return toast('Số Zalo chưa đúng', true);
  put('cfg',{id:'contact',phone,zalo}); toast(phone ? 'Đã lưu liên hệ' : 'Đã tắt nút liên hệ');
}
const ships = () => S.cfg.shippers?.v || [];
function shipHtml(){
  return `<div class="card"><h3>Người ship</h3><div class="chips" style="margin:10px 0">${ships().map((n,i)=>`<span class="chip on">${esc(n)}<button class="chipx" title="Xoá" onclick="delShip(${i})">✕</button></span>`).join('') || '<span class="mute">Chưa có người ship nào.</span>'}</div>
  <div class="row" style="flex-wrap:nowrap"><input id="shn" placeholder="Tên người ship mới" onkeydown="if(event.key==='Enter')addShip()"><button class="btn" style="flex:none;min-width:0" onclick="addShip()">Thêm</button></div></div>`;
}
function addShip(){
  const n = $('#shn').value.trim(); if (!n) return toast('Nhập tên người ship', true);
  if (ships().some(x => x.toLowerCase() === n.toLowerCase())) return toast('Người ship này đã có trong danh sách', true);
  put('cfg',{id:'shippers', v:[...ships(), n]}); toast('Đã thêm người ship'); render();
}
function delShip(i){ const n = ships()[i]; ask(`Xoá người ship "${n}"? Các đơn cũ vẫn giữ tên người này.`, () => { put('cfg',{id:'shippers', v:ships().filter((_,k)=>k!==i)}); toast('Đã xoá người ship'); render(); }, 'Xoá'); }
function backup(){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(S)],{type:'application/json'})); a.download=`sao-luu_${today()}.json`; a.click(); }

(async () => {
  try { const j = await (await fetch('/api/db', {cache:'no-store'})).json(); API = j.ok === true && j.ready === true; } catch(e){ API = false; }
  render(); sync().then(() => { seed(); if (role) render(); });
})();
