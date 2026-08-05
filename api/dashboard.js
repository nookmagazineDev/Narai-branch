// แดชบอร์ดสาขา — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/dashboard?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status, branch, outletId, data:{ sales, cost, prepCost, prepQty, profit, excludedCost, excludedQty, bills, covers, avgPerBill, daily:[{date,sales}] } }
// office-server มี cache รายวันอยู่แล้ว จึงตอบเร็วและส่ง payload เล็ก (เลี่ยงการดึงดิบ ~300MB/เดือนมาที่เบราว์เซอร์)
// base URL + timeout/retry อยู่ที่ lib/upstream.js (ตั้ง env USAGE_API_BASE ทับได้เวลา dyndns/พอร์ตเปลี่ยน)
import { USAGE_API_BASE, HEAVY_UPSTREAM_OPTS, fetchUpstream, applyCors, replyUpstreamError } from '../lib/upstream.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

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
    // ทั้งสองโหมดคำนวณข้ามหลายวันบน office-server — ต้องให้เวลายาวกว่า timeout ดีฟอลต์ (ดู HEAVY_UPSTREAM_OPTS)
    const r = await fetchUpstream(`${USAGE_API_BASE}/${path}?${params.toString()}`, HEAVY_UPSTREAM_OPTS);
    const payload = await r.json().catch(() => null);
    if (!r.ok || !payload || payload.status !== 'success') {
      return res.status(502).json({ status: 'error', message: (payload && payload.message) || `Office API Error: ${r.status}` });
    }
    return res.status(200).json(payload);
  } catch (error) {
    return replyUpstreamError(res, error, 'dashboard');
  }
}
