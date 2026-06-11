// คำนวณ "ยอดใช้วัตถุดิบ แยกตามเมนูที่ขายจริง" (Method 2) จาก API สดๆ
// แหล่งข้อมูล:
//  1) ยอดขายรายเมนู: http://storenarai.dyndns.tv:14365/express/ctranbetweendate?start=&end=
//       (คืนทุกสาขา ต้องกรอง outletID เอง) -> ใช้ itemCode เป็นรหัสเมนูฝั่งขาย, quantity = จำนวนขาย
//  2) ตัวเชื่อม: ชีท CostMenu (A=itemCode ฝั่งขาย/BOT, C=Kios_itemid = รหัสเมนูในสูตร)
//  3) สูตร: ชีท RcpDtls (A=รหัสเมนู, C=ชื่อเมนู, E=รหัสวัตถุดิบ, G/I = ปริมาณต่อจาน)
//
// เส้นทาง: sales.itemCode -> CostMenu.A -> CostMenu.C (Kios) -> RcpDtls.A -> วัตถุดิบ x (ขาย x G/I)
const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SALES_BASE = 'http://storenarai.dyndns.tv:14365/express/ctranbetweendate';

const CM_ITEMCODE = 0; // CostMenu A (= sales itemCode)
const CM_KIOS = 2;     // CostMenu C (= RcpDtls menu code)
const RC_MENU_CODE = 0, RC_MENU_NAME = 2, RC_ITEM_CODE = 4, RC_USE = 6, RC_YIELD = 8;

const branchMap = {
  'sjp': 7, 'zjp': 7, 'crm': 12, 'xcm': 19, 'slr': 37, 'sum': 51,
  'xum': 59, 'scs': 61, 'smp': 63, 'xsb': 67, 'xhh': 72,
  'hrs': 78, 'clk': 79, 'p90': 80, 'hps': 109, 'zbw': 400,
  'zpt': 401, 'npt': 500, 'wrm': 501, 'wmt': 503, 'ipr': 904,
  'zk3': 906, 'zip': 12
};

function nstr(v) { return v == null ? '' : String(v).replace(/\.0+$/, '').trim(); }
function normItem(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}
function gvizRows(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  const parsed = JSON.parse(text.substring(start, end + 1));
  return (parsed.table && parsed.table.rows) ? parsed.table.rows : [];
}
async function fetchSheet(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Google Sheet Error (${name}): ${r.status}`);
  return gvizRows(await r.text());
}
function dateList(start, end) {
  const days = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last && days.length < 92) { // กันช่วงกว้างเกินไป (สูงสุด ~3 เดือน)
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ดึงยอดขาย 1 วัน แล้วรวมเฉพาะสาขาที่ต้องการลง salesByItem (คุมหน่วยความจำ)
async function aggregateDay(day, outletNum, salesByItem) {
  const r = await fetch(`${SALES_BASE}?start=${encodeURIComponent(day)}&end=${encodeURIComponent(day)}`);
  if (!r.ok) throw new Error(`Sales API Error: ${r.status}`);
  const json = await r.json();
  const rows = (json && json.data) ? json.data : [];
  for (const x of rows) {
    if (Number(x.outletID) !== outletNum) continue;
    if (x.void) continue; // ข้ามรายการที่ถูกยกเลิก
    const ic = nstr(x.itemCode);
    if (!ic) continue;
    salesByItem[ic] = (salesByItem[ic] || 0) + (Number(x.quantity) || 0);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate, outletId: queryOutletId } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch).toLowerCase().trim();
  const outletNum = Number(queryOutletId || branchMap[branchKey] || 0);
  if (!outletNum) {
    return res.status(200).json({ status: 'success', data: {}, note: `ไม่พบเลขสาขาของ ${branchKey}` });
  }

  try {
    // โหลดตัวเชื่อม + สูตร พร้อมกัน
    const [costmenuRows, recipeRows] = await Promise.all([fetchSheet('CostMenu'), fetchSheet('RcpDtls')]);

    // bridge: sales itemCode -> รหัสเมนูในสูตร (Kios_itemid)
    const bridge = {};
    for (const row of costmenuRows) {
      const c = row.c; if (!c) continue;
      const a = nstr(c[CM_ITEMCODE] && c[CM_ITEMCODE].v);
      const k = nstr(c[CM_KIOS] && c[CM_KIOS].v);
      if (a && k) bridge[a] = k;
    }

    // recipe: รหัสเมนู -> [{item, name, perUnit}]
    const recipe = {};
    for (const row of recipeRows) {
      const c = row.c; if (!c) continue;
      const mc = nstr(c[RC_MENU_CODE] && c[RC_MENU_CODE].v);
      if (!mc || isNaN(Number(mc))) continue;
      const item = normItem(c[RC_ITEM_CODE] && c[RC_ITEM_CODE].v != null ? c[RC_ITEM_CODE].v : null);
      if (!item) continue;
      const use = c[RC_USE] && c[RC_USE].v != null ? Number(c[RC_USE].v) : null;
      const yld = c[RC_YIELD] && c[RC_YIELD].v != null ? Number(c[RC_YIELD].v) : null;
      let perUnit;
      if (use != null && yld != null && yld !== 0) perUnit = use / yld;
      else if (use != null) perUnit = use;
      else continue;
      const menuName = c[RC_MENU_NAME] && c[RC_MENU_NAME].v != null ? String(c[RC_MENU_NAME].v).trim() : '(ไม่ทราบชื่อเมนู)';
      (recipe[mc] = recipe[mc] || []).push({ item, name: menuName, perUnit });
    }

    // ดึงยอดขายรายวัน (กรองสาขา + รวมทันที) แบบจำกัด concurrency
    const days = dateList(startDate, endDate);
    const salesByItem = {};
    const CONCURRENCY = 4;
    for (let i = 0; i < days.length; i += CONCURRENCY) {
      await Promise.all(days.slice(i, i + CONCURRENCY).map(d => aggregateDay(d, outletNum, salesByItem)));
    }

    // กระจายยอดขายลงวัตถุดิบตามสูตร
    const result = {}; // normItem -> { menuName -> qty }
    for (const [ic, qty] of Object.entries(salesByItem)) {
      if (!qty) continue;
      const menuCode = bridge[ic];
      if (!menuCode || !recipe[menuCode]) continue;
      for (const ing of recipe[menuCode]) {
        const attributed = qty * ing.perUnit;
        if (!attributed) continue;
        if (!result[ing.item]) result[ing.item] = {};
        result[ing.item][ing.name] = (result[ing.item][ing.name] || 0) + attributed;
      }
    }

    // แปลงเป็น array เรียงมาก->น้อย
    const data = {};
    for (const itemId of Object.keys(result)) {
      data[itemId] = Object.entries(result[itemId])
        .map(([menu, qty]) => ({ menu, qty: Number(qty.toFixed(2)) }))
        .filter(x => x.qty > 0)
        .sort((a, b) => b.qty - a.qty);
    }

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('usagemenu error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
