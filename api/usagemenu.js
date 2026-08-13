// ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง" และ "แยกตามโต๊ะ"
// Vercel ไม่ต่อ DB เอง — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET /api/usagemenu?branch&startDate&endDate            -> usagebymenu
//        -> { status:'success', data:{ "<itemCode>":[{menu, qty}, ...] }, daily:{...} }
//   GET /api/usagemenu?bytable=1&branch&startDate&endDate&menu -> usagebytable
//        -> { status:'success', data:[{table, qty}] }
// สองโหมดอยู่ไฟล์เดียวกันเพราะ Vercel จำกัด 12 Serverless Functions (เดิมแยกเป็น api/usagebytable.js)
// ตั้งค่า env บน Vercel: USAGE_API_BASE (จำเป็น), USAGE_API_TOKEN (ถ้าตั้ง token ฝั่งออฟฟิศ)
import { USAGE_API_BASE, fetchUpstream, applyCors, replyUpstreamError } from '../lib/upstream.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const { branch, startDate, endDate, menu } = req.query;
  const byTable = Boolean(req.query.bytable);
  const emptyResult = byTable ? [] : {};

  if (!branch || !startDate || !endDate || (byTable && !menu)) {
    return res.status(400).json({
      status: 'error',
      message: byTable
        ? 'ระบุสาขา, วันที่, และเมนูไม่ครบถ้วน'
        : 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน',
    });
  }

  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: emptyResult });
  }

  try {
    const params = new URLSearchParams({ branch: branchKey, start: startDate, end: endDate });
    if (byTable) params.set('menu', String(menu));
    const path = byTable ? 'usagebytable' : 'usagebymenu';

    const r = await fetchUpstream(`${USAGE_API_BASE}/${path}?${params.toString()}`);
    if (!r.ok) {
      return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    }
    const payload = await r.json();

    if (byTable) {
      return res.status(200).json({
        status: 'success',
        data: (payload && payload.data) ? payload.data : [],
      });
    }
    return res.status(200).json({
      status: 'success',
      data: (payload && payload.data) ? payload.data : {},
      daily: (payload && payload.daily) ? payload.daily : {}, // ยอดใช้แยกรายวันต่อวัตถุดิบ
    });
  } catch (error) {
    return replyUpstreamError(res, error, byTable ? 'usagebytable' : 'usagemenu');
  }
}
