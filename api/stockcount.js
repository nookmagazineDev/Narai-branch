// มูลค่าสต๊อกคงเหลือล่าสุด — อ่านจาก Google Sheet "ข้อมูลนับสตอค" (gviz, ชีทแชร์แบบ "ใครมีลิงก์ก็ดูได้")
//   GET /api/stockcount?branch=<code>&end=<YYYY-MM-DD>
//   -> { status, branch, countDate, count, data:[{itemCode,itemName,unit,qty}] }
//   เลือก "วันนับล่าสุดของสาขานั้นที่ <= end" แล้วคืนยอดคงเหลือรายสินค้าของวันนั้น
//   (ราคาต้นทุน/มูลค่า คิดฝั่งหน้าเว็บ โดยอิงราคาเบิกล่าสุดจากใบเบิก)
const SHEET_ID = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ';
const GID = '923363118'; // ชีท "ข้อมูลนับสตอค"

// "Date(2026,4,31)" -> "2026-05-31" (เดือน gviz เป็น 0-based)
function parseGvizDate(v) {
  const m = String(v == null ? '' : v).match(/Date\((\d+),(\d+),(\d+)/);
  if (!m) return '';
  return `${m[1]}-${String(+m[2] + 1).padStart(2, '0')}-${String(+m[3]).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const branchKey = String(req.query.branch || '').toLowerCase().trim();
  const endStr = String(req.query.end || '9999-12-31');
  if (!branchKey) return res.status(400).json({ status: 'error', message: 'ระบุสาขาไม่ครบถ้วน' });

  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${GID}`;
    const r = await fetch(url);
    const text = await r.text();
    if (text.startsWith('<')) {
      return res.status(502).json({ status: 'error', message: 'อ่านชีทสต๊อกไม่ได้ (ต้องตั้งแชร์ "ใครมีลิงก์ก็ดูได้")' });
    }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    const j = JSON.parse(text.substring(a, b + 1));
    // แถว: [0]วันที่ [1]ผู้นับ [2]สาขา [3]รหัสสินค้า [4]ชื่อ [5]หน่วย [6]คงเหลือ
    const rows = (j.table.rows || []).map((rw) => (rw.c || []).map((c) => (c ? c.v : null)));

    // หา "วันนับล่าสุด <= end" ของสาขานี้
    let countDate = '';
    for (const rw of rows) {
      if (String(rw[2] || '').toLowerCase().trim() !== branchKey) continue;
      const ds = parseGvizDate(rw[0]);
      if (!ds || ds > endStr) continue;
      if (ds > countDate) countDate = ds;
    }
    if (!countDate) {
      return res.status(200).json({ status: 'success', branch: branchKey, countDate: '', count: 0, data: [] });
    }

    // รวมยอดคงเหลือรายสินค้าของวันนับนั้น
    const map = {};
    for (const rw of rows) {
      if (String(rw[2] || '').toLowerCase().trim() !== branchKey) continue;
      if (parseGvizDate(rw[0]) !== countDate) continue;
      const code = String(rw[3] == null ? '' : rw[3]).replace(/\.0+$/, '').trim();
      if (!code) continue;
      const qty = Number(rw[6]) || 0;
      const e = map[code] || (map[code] = { itemCode: code, itemName: rw[4] || '-', unit: rw[5] || '', qty: 0 });
      e.qty += qty;
    }
    const data = Object.values(map);
    return res.status(200).json({ status: 'success', branch: branchKey, countDate, count: data.length, data });
  } catch (error) {
    console.error('stockcount error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
