// Narai Usage API — รันในออฟฟิศ
// คำนวณ "ยอดใช้วัตถุดิบแยกตามเมนู" จาก ยอดขายสด (ctranbetweendate) x สูตร (CostMenu + RcpDtls)
//   เส้นทาง: sales.itemCode -> CostMenu.A(BOT) -> CostMenu.C(Kios) -> RcpDtls.A(เมนู) -> วัตถุดิบ x (G/I)
//   (ตรวจสอบแล้วตรงกับ trn_usg ของ POS เป๊ะ — และมีข้อมูลเดือนปัจจุบัน)
// เปิดพอร์ตออกเน็ตด้วย UPnP อัตโนมัติ
import 'dotenv/config';
import express from 'express';
import natUpnp from 'nat-upnp';

const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SALES_BASE = process.env.SALES_BASE || 'http://storenarai.dyndns.tv:14365/express/ctranbetweendate';
const WARM_DAYS = Number(process.env.WARM_DAYS) || 70; // อุ่น cache ย้อนหลังกี่วันตอนสตาร์ท
const TODAY_TTL_MS = 20 * 60 * 1000; // ข้อมูล "วันนี้" รีเฟรชทุก 20 นาที

const branchMap = {
  sjp: 7, zjp: 7, crm: 12, xcm: 19, slr: 37, sum: 51, xum: 59, scs: 61, smp: 63,
  xsb: 67, xhh: 72, hrs: 78, clk: 79, p90: 80, hps: 109, zbw: 400, zpt: 401,
  npt: 500, wrm: 501, wmt: 503, ipr: 904, zk3: 906, zip: 12,
};

// รหัสไอเทม (ฝั่งขาย) ที่ตั้งว่า "ไม่ต้องคิด" — ใส่ใน .env: EXCLUDE_ITEMCODES=102006,202028,...
const EXCLUDE_ITEMCODES = new Set(String(process.env.EXCLUDE_ITEMCODES || '').split(',').map(s => s.trim()).filter(Boolean));

// วัตถุดิบ (ฝั่งสต๊อก) ที่ "ห้ามนับเมนูหน่วย (ที่)" — นับเฉพาะเมนูหน่วย (กก)
// เช่น สันคอ 11010081: เมนูบุฟเฟ่ต์ (กก) นับ, เมนูสไลด์ (ที่) ไม่นับ (กันนับซ้ำเนื้อตัวเดียวกัน)
// ตั้งรายไอเทม ไม่ใช่กฎรวม — เพิ่มรหัสคั่นด้วย , ใน .env: EXCLUDE_PLATE_MENU_INGREDIENTS=11010081,...
const EXCLUDE_PLATE_MENU_INGREDIENTS = new Set(
  String(process.env.EXCLUDE_PLATE_MENU_INGREDIENTS || '11010081').split(',').map(s => normItem(s)).filter(Boolean)
);

function nstr(v) { return v == null ? '' : String(v).replace(/\.0+$/, '').trim(); }
function normItem(id) { return id == null ? '' : String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase(); }
function parseGviz(t) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.substring(a, b + 1)); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ---------- สูตร (CostMenu + RcpDtls) ----------
let bridge = {};   // sales itemCode (BOT) -> Kios (รหัสเมนูในสูตร)
let recipe = {};   // เมนูcode -> { name, items:[{ing, per}] }

async function loadSheets() {
  const get = async (name) => parseGviz(await (await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(name)}`)).text());
  const [cm, rc] = await Promise.all([get('CostMenu'), get('RcpDtls')]);
  const b = {}, r = {};
  for (const row of (cm.table.rows || [])) { const c = row.c || []; const a = nstr(c[0] && c[0].v), k = nstr(c[2] && c[2].v); if (a && k) b[a] = k; }
  for (const row of (rc.table.rows || [])) {
    const c = row.c || []; const mc = nstr(c[0] && c[0].v); if (!mc || isNaN(Number(mc))) continue;
    const ing = normItem(c[4] && c[4].v); if (!ing) continue;
    const G = c[6] && c[6].v, I = c[8] && c[8].v;
    let per; if (G != null && I != null && Number(I) !== 0) per = Number(G) / Number(I); else if (G != null) per = Number(G); else continue;
    const name = (c[2] && c[2].v != null) ? String(c[2].v).trim() : '(ไม่ทราบชื่อเมนู)';
    if (!r[mc]) r[mc] = { name, items: [] };
    r[mc].items.push({ ing, per });
  }
  bridge = b; recipe = r;
  console.log(`โหลดสูตรแล้ว: bridge ${Object.keys(b).length}, recipe ${Object.keys(r).length}`);
}

// ---------- cache ยอดขายรายวัน: date -> { outletID -> { itemCode -> qty } } ----------
const salesCache = new Map();   // date -> { fetchedAt, outlets: Map }
const inflight = new Map();     // date -> Promise (กันยิงซ้ำพร้อมกัน)

async function fetchDay(date) {
  const r = await fetch(`${SALES_BASE}?start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`);
  if (!r.ok) throw new Error('sales API ' + r.status);
  const json = await r.json();
  const rows = (json && json.data) ? json.data : [];
  const outlets = new Map();
  for (const x of rows) {
    if (x.void) continue;
    if (Number(x.tableID) === 600) continue; // โต๊ะ 600 = เศษ/อาหารพนักงาน ไม่นับเป็นยอดใช้
    const oid = Number(x.outletID); const ic = nstr(x.itemCode); if (!ic) continue;
    if (EXCLUDE_ITEMCODES.has(ic)) continue; // ไอเทมที่ตั้งว่าไม่ต้องคิด
    const tid = String(x.tableID == null ? '?' : x.tableID);
    const qty = Number(x.quantity) || 0;
    let m = outlets.get(oid); if (!m) { m = {}; outlets.set(oid, m); }
    let e = m[ic]; if (!e) { e = { total: 0, tbl: {} }; m[ic] = e; }
    e.total += qty;
    e.tbl[tid] = (e.tbl[tid] || 0) + qty;
  }
  return outlets;
}

async function getDay(date) {
  const cached = salesCache.get(date);
  const isToday = date >= todayStr();
  if (cached && !(isToday && Date.now() - cached.fetchedAt > TODAY_TTL_MS)) return cached.outlets;
  if (inflight.has(date)) return inflight.get(date);
  const p = (async () => {
    const outlets = await fetchDay(date);
    salesCache.set(date, { fetchedAt: Date.now(), outlets });
    inflight.delete(date);
    return outlets;
  })().catch((e) => { inflight.delete(date); throw e; });
  inflight.set(date, p);
  return p;
}

function dateRange(start, end) {
  const out = []; const d = new Date(start + 'T00:00:00Z'); const last = new Date(end + 'T00:00:00Z');
  while (d <= last && out.length < 120) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

async function computeUsageByMenu(outletNum, start, end) {
  const days = dateRange(start, end);
  // รวมยอดขายต่อ itemCode ของสาขานั้น ตลอดช่วง
  const sales = {};
  const CONC = 6;
  for (let i = 0; i < days.length; i += CONC) {
    const chunk = await Promise.all(days.slice(i, i + CONC).map(getDay));
    for (const outlets of chunk) {
      const m = outlets.get(outletNum); if (!m) continue;
      for (const [ic, e] of Object.entries(m)) sales[ic] = (sales[ic] || 0) + e.total;
    }
  }
  // กระจายลงวัตถุดิบตามสูตร
  const result = {};
  for (const [ic, q] of Object.entries(sales)) {
    if (!q) continue;
    const kc = bridge[ic]; if (!kc || !recipe[kc]) continue;
    const { name, items } = recipe[kc];
    for (const it of items) {
      const used = q * it.per; if (!used) continue;
      // วัตถุดิบบางตัว: ไม่นับเมนูหน่วย (ที่) — นับเฉพาะ (กก) (กันนับซ้ำเนื้อตัวเดียวกัน)
      if (EXCLUDE_PLATE_MENU_INGREDIENTS.has(it.ing) && /\(\s*ที่\s*\)/.test(name)) continue;
      if (!result[it.ing]) result[it.ing] = {};
      const e = result[it.ing][name] || (result[it.ing][name] = { qty: 0, sold: 0 });
      e.qty += used;   // ปริมาณวัตถุดิบที่ใช้
      e.sold += q;     // จำนวนเมนูที่ขายออกไป
    }
  }
  const data = {};
  for (const ing of Object.keys(result)) {
    data[ing] = Object.entries(result[ing]).map(([menu, v]) => ({ menu, qty: Number(v.qty.toFixed(2)), sold: Number(v.sold.toFixed(2)) }))
      .filter((x) => x.qty > 0).sort((a, b) => b.qty - a.qty);
  }
  return data;
}

// แยกตามโต๊ะ: เมนูที่เลือก ขายที่โต๊ะไหนบ้าง (จำนวนที่ขาย)
async function computeTablesForMenu(outletNum, start, end, menuName) {
  const days = dateRange(start, end);
  const byTable = {};
  const CONC = 6;
  for (let i = 0; i < days.length; i += CONC) {
    const chunk = await Promise.all(days.slice(i, i + CONC).map(getDay));
    for (const outlets of chunk) {
      const m = outlets.get(outletNum); if (!m) continue;
      for (const [ic, e] of Object.entries(m)) {
        const kc = bridge[ic]; if (!kc || !recipe[kc]) continue;
        if (recipe[kc].name !== menuName) continue;
        for (const [t, q] of Object.entries(e.tbl)) byTable[t] = (byTable[t] || 0) + q;
      }
    }
  }
  return Object.entries(byTable).map(([table, qty]) => ({ table, qty: Number(qty.toFixed(2)) }))
    .filter((x) => x.qty > 0).sort((a, b) => b.qty - a.qty);
}

// ---------- HTTP ----------
const app = express();
app.use((req, res, next) => {
  const need = process.env.API_TOKEN;
  if (need && req.get('x-api-token') !== need) return res.status(401).json({ status: 'error', message: 'unauthorized' });
  next();
});
app.get('/health', (req, res) => res.json({ ok: true, days_cached: salesCache.size, recipes: Object.keys(recipe).length }));
app.get('/usagebymenu', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || ''); const end = String(req.query.end || '');
    if (!branch || !start || !end) return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
    const outletNum = branchMap[branch] || Number(req.query.outletid) || 0;
    if (!outletNum) return res.json({ status: 'success', data: {} });
    if (!Object.keys(recipe).length) await loadSheets();
    const data = await computeUsageByMenu(outletNum, start, end);
    res.json({ status: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});
app.get('/usagebytable', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || ''); const end = String(req.query.end || '');
    const menu = String(req.query.menu || '');
    if (!branch || !start || !end || !menu) return res.status(400).json({ status: 'error', message: 'missing branch/start/end/menu' });
    const outletNum = branchMap[branch] || Number(req.query.outletid) || 0;
    if (!outletNum) return res.json({ status: 'success', data: [] });
    if (!Object.keys(recipe).length) await loadSheets();
    const data = await computeTablesForMenu(outletNum, start, end, menu);
    res.json({ status: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ---------- startup ----------
function openPortViaUpnp(port) {
  try {
    const client = natUpnp.createClient();
    client.portMapping({ public: port, private: port, ttl: 0, description: 'Narai Usage API' }, (err) => {
      client.close();
      console.log(err ? ('UPnP: เปิดพอร์ตไม่สำเร็จ (' + err.message + ')') : ('UPnP: เปิดพอร์ต ' + port + ' สำเร็จ'));
    });
  } catch (e) { console.log('UPnP error: ' + e.message); }
}

async function warmCache() {
  const days = dateRange(new Date(Date.now() - WARM_DAYS * 86400000).toISOString().slice(0, 10), todayStr());
  console.log('เริ่มอุ่น cache ' + days.length + ' วัน (เบื้องหลัง)...');
  for (const d of days) { try { await getDay(d); } catch (e) { /* ข้ามวันที่โหลดไม่ได้ */ } }
  console.log('อุ่น cache เสร็จ: ' + salesCache.size + ' วัน');
}

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, async () => {
  console.log('Narai Usage API running on port ' + PORT);
  if (process.env.UPNP !== 'off') { openPortViaUpnp(PORT); setInterval(() => openPortViaUpnp(PORT), 30 * 60 * 1000); }
  try { await loadSheets(); } catch (e) { console.log('โหลดสูตรล้มเหลว: ' + e.message); }
  setInterval(() => loadSheets().catch(() => {}), 6 * 60 * 60 * 1000); // รีเฟรชสูตรทุก 6 ชม.
  warmCache(); // อุ่น cache เบื้องหลัง
});
