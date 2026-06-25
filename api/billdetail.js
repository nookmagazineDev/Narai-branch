// รายละเอียดรายการในบิล (line items) — proxy ไปที่ Narai Usage API ที่รันในออฟฟิศ (ดู office-server/)
//   GET {USAGE_API_BASE}/billdetail?branch=<code>&date=<YYYY-MM-DD>&checkid=<id>
//   -> { status, branch, outletId, date, checkID, data:[ { itemCode, name, qty, unitPrice, grossPrice,
//        tax, unitCost, lineCost, tableID, prtOrdTime, orderID, void } ] }
const USAGE_API_BASE = 'http://storenarai.dyndns.tv:8787';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, date, checkID, outletId } = req.query;
  if ((!branch && !outletId) || !date || !checkID) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา/รหัสสาขา, วันที่ และเลขที่บิลไม่ครบถ้วน' });
  }

  const branchKey = String(branch || '').toLowerCase().trim();
  try {
    const params = new URLSearchParams({ date: String(date), checkid: String(checkID) });
    if (branchKey) params.set('branch', branchKey);
    if (outletId) params.set('outletid', String(outletId));
    const r = await fetch(`${USAGE_API_BASE}/billdetail?${params.toString()}`);
    const payload = await r.json().catch(() => null);
    if (!r.ok || !payload || payload.status !== 'success') {
      return res.status(502).json({ status: 'error', message: (payload && payload.message) || `Office API Error: ${r.status}` });
    }
    return res.status(200).json(payload);
  } catch (error) {
    console.error('billdetail error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
