// แดชบอร์ดสาขา — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/dashboard?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status, branch, outletId, data:{ sales, cost, prepCost, prepQty, profit, excludedCost, excludedQty, bills, covers, avgPerBill, daily:[{date,sales}] } }
// office-server มี cache รายวันอยู่แล้ว จึงตอบเร็วและส่ง payload เล็ก (เลี่ยงการดึงดิบ ~300MB/เดือนมาที่เบราว์เซอร์)
// hardcode base เดียวกับ api/usagemenu.js ที่พิสูจน์แล้วว่า Vercel เข้าถึง office-server ได้ (ไม่ใช้ env เพื่อตัดความเสี่ยงตั้งผิด)
const USAGE_API_BASE = 'http://storenarai.dyndns.tv:8787';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate, outletId } = req.query;
  if ((!branch && !outletId) || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา/รหัสสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch || '').toLowerCase().trim();
  try {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    if (branchKey) params.set('branch', branchKey);
    if (outletId) params.set('outletid', String(outletId));
    // โหมดค้นหารายการขาย (?itemsales=1) — ยอดขายรายเมนู รวม+รายวัน (รวมใน endpoint นี้เพราะลิมิต 12 functions)
    const path = req.query.itemsales ? 'itemsales' : 'dashboard';
    const r = await fetch(`${USAGE_API_BASE}/${path}?${params.toString()}`);
    const payload = await r.json().catch(() => null);
    if (!r.ok || !payload || payload.status !== 'success') {
      return res.status(502).json({ status: 'error', message: (payload && payload.message) || `Office API Error: ${r.status}` });
    }
    return res.status(200).json(payload);
  } catch (error) {
    console.error('dashboard error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
