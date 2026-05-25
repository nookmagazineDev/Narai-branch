export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { outletId } = req.query;

  if (!outletId) {
    return res.status(400).json({ status: 'error', message: 'ระบุ outletId ไม่ครบถ้วน' });
  }

  // ดึงรายการใบเบิกทั้งหมดของสาขา แล้วกรองเฉพาะที่ยังไม่ได้รับ (pending)
  const url = `http://183.89.248.221:14369/api/get_orders?outletid=${encodeURIComponent(outletId)}`;

  try {
    const fetchRes = await fetch(url);

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `API Error: ${fetchRes.status}` });
    }

    const apiData = await fetchRes.json();

    if (Array.isArray(apiData)) {
      // กรองเฉพาะใบเบิกที่ยังไม่ได้รับของ (status pending)
      const pending = apiData.filter(order => {
        const status = String(order.status || order.Status || order.Ord_Status || '').toLowerCase();
        return status === 'pending' || status === '0' || status === 'n' || status === 'new' || status === '';
      });
      return res.status(200).json({ status: 'success', data: pending, all: apiData });
    } else {
      return res.status(200).json({ status: 'success', data: [], all: [], raw: apiData });
    }

  } catch (error) {
    console.error('pending_orders error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
