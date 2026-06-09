// ดึงข้อมูล "ยอดใช้จากระบบ" จาก Google Sheet (ชีท UsageHistory) แทน API เดิม
// Spreadsheet: 1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg
// คอลัมน์ A: วันที่ | B: เลขสาขา | C: ชื่อสาขา | D: รหัสสินค้า | F: จำนวนที่ใช้ไป
const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SHEET_NAME = 'UsageHistory';

// แปลง column index (0-based) ตาม spec
const COL_DATE = 0;     // A
const COL_BRANCH_NO = 1; // B
const COL_BRANCH_NAME = 2; // C
const COL_ITEM_CODE = 3; // D
const COL_QTY = 5;       // F

// แปลงค่าวันที่จาก gviz ("Date(2026,3,11)") หรือข้อความ ให้เป็น "YYYY-MM-DD"
function toDateKey(cell) {
  if (!cell) return null;
  const raw = cell.v;
  if (raw && typeof raw === 'string') {
    const m = raw.match(/^Date\((\d+),(\d+),(\d+)/);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]) + 1; // gviz month เป็น 0-based
      const d = Number(m[3]);
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // fallback: ใช้ค่าที่ format มาแล้ว (pattern yyyy-mm-dd)
  if (cell.f) {
    const f = String(cell.f).trim();
    const m2 = f.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
  }
  return null;
}

// normalize รหัสสินค้า (ตัด 0 นำหน้า) ให้ตรงกับฝั่ง frontend
function normalizeId(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/^0+/, '').toLowerCase();
}

export default async function handler(req, res) {
  // CORS setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

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

  // แมปรหัสสาขาในเว็บ -> ชื่อสาขาในชีท (กรณีชื่อไม่ตรงกัน เช่น เว็บใช้ zjp แต่ชีทเป็น SJP)
  const branchAlias = {
    'zjp': 'sjp'
  };

  const branchKey = String(branch).toLowerCase().trim();
  // ชื่อสาขาที่คาดว่าจะอยู่ในชีท (คอลัมน์ C) ใช้ alias ถ้ามี
  const sheetBranchName = (branchAlias[branchKey] || branchKey).toLowerCase().trim();
  const outletId = String(queryOutletId || branchMap[branchKey] || '').trim();

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}`;

  try {
    const fetchRes = await fetch(url);

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `Google Sheet Error: ${fetchRes.status}` });
    }

    const text = await fetchRes.text();

    // แกะ JSON ออกจาก wrapper ของ gviz: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(502).json({ status: 'error', message: 'รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง' });
    }

    const parsed = JSON.parse(text.substring(start, end + 1));
    const rows = (parsed.table && parsed.table.rows) ? parsed.table.rows : [];

    const usageMap = {};

    rows.forEach(row => {
      const c = row.c;
      if (!c) return;

      // กรองตามสาขา: ตรงกับชื่อสาขา (คอลัมน์ C) หรือเลขสาขา (คอลัมน์ B)
      const rowBranchName = c[COL_BRANCH_NAME] && c[COL_BRANCH_NAME].v != null
        ? String(c[COL_BRANCH_NAME].v).toLowerCase().trim() : '';
      const rowBranchNo = c[COL_BRANCH_NO] && c[COL_BRANCH_NO].v != null
        ? String(c[COL_BRANCH_NO].v).replace(/\.0+$/, '').trim() : '';

      const matchByName = rowBranchName && rowBranchName === sheetBranchName;
      const matchByNo = outletId && rowBranchNo === outletId;
      if (!matchByName && !matchByNo) return;

      // กรองตามช่วงวันที่ (คอลัมน์ A)
      const dateKey = toDateKey(c[COL_DATE]);
      if (!dateKey) return;
      if (dateKey < startDate || dateKey > endDate) return;

      // รหัสสินค้า (คอลัมน์ D)
      const rawCode = c[COL_ITEM_CODE] && c[COL_ITEM_CODE].v != null ? c[COL_ITEM_CODE].v : null;
      if (rawCode === null) return;
      // ตัดทศนิยม .0 ที่ติดมาจากตัวเลข เช่น 1000045.0
      const codeStr = String(rawCode).replace(/\.0+$/, '');
      const normId = normalizeId(codeStr);
      if (!normId) return;

      // จำนวนที่ใช้ไป (คอลัมน์ F)
      const qty = c[COL_QTY] && c[COL_QTY].v != null ? parseFloat(c[COL_QTY].v) || 0 : 0;

      if (!usageMap[normId]) {
        usageMap[normId] = { total: 0, details: {} };
      }
      usageMap[normId].total += qty;
      if (!usageMap[normId].details[dateKey]) {
        usageMap[normId].details[dateKey] = 0;
      }
      usageMap[normId].details[dateKey] += qty;
    });

    // Fix floating point precision
    Object.keys(usageMap).forEach(key => {
      usageMap[key].total = Number(usageMap[key].total.toFixed(2));
      Object.keys(usageMap[key].details).forEach(dateKey => {
        usageMap[key].details[dateKey] = Number(usageMap[key].details[dateKey].toFixed(2));
      });
    });

    return res.status(200).json({ status: 'success', data: usageMap });

  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
