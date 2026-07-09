// ราคาต้นทุนต่อหน่วยจากชีท "8.2" (ไฟล์สต๊อก) — ใช้ในหน้ากรอกรายจ่าย (ต้นทุนจาก Supplier)
//   GET /api/supprices -> { status, data: { "<code>": { name, price } } }
//   code ถูก normalize ตัดเลข 0 นำหน้าแล้ว
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const PRICE_SHEET = '8.2';

const normCode = (c) => String(c == null ? '' : c).replace(/\.0+$/, '').replace(/^0+/, '').trim();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(PRICE_SHEET)}`;
    const r = await fetch(url);
    const text = await r.text();
    if (text.startsWith('<')) {
      return res.status(502).json({ status: 'error', message: 'อ่านชีท 8.2 ไม่ได้ (ต้องแชร์ "ใครมีลิงก์ก็ดูได้")' });
    }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    const j = JSON.parse(text.substring(a, b + 1));
    const data = {};
    for (const rw of (j.table.rows || [])) {
      const c = rw.c || [];
      const code = normCode(c[0] && c[0].v);
      if (!code) continue;
      const price = Number(c[2] && c[2].v);
      const name = c[1] && c[1].v != null ? String(c[1].v).trim() : '';
      if (!Number.isNaN(price)) data[code] = { name, price };
    }
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('supprices error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
