// ตารางรายการขาย (ระดับบิล) — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/bills?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status, branch, outletId, count, data:[ { date, checkID, tableID, cashierName, waiterName,
//        amount, beforeVat, vat, billTotal, billCost, paidType, memberTel, cover, coverAd, coverAll,
//        startTime, endTime, checkDesc, orderID } ] }
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
    // รวมบิลข้ามหลายวันบน office-server — ต้องให้เวลายาวกว่า timeout ดีฟอลต์ (ดู HEAVY_UPSTREAM_OPTS)
    const r = await fetchUpstream(`${USAGE_API_BASE}/bills?${params.toString()}`, HEAVY_UPSTREAM_OPTS);
    const payload = await r.json().catch(() => null);
    if (!r.ok || !payload || payload.status !== 'success') {
      return res.status(502).json({ status: 'error', message: (payload && payload.message) || `Office API Error: ${r.status}` });
    }
    return res.status(200).json(payload);
  } catch (error) {
    return replyUpstreamError(res, error, 'bills');
  }
}
