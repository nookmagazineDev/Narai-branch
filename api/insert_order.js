export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { outletId, deldate, no } = req.query;

  if (!outletId || !deldate || !no) {
    return res.status(400).json({ status: 'error', message: 'ระบุ outletId, deldate และ no ไม่ครบถ้วน' });
  }

  const url = `http://183.89.248.221:14369/api/insert_order?outletid=${encodeURIComponent(outletId)}&deldate=${encodeURIComponent(deldate)}&no=${encodeURIComponent(no)}`;

  try {
    const fetchRes = await fetch(url, { method: 'GET' });

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `API Error: ${fetchRes.status}` });
    }

    let apiData;
    const text = await fetchRes.text();
    try {
      apiData = JSON.parse(text);
    } catch {
      apiData = text;
    }

    return res.status(200).json({ status: 'success', data: apiData, orderNo: no });

  } catch (error) {
    console.error('insert_order error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
