// ดึงสูตรเมนู (RcpDtls) จาก Google Sheet เพื่อสร้าง map: รหัสวัตถุดิบ -> รายชื่อเมนูที่ใช้วัตถุดิบนั้น
// Spreadsheet: 1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg | ชีท RcpDtls
// คอลัมน์ A: รหัสเมนู | C: ชื่อเมนู | E: รหัสวัตถุดิบ | J: รหัสวัตถุดิบ (ตัด 0 นำหน้า)
const SHEET_ID = '1TjvtUUxxVi3Dc5q1kvzrt--g_AHQO3z8EF-b3viHIRg';
const SHEET_NAME = 'RcpDtls';

const COL_MENU_CODE = 0;  // A
const COL_MENU_NAME = 2;  // C
const COL_ITEM_CODE = 4;  // E

function normalizeId(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}

export default async function handler(req, res) {
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

  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_NAME)}`;

  try {
    const fetchRes = await fetch(url);
    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `Google Sheet Error: ${fetchRes.status}` });
    }

    const text = await fetchRes.text();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(502).json({ status: 'error', message: 'รูปแบบข้อมูลจาก Google Sheet ไม่ถูกต้อง' });
    }

    const parsed = JSON.parse(text.substring(start, end + 1));
    const rows = (parsed.table && parsed.table.rows) ? parsed.table.rows : [];

    // map: normId -> Set ของชื่อเมนู (กันซ้ำ)
    const menuSets = {};

    rows.forEach(row => {
      const c = row.c;
      if (!c) return;

      // ข้ามแถวหัวตาราง/หมายเหตุ: ต้องมีรหัสเมนู (คอลัมน์ A) เป็นตัวเลข
      const menuCodeCell = c[COL_MENU_CODE];
      const menuCode = menuCodeCell && menuCodeCell.v != null ? menuCodeCell.v : null;
      if (menuCode === null || isNaN(Number(menuCode))) return;

      const menuName = c[COL_MENU_NAME] && c[COL_MENU_NAME].v != null
        ? String(c[COL_MENU_NAME].v).trim() : '';
      const rawItem = c[COL_ITEM_CODE] && c[COL_ITEM_CODE].v != null ? c[COL_ITEM_CODE].v : null;
      if (!menuName || rawItem === null) return;

      const normId = normalizeId(rawItem);
      if (!normId) return;

      if (!menuSets[normId]) menuSets[normId] = new Set();
      menuSets[normId].add(menuName);
    });

    // แปลง Set -> array เรียงตามชื่อ
    const data = {};
    Object.keys(menuSets).forEach(key => {
      data[key] = Array.from(menuSets[key]).sort((a, b) => a.localeCompare(b, 'th'));
    });

    return res.status(200).json({ status: 'success', data });

  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
