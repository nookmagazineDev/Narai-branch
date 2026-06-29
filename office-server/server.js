// Narai Usage API — รันในออฟฟิศ
// คำนวณ "ยอดใช้วัตถุดิบแยกตามเมนู" จาก ยอดขายสด (ctranbetweendate) x สูตร (CostMenu + RcpDtls)
//   เส้นทาง: sales.itemCode -> CostMenu.A(BOT) -> CostMenu.C(Kios) -> RcpDtls.A(เมนู) -> วัตถุดิบ x (G/I)
//   (ตรวจสอบแล้วตรงกับ trn_usg ของ POS เป๊ะ — และมีข้อมูลเดือนปัจจุบัน)
// เปิดพอร์ตออกเน็ตด้วย UPnP อัตโนมัติ
import 'dotenv/config';
import express from 'express';
import natUpnp from 'nat-upnp';

const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SALES_BASE = process.env.SALES_BASE || 'https://api.khanoykorshabu.com/ctranbetweendate';
// บิลที่จ่ายแล้ว (ระดับบิล: billTotal, vat) — ใช้คิดยอดขาย/จำนวนบิล/เฉลี่ยต่อบิล แบบเดียวกับ NARAI OFFICE
const PAID_BASE = process.env.PAID_BASE || SALES_BASE.replace('ctranbetweendate', 'cpaidbetweendate');
const WARM_DAYS = Number(process.env.WARM_DAYS) || 70; // อุ่น cache ย้อนหลังกี่วันตอนสตาร์ท
const TODAY_TTL_MS = 20 * 60 * 1000; // ข้อมูลวันล่าสุดรีเฟรชทุก 20 นาที
// รีเฟรช cache "วันนี้ + ย้อนหลังกี่วัน" ตาม TTL — กันข้อมูลค้างกรณี POS sync ช้า (วันเก่ากว่านี้ cache ถาวร)
const RECENT_REFRESH_DAYS = Number(process.env.RECENT_REFRESH_DAYS) || 3;

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

// ───────── กติกาแดชบอร์ด (ตรงกับ NARAI OFFICE) ─────────
const DASH_EXCLUDE_TABLES = [600];                 // โต๊ะที่ตัดออก
const DASH_EXCLUDE_ITEMS = [206001];               // itemCode เดี่ยวที่ตัดออก (ไปการ์ด "ไม่นับคำนวณ")
const DASH_EXCLUDE_ITEM_RANGES = [[500002, 500026]]; // ช่วง itemCode ที่ตัดออก
const DASH_COVER_ITEMS = [101001, 101002, 101003, 101004, 101107, 101108]; // ไอเทมบุฟเฟ่ใช้นับ "จำนวนคน"
// วัตถุดิบ (กก) โต๊ะเตรียม — แยกออกจากต้นทุนที่ใช้คิดกำไร
const DASH_PREP_KG_ITEMS = [206041, 206038, 205003, 205002, 205007, 205006, 205021, 206035, 206040, 205014, 205004, 206034];
const dashExclTable = (t) => DASH_EXCLUDE_TABLES.indexOf(parseInt(t)) >= 0;
const dashExclItem = (c) => { const ic = parseInt(c); return DASH_EXCLUDE_ITEMS.indexOf(ic) >= 0 || DASH_EXCLUDE_ITEM_RANGES.some(r => ic >= r[0] && ic <= r[1]); };
const dashPrepKg = (c) => DASH_PREP_KG_ITEMS.indexOf(parseInt(c)) >= 0;
const dashCoverItem = (c) => DASH_COVER_ITEMS.indexOf(parseInt(c)) >= 0;

function nstr(v) { return v == null ? '' : String(v).replace(/\.0+$/, '').trim(); }
function normItem(id) { return id == null ? '' : String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase(); }
function parseGviz(t) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); return JSON.parse(t.substring(a, b + 1)); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function r2(n) { return Number((Number(n) || 0).toFixed(2)); }

// ---------- สูตร (CostMenu + RcpDtls) + ราคาทุนต่อหน่วย ----------
let bridge = {};   // sales itemCode (BOT) -> Kios (รหัสเมนูในสูตร)
let recipe = {};   // เมนูcode -> { name, items:[{ing, per}] }
let menuCost = {}; // รหัสขาย (BOT_ItemCode) -> ต้นทุนต่อหน่วย (บาท) — จาก CostMenu คอลัมน์ H (= cost sheet gid 1742903365 คอลัมน์สุดท้าย)
const COST_MENU_COL = Number(process.env.COST_MENU_COL || 7); // คอลัมน์ต้นทุนต่อหน่วยใน CostMenu (0-based, H=7)

async function loadSheets() {
  const get = async (name) => parseGviz(await (await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(name)}`)).text());
  const [cm, rc] = await Promise.all([get('CostMenu'), get('RcpDtls')]);
  const b = {}, r = {}, mc2 = {};
  for (const row of (cm.table.rows || [])) {
    const c = row.c || [];
    const a = nstr(c[0] && c[0].v), k = nstr(c[2] && c[2].v);
    if (a && k) b[a] = k;
    const cost = Number(c[COST_MENU_COL] && c[COST_MENU_COL].v);
    if (a && !isNaN(cost)) mc2[a] = cost;
  }
  for (const row of (rc.table.rows || [])) {
    const c = row.c || []; const mc = nstr(c[0] && c[0].v); if (!mc || isNaN(Number(mc))) continue;
    const ing = normItem(c[4] && c[4].v); if (!ing) continue;
    const G = c[6] && c[6].v, I = c[8] && c[8].v;
    let per; if (G != null && I != null && Number(I) !== 0) per = Number(G) / Number(I); else if (G != null) per = Number(G); else continue;
    const name = (c[2] && c[2].v != null) ? String(c[2].v).trim() : '(ไม่ทราบชื่อเมนู)';
    if (!r[mc]) r[mc] = { name, items: [] };
    r[mc].items.push({ ing, per });
  }
  bridge = b; recipe = r; menuCost = mc2;
  console.log(`โหลดสูตรแล้ว: bridge ${Object.keys(b).length}, recipe ${Object.keys(r).length}, menuCost ${Object.keys(mc2).length}`);
}

// ---------- cache ยอดขายรายวัน ----------
const salesCache = new Map();   // date -> { fetchedAt, outlets, dashItems, dashBill }
const inflight = new Map();     // date -> Promise (กันยิงซ้ำพร้อมกัน)

async function fetchDay(date) {
  const q = `?start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`;
  const [rTran, rPaid] = await Promise.all([fetch(`${SALES_BASE}${q}`), fetch(`${PAID_BASE}${q}`)]);
  if (!rTran.ok) throw new Error('sales API ' + rTran.status);
  const tranRows = ((await rTran.json()) || {}).data || [];
  const paidRows = rPaid.ok ? (((await rPaid.json()) || {}).data || []) : [];

  const outlets = new Map();    // usage (สำหรับ usagebymenu): oid -> { itemCode -> {total, tbl} } (ตัดโต๊ะ 600 + EXCLUDE_ITEMCODES)
  const dashItems = new Map();  // แดชบอร์ด: oid -> { itemCode -> {name, qty} } (ไม่ void, ไม่ใช่โต๊ะ 600) — แยกหมวดต้นทุน/นับคนตอน query
  const dashExclTbl = new Map();// แดชบอร์ด: oid -> { itemCode -> {name, qty} } เฉพาะโต๊ะ 600 (หมวด "ไม่นับคำนวณ")
  const billAgg = new Map();    // ตารางรายการขาย: oid -> { checkID -> {cost, waiter} } (เชื่อมด้วย chkCheckID)
  for (const x of tranRows) {
    if (x.void) continue;
    const oid = Number(x.outletID);
    const ic = nstr(x.itemCode); if (!ic) continue;
    const qty = Number(x.quantity) || 0;
    const name = x.nameThai || x.nameEng || '-';

    // ---- แดชบอร์ด: เก็บ {ชื่อ, qty} ต่อ itemCode แยกโต๊ะ 600 (ไว้หมวด "ไม่นับคำนวณ") ----
    const target = dashExclTable(x.tableID) ? dashExclTbl : dashItems;
    let di = target.get(oid); if (!di) { di = {}; target.set(oid, di); }
    let de = di[ic]; if (!de) { de = { name, qty: 0 }; di[ic] = de; }
    de.qty += qty;

    // ---- ต้นทุน+พนักงานรับออเดอร์ ต่อบิล (ตารางรายการขาย) — เชื่อมด้วย chkCheckID ----
    // ต้นทุนต่อบิล = Σ ทุกรายการในบิล (ไม่ตัดไอเทม) เพื่อให้ตรงกับยอดในหน้ารายละเอียดบิล
    const chk = x.chkCheckID;
    if (chk != null && chk !== 0 && !dashExclTable(x.tableID)) {
      let bm = billAgg.get(oid); if (!bm) { bm = {}; billAgg.set(oid, bm); }
      let be = bm[chk]; if (!be) { be = { cost: 0, waiter: '' }; bm[chk] = be; }
      be.cost += (menuCost[ic] ?? 0) * qty;
      if (!be.waiter && x.waiterName) be.waiter = x.waiterName;
    }

    // ---- usage (ยอดใช้แยกเมนู): ตัดโต๊ะ 600 + ไอเทมที่ตั้งว่าไม่คิด ----
    if (Number(x.tableID) === 600) continue;
    if (EXCLUDE_ITEMCODES.has(ic)) continue;
    const tid = String(x.tableID == null ? '?' : x.tableID);
    let m = outlets.get(oid); if (!m) { m = {}; outlets.set(oid, m); }
    let e = m[ic]; if (!e) { e = { total: 0, tbl: {} }; m[ic] = e; }
    e.total += qty;
    e.tbl[tid] = (e.tbl[tid] || 0) + qty;
  }

  // ---- บิลที่จ่ายแล้ว (ยอดขาย/จำนวนบิล): ตัดโต๊ะ 600 ----
  const dashBill = new Map();   // oid -> { sumBill, sumVat, count }
  const billRows = new Map();   // ตารางรายการขาย: oid -> [ {checkID, ...ฟิลด์บิล, billCost, waiterName} ]
  for (const r of paidRows) {
    if (dashExclTable(r.tableID)) continue;
    const oid = Number(r.outletID);
    let b = dashBill.get(oid); if (!b) { b = { sumBill: 0, sumVat: 0, count: 0 }; dashBill.set(oid, b); }
    const billTotal = parseFloat(r.billTotal) || 0;
    const vat = parseFloat(r.vat) || 0;
    const amount = parseFloat(r.amount ?? r.Amount ?? billTotal) || 0;
    b.sumBill += billTotal;
    b.sumVat += vat;
    b.count += 1;

    // ---- แถวตารางรายการขาย (ผนวกต้นทุน+พนักงานรับออเดอร์ ที่เชื่อมด้วย checkID) ----
    const be = billAgg.get(oid)?.[r.checkID];
    let rows = billRows.get(oid); if (!rows) { rows = []; billRows.set(oid, rows); }
    rows.push({
      checkID: r.checkID,
      orderID: r.orderID ?? '',
      tableID: r.tableID ?? null,
      cashierName: r.cashierName ?? '',
      waiterName: (be && be.waiter) || r.waiterName || '',
      amount: r2(amount),
      beforeVat: r2(amount - vat),
      vat: r2(vat),
      billTotal: r2(billTotal),
      billCost: r2(be ? be.cost : 0),
      paidType: r.paidType ?? r.PaidType ?? '',
      memberTel: r.memberTel ?? '',
      cover: Number(r.cover) || 0,
      coverAd: Number(r.coverAd) || 0,
      coverAll: Number(r.coverAll) || 0,
      startTime: r.startTime ?? '',
      endTime: r.date ?? r.postTime ?? '',
      checkDesc: r.checkDesc ?? '',
    });
  }

  return { outlets, dashItems, dashExclTbl, dashBill, billRows };
}

// จำนวนวันที่ date ห่างจากวันนี้ (UTC): 0 = วันนี้, ค่าลบ = อนาคต, บวก = อดีต
function daysAgo(date) {
  const a = new Date(date + 'T00:00:00Z').getTime();
  const b = new Date(todayStr() + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

async function getDay(date) {
  const cached = salesCache.get(date);
  // วันนี้ + ย้อนหลังไม่เกิน RECENT_REFRESH_DAYS วัน → เช็ครีเฟรชตาม TTL (กันข้อมูลค้างตอน POS ยัง sync ไม่ครบ)
  const isRecent = daysAgo(date) <= RECENT_REFRESH_DAYS;
  if (cached && !(isRecent && Date.now() - cached.fetchedAt > TODAY_TTL_MS)) return cached;
  if (inflight.has(date)) return inflight.get(date);
  const p = (async () => {
    const { outlets, dashItems, dashExclTbl, dashBill, billRows } = await fetchDay(date);
    const entry = { fetchedAt: Date.now(), outlets, dashItems, dashExclTbl, dashBill, billRows };
    salesCache.set(date, entry);
    inflight.delete(date);
    return entry;
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
    for (const entry of chunk) {
      const m = entry.outlets.get(outletNum); if (!m) continue;
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
    for (const entry of chunk) {
      const m = entry.outlets.get(outletNum); if (!m) continue;
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

// แดชบอร์ดสาขา: ยอดขาย/ต้นทุน/กำไร/บิล/ลูกค้า + ยอดขายรายวัน (สูตรตรงกับ NARAI OFFICE)
//   ยอดขาย = Σ billTotal − Σ vat (จาก cpaidbetweendate, ตัดโต๊ะ 600)
//   ต้นทุนรวม = Σ menuCost[itemCode]×qty (ตัดโต๊ะ 600, ตัดไอเทมไม่นับ, แยกวัตถุดิบโต๊ะเตรียม(กก))
//   กำไร = ยอดขาย(ก่อน VAT) − ต้นทุนรวม | ลูกค้า = Σ qty ไอเทมบุฟเฟ่ | เฉลี่ย/บิล = Σ billTotal / จำนวนบิล
async function computeDashboard(outletNum, start, end) {
  const days = dateRange(start, end);
  let sumBill = 0, sumVat = 0, bills = 0;
  const daily = [];
  const itemsAgg = {};   // ic -> {name, qty}  (ไม่ใช่โต๊ะ 600)
  const exclTblAgg = {}; // ic -> {name, qty}  (โต๊ะ 600)
  const CONC = 6;
  for (let i = 0; i < days.length; i += CONC) {
    const slice = days.slice(i, i + CONC);
    const chunk = await Promise.all(slice.map(getDay));
    for (let j = 0; j < slice.length; j++) {
      const date = slice[j]; const entry = chunk[j];

      // ยอดขาย/บิล จากบิลที่จ่ายแล้ว
      const b = entry.dashBill.get(outletNum);
      const dayBill = b ? b.sumBill : 0;
      const dayVat = b ? b.sumVat : 0;
      sumBill += dayBill; sumVat += dayVat;
      bills += b ? b.count : 0;
      daily.push({ date, sales: Number((dayBill - dayVat).toFixed(2)) });

      // รวมรายการ (detail) ของสาขานี้
      const di = entry.dashItems.get(outletNum);
      if (di) for (const [ic, v] of Object.entries(di)) {
        const a = itemsAgg[ic] || (itemsAgg[ic] = { name: v.name, qty: 0 }); a.qty += v.qty;
      }
      const de = entry.dashExclTbl.get(outletNum);
      if (de) for (const [ic, v] of Object.entries(de)) {
        const a = exclTblAgg[ic] || (exclTblAgg[ic] = { name: v.name, qty: 0 }); a.qty += v.qty;
      }
    }
  }

  // แยกหมวดต้นทุน + สร้าง breakdown รายไอเทม (สำหรับ modal "คลิกดูรายละเอียด")
  let totalCost = 0, prepCost = 0, prepQty = 0, excludedCost = 0, excludedQty = 0, covers = 0;
  const costBreakdown = [], prepBreakdown = [], excludedBreakdown = [];
  for (const [ic, v] of Object.entries(itemsAgg)) {
    if (dashCoverItem(ic)) covers += v.qty;
    const unitCost = menuCost[ic] ?? 0;
    const tc = unitCost * v.qty;
    if (dashExclItem(ic)) {
      excludedCost += tc; excludedQty += v.qty;
      excludedBreakdown.push({ reason: 'ไอเทมเตรียม', itemCode: ic, name: v.name, unitCost, qty: r2(v.qty), totalCost: r2(tc) });
    } else if (dashPrepKg(ic)) {
      prepCost += tc; prepQty += v.qty;
      prepBreakdown.push({ itemCode: ic, name: v.name, unitCost, qty: r2(v.qty), totalCost: r2(tc) });
    } else {
      totalCost += tc;
      costBreakdown.push({ itemCode: ic, name: v.name, unitCost, qty: r2(v.qty), totalCost: r2(tc) });
    }
  }
  for (const [ic, v] of Object.entries(exclTblAgg)) {
    const unitCost = menuCost[ic] ?? 0;
    const tc = unitCost * v.qty;
    excludedCost += tc; excludedQty += v.qty;
    excludedBreakdown.push({ reason: 'โต๊ะ 600', itemCode: ic, name: v.name, unitCost, qty: r2(v.qty), totalCost: r2(tc) });
  }
  const byCost = (a, b) => b.totalCost - a.totalCost || b.qty - a.qty;
  const costRows = costBreakdown.filter(r => r.totalCost > 0).sort(byCost);
  prepBreakdown.sort(byCost);
  excludedBreakdown.sort(byCost);

  const sales = sumBill - sumVat;            // ยอดขายก่อน VAT
  const profit = sales - totalCost;
  const avgPerBill = bills ? sumBill / bills : 0; // เฉลี่ยต่อบิล = ยอดบิลรวม (รวม VAT) / จำนวนบิล
  return {
    sales: r2(sales),
    gross: r2(sumBill),   // Gross Sales = Σ billTotal (รวม VAT)
    tax: r2(sumVat),      // VAT รวม
    cost: r2(totalCost),
    prepCost: r2(prepCost),
    prepQty: r2(prepQty),
    profit: r2(profit),
    excludedCost: r2(excludedCost),
    excludedQty: r2(excludedQty),
    bills,
    covers: r2(covers),
    avgPerBill: r2(avgPerBill),
    daily,
    costBreakdown: costRows,
    prepBreakdown,
    excludedBreakdown,
  };
}

// ตารางรายการขาย: รายการบิลทั้งหมดของสาขาในช่วงเวลา (ระดับบิล + ต้นทุน/พนักงานรับออเดอร์)
async function computeBills(outletNum, start, end) {
  const days = dateRange(start, end);
  const out = [];
  const CONC = 6;
  for (let i = 0; i < days.length; i += CONC) {
    const slice = days.slice(i, i + CONC);
    const chunk = await Promise.all(slice.map(getDay));
    for (let j = 0; j < slice.length; j++) {
      const date = slice[j];
      const rows = chunk[j].billRows.get(outletNum);
      if (rows) for (const r of rows) out.push({ date, ...r });
    }
  }
  // เรียงล่าสุดก่อน (วันที่ + เวลาเริ่ม)
  out.sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
  return out;
}

// รายละเอียดรายการในบิล (line items) — ดึง ctran ของวันนั้นแล้วกรองตาม outlet + checkID
async function computeBillDetail(outletNum, date, checkID) {
  const q = `?start=${encodeURIComponent(date)}&end=${encodeURIComponent(date)}`;
  const r = await fetch(`${SALES_BASE}${q}`);
  if (!r.ok) throw new Error('sales API ' + r.status);
  const tranRows = ((await r.json()) || {}).data || [];
  const cid = String(checkID);
  const rows = [];
  for (const x of tranRows) {
    if (Number(x.outletID) !== outletNum) continue;
    if (String(x.chkCheckID) !== cid) continue;
    const qty = Number(x.quantity) || 0;
    const ic = nstr(x.itemCode);
    const unitCost = menuCost[ic] ?? 0;
    rows.push({
      itemCode: ic,
      name: x.nameThai || x.nameEng || '-',
      qty,
      unitPrice: r2(x.unitPrice),
      grossPrice: r2(x.grossPrice),
      tax: r2(x.tax),
      unitCost: r2(unitCost),
      lineCost: r2(unitCost * qty),
      tableID: x.tableID ?? null,
      prtOrdTime: x.prtOrdTime ?? '',
      orderID: x.orderID ?? '',
      void: !!x.void,
    });
  }
  return rows;
}

app.get('/bills', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || ''); const end = String(req.query.end || '');
    if (!start || !end) return res.status(400).json({ status: 'error', message: 'missing start/end' });
    const outletNum = branchMap[branch] || Number(req.query.outletid) || 0;
    if (!outletNum) return res.status(400).json({ status: 'error', message: 'unknown branch/outlet' });
    if (!Object.keys(recipe).length) await loadSheets();
    const data = await computeBills(outletNum, start, end);
    res.json({ status: 'success', branch, outletId: outletNum, start, end, count: data.length, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/billdetail', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const date = String(req.query.date || '');
    const checkID = String(req.query.checkid || '');
    if (!date || !checkID) return res.status(400).json({ status: 'error', message: 'missing date/checkid' });
    const outletNum = branchMap[branch] || Number(req.query.outletid) || 0;
    if (!outletNum) return res.status(400).json({ status: 'error', message: 'unknown branch/outlet' });
    if (!Object.keys(recipe).length) await loadSheets();
    const data = await computeBillDetail(outletNum, date, checkID);
    res.json({ status: 'success', branch, outletId: outletNum, date, checkID, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || ''); const end = String(req.query.end || '');
    if (!start || !end) return res.status(400).json({ status: 'error', message: 'missing start/end' });
    const outletNum = branchMap[branch] || Number(req.query.outletid) || 0;
    if (!outletNum) return res.status(400).json({ status: 'error', message: 'unknown branch/outlet' });
    if (!Object.keys(recipe).length) await loadSheets();
    const data = await computeDashboard(outletNum, start, end);
    res.json({ status: 'success', branch, outletId: outletNum, start, end, data });
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
