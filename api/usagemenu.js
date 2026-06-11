// ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง"
// อ่านจาก endpoint ของเซิร์ฟเวอร์ในออฟฟิศ (ต่อ MySQL POS ให้แล้ว) — Vercel ไม่ต้องต่อ DB เอง
//   GET {EXPRESS_BASE}/express/usagebymenu?branch=<code>&start=<YYYY-MM-DD>&end=<YYYY-MM-DD>
//   -> { status:'success', data:[ { code:'01000046', dtls:'<Usg_Dtls>' }, ... ] }
// Usg_Dtls แต่ละบรรทัด (คั่นด้วย \r): "ชื่อเมนู : จำนวนขาย (ปริมาณวัตถุดิบที่ใช้)"
const EXPRESS_BASE = process.env.EXPRESS_BASE || 'http://storenarai.dyndns.tv:14365';

function normItem(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}

// แยกบรรทัด Usg_Dtls -> [{ menu, used }]
function parseDtls(dtls) {
  if (!dtls) return [];
  const out = [];
  for (const raw of String(dtls).split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*) : ([-\d.]+) \(([-\d.]+)\)\s*$/);
    if (!m) continue;
    out.push({ menu: m[1].trim(), used: parseFloat(m[3]) || 0 });
  }
  return out;
}

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

  try {
    const url = `${EXPRESS_BASE}/express/usagebymenu?branch=${encodeURIComponent(branchKey)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ status: 'error', message: `Office API Error: ${r.status}` });
    }
    const payload = await r.json();
    const rows = Array.isArray(payload) ? payload : (payload && payload.data) ? payload.data : [];

    // รวมตามวัตถุดิบ -> เมนู
    const result = {}; // normItem -> { menu -> usedQty }
    for (const row of rows) {
      const item = normItem(row.code != null ? row.code : row.Itm_Code);
      if (!item) continue;
      const dtls = row.dtls != null ? row.dtls : row.Usg_Dtls;
      for (const { menu, used } of parseDtls(dtls)) {
        if (!menu || !used) continue;
        if (!result[item]) result[item] = {};
        result[item][menu] = (result[item][menu] || 0) + used;
      }
    }

    const data = {};
    for (const item of Object.keys(result)) {
      data[item] = Object.entries(result[item])
        .map(([menu, qty]) => ({ menu, qty: Number(qty.toFixed(2)) }))
        .filter(x => x.qty > 0)
        .sort((a, b) => b.qty - a.qty);
    }

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('usagemenu error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
