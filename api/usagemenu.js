// คำนวณ "ยอดใช้วัตถุดิบ แยกตามเมนูที่ขายจริง" (Method 2)
// = ยอดขายรายเมนู (ชีท MenuSales) x ปริมาณวัตถุดิบต่อจานในสูตร (ชีท RcpDtls)
// Spreadsheet: 1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg
//
// ชีท MenuSales (ต้องสร้างเอง): A=วันที่(YYYY-MM-DD) B=เลขสาขา C=ชื่อสาขา D=รหัสเมนู E=ชื่อเมนู F=จำนวนที่ขาย
// ชีท RcpDtls: A=รหัสเมนู C=ชื่อเมนู E=รหัสวัตถุดิบ G=ปริมาณใช้ I=yield(หน่วยต่อ stock unit)  -> qty/จาน = G/I
const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const MENU_SALES_SHEET = 'MenuSales';
const RECIPE_SHEET = 'RcpDtls';

// MenuSales columns
const MS_DATE = 0, MS_BRANCH_NO = 1, MS_BRANCH_NAME = 2, MS_MENU_CODE = 3, MS_QTY = 5;
// RcpDtls columns
const RC_MENU_CODE = 0, RC_MENU_NAME = 2, RC_ITEM_CODE = 4, RC_USE = 6, RC_YIELD = 8;

function normItem(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}
function normMenu(code) {
  if (code === null || code === undefined) return '';
  const n = Number(code);
  return isNaN(n) ? String(code).trim() : String(n);
}
function toDateKey(cell) {
  if (!cell) return null;
  const raw = cell.v;
  if (raw && typeof raw === 'string') {
    const m = raw.match(/^Date\((\d+),(\d+),(\d+)/);
    if (m) return `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  if (cell.f) {
    const m2 = String(cell.f).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
  }
  return null;
}
function gvizRows(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  const parsed = JSON.parse(text.substring(start, end + 1));
  return (parsed.table && parsed.table.rows) ? parsed.table.rows : [];
}
async function fetchSheet(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Google Sheet Error (${name}): ${r.status}`);
  return gvizRows(await r.text());
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

  const branchMap = {
    'sjp': '7', 'zjp': '7', 'crm': '12', 'xcm': '19', 'slr': '37', 'sum': '51',
    'xum': '59', 'scs': '61', 'smp': '63', 'xsb': '67', 'xhh': '72',
    'hrs': '78', 'clk': '79', 'p90': '80', 'hps': '109', 'zbw': '400',
    'zpt': '401', 'npt': '500', 'wrm': '501', 'wmt': '503', 'ipr': '904',
    'zk3': '906', 'zip': '12'
  };
  const branchAlias = { 'zjp': 'sjp' };

  const branchKey = String(branch).toLowerCase().trim();
  const sheetBranchName = (branchAlias[branchKey] || branchKey).toLowerCase().trim();
  const outletId = String(queryOutletId || branchMap[branchKey] || '').trim();

  try {
    let salesRows;
    try {
      salesRows = await fetchSheet(MENU_SALES_SHEET);
    } catch (e) {
      // ยังไม่มีชีท MenuSales — คืน data ว่าง (ฝั่งหน้าจอจะ fallback ไปแสดงตามสูตร)
      return res.status(200).json({ status: 'success', data: {}, note: 'ยังไม่มีชีท MenuSales' });
    }

    // 1) รวมยอดขายต่อเมนู (กรองสาขา + ช่วงวันที่)
    const menuSales = {};   // menuCode -> qty รวม
    (salesRows || []).forEach(row => {
      const c = row.c;
      if (!c) return;
      const rBrName = c[MS_BRANCH_NAME] && c[MS_BRANCH_NAME].v != null ? String(c[MS_BRANCH_NAME].v).toLowerCase().trim() : '';
      const rBrNo = c[MS_BRANCH_NO] && c[MS_BRANCH_NO].v != null ? String(c[MS_BRANCH_NO].v).replace(/\.0+$/, '').trim() : '';
      if (!((rBrName && rBrName === sheetBranchName) || (outletId && rBrNo === outletId))) return;

      const dateKey = toDateKey(c[MS_DATE]);
      if (!dateKey || dateKey < startDate || dateKey > endDate) return;

      const menuCode = normMenu(c[MS_MENU_CODE] && c[MS_MENU_CODE].v != null ? c[MS_MENU_CODE].v : null);
      if (!menuCode) return;
      const qty = c[MS_QTY] && c[MS_QTY].v != null ? parseFloat(c[MS_QTY].v) || 0 : 0;
      menuSales[menuCode] = (menuSales[menuCode] || 0) + qty;
    });

    if (Object.keys(menuSales).length === 0) {
      return res.status(200).json({ status: 'success', data: {} });
    }

    // 2) กระจายยอดขายเมนูลงวัตถุดิบตามสูตร
    const recipeRows = await fetchSheet(RECIPE_SHEET);
    const result = {}; // normItemId -> { menuName -> qty }
    (recipeRows || []).forEach(row => {
      const c = row.c;
      if (!c) return;
      const menuCode = normMenu(c[RC_MENU_CODE] && c[RC_MENU_CODE].v != null ? c[RC_MENU_CODE].v : null);
      if (!menuCode || menuSales[menuCode] === undefined) return;

      const itemId = normItem(c[RC_ITEM_CODE] && c[RC_ITEM_CODE].v != null ? c[RC_ITEM_CODE].v : null);
      if (!itemId) return;
      const menuName = c[RC_MENU_NAME] && c[RC_MENU_NAME].v != null ? String(c[RC_MENU_NAME].v).trim() : '(ไม่ทราบชื่อเมนู)';

      const use = c[RC_USE] && c[RC_USE].v != null ? Number(c[RC_USE].v) : null;
      const yield_ = c[RC_YIELD] && c[RC_YIELD].v != null ? Number(c[RC_YIELD].v) : null;
      let perUnit;
      if (use != null && yield_ != null && yield_ !== 0) perUnit = use / yield_;
      else if (use != null) perUnit = use;
      else return;

      const attributed = menuSales[menuCode] * perUnit;
      if (!attributed) return;

      if (!result[itemId]) result[itemId] = {};
      result[itemId][menuName] = (result[itemId][menuName] || 0) + attributed;
    });

    // 3) แปลงเป็น array เรียงจากมากไปน้อย + ปัดทศนิยม
    const data = {};
    Object.keys(result).forEach(itemId => {
      data[itemId] = Object.entries(result[itemId])
        .map(([menu, qty]) => ({ menu, qty: Number(qty.toFixed(2)) }))
        .filter(x => x.qty > 0)
        .sort((a, b) => b.qty - a.qty);
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
