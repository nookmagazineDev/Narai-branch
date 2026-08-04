// แสดง "โต๊ะที่ขายเมนูนี้" — proxy ไปที่ Narai Usage API ในออฟฟิศ
//   GET /usagebytable?branch&start&end&menu -> { status, data:[{table, qty}] }
import { USAGE_API_BASE, fetchUpstream, applyCors, replyUpstreamError } from '../lib/upstream.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

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
    const r = await fetchUpstream(url);
    if (!r.ok) return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    const payload = await r.json();
    return res.status(200).json({ status: 'success', data: (payload && payload.data) ? payload.data : [] });
  } catch (error) {
    return replyUpstreamError(res, error, 'usagebytable');
  }
}
