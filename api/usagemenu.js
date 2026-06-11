// ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง"
// Vercel ไม่ต่อ DB เอง — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/usagebymenu?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status:'success', data:{ "<itemCode>":[{menu, qty}, ...], ... } }
// ตั้งค่า env บน Vercel: USAGE_API_BASE (จำเป็น), USAGE_API_TOKEN (ถ้าตั้ง token ฝั่งออฟฟิศ)
const USAGE_API_BASE = process.env.USAGE_API_BASE || '';
const USAGE_API_TOKEN = process.env.USAGE_API_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {} });
  }

  if (!USAGE_API_BASE) {
    // ยังไม่ได้ตั้งค่า API ในออฟฟิศ -> คืนว่าง (หน้าจอจะ fallback ไปแสดงตามสูตร)
    return res.status(200).json({ status: 'success', data: {}, note: 'ยังไม่ได้ตั้งค่า USAGE_API_BASE' });
  }

  try {
    const url = `${USAGE_API_BASE.replace(/\/+$/, '')}/usagebymenu?branch=${encodeURIComponent(branchKey)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const r = await fetch(url, USAGE_API_TOKEN ? { headers: { 'x-api-token': USAGE_API_TOKEN } } : undefined);
    if (!r.ok) {
      return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    }
    const payload = await r.json();
    return res.status(200).json({ status: 'success', data: (payload && payload.data) ? payload.data : {} });
  } catch (error) {
    console.error('usagemenu error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
