// ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง"
// Vercel ไม่ต่อ DB เอง — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/usagebymenu?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status:'success', data:{ "<itemCode>":[{menu, qty}, ...], ... } }
// ตั้งค่า env บน Vercel: USAGE_API_BASE (จำเป็น), USAGE_API_TOKEN (ถ้าตั้ง token ฝั่งออฟฟิศ)
// URL ของ Narai Usage API ที่รันในออฟฟิศ (ไม่ใช่ข้อมูลลับ — เป็น dyndns สาธารณะ)
import { USAGE_API_BASE, fetchUpstream, applyCors, replyUpstreamError } from '../lib/upstream.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const { branch, startDate, endDate } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  try {
    const url = `${USAGE_API_BASE}/usagebymenu?branch=${encodeURIComponent(branchKey)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const r = await fetchUpstream(url);
    if (!r.ok) {
      return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    }
    const payload = await r.json();
    return res.status(200).json({
      status: 'success',
      data: (payload && payload.data) ? payload.data : {},
      daily: (payload && payload.daily) ? payload.daily : {}, // ยอดใช้แยกรายวันต่อวัตถุดิบ
    });
  } catch (error) {
    return replyUpstreamError(res, error, 'usagemenu');
  }
}
