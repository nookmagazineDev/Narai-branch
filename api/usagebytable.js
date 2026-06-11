// แสดง "โต๊ะที่ขายเมนูนี้" — proxy ไปที่ Narai Usage API ในออฟฟิศ
//   GET /usagebytable?branch&start&end&menu -> { status, data:[{table, qty}] }
const USAGE_API_BASE = 'http://storenarai.dyndns.tv:8787';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate, menu } = req.query;
  if (!branch || !startDate || !endDate || !menu) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่, และเมนูไม่ครบถ้วน' });
  }
  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: [] });
  }

  try {
    const url = `${USAGE_API_BASE}/usagebytable?branch=${encodeURIComponent(branchKey)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}&menu=${encodeURIComponent(menu)}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    const payload = await r.json();
    return res.status(200).json({ status: 'success', data: (payload && payload.data) ? payload.data : [] });
  } catch (error) {
    console.error('usagebytable error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
