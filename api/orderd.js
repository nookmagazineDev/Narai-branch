export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { branch, startDate, endDate, outletId: queryOutletId } = req.query;

  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  const branchMap = {
    'sjp': '7', 'crm': '12', 'xcm': '19', 'slr': '37', 'sum': '51',
    'xum': '59', 'scs': '61', 'smp': '63', 'xsb': '67', 'xhh': '72',
    'hrs': '78', 'clk': '79', 'p90': '80', 'hps': '109', 'zbw': '400',
    'zpt': '401', 'npt': '500', 'wrm': '501', 'wmt': '503', 'ipr': '904',
    'zk3': '906'
  };

  const branchKey = String(branch).toLowerCase().trim();
  const outletId = queryOutletId || branchMap[branchKey] || branchKey;

  const url = `http://183.89.248.221:14369/api/orderd?outletid=${encodeURIComponent(outletId)}`;

  try {
    const fetchRes = await fetch(url);

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `API Error: ${fetchRes.status}` });
    }

    const apiData = await fetchRes.json();

    if (Array.isArray(apiData)) {
      const receivedMap = {};
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      apiData.forEach(item => {
        if (item.Ord_DelDate) {
          const d = new Date(item.Ord_DelDate);
          if (d >= start && d <= end) {
            const itmCode = item.Ord_itemCode;
            if (itmCode) {
              const normId = String(itmCode).replace(/^0+/, '').toLowerCase();
              const qty = parseFloat(item.Ord_Qty) || 0;
              if (!receivedMap[normId]) {
                receivedMap[normId] = { total: 0, details: {}, unit: item.Ord_Unit || '' };
              }
              receivedMap[normId].total += qty;

              const dateKey = item.Ord_DelDate.split('T')[0];
              if (!receivedMap[normId].details[dateKey]) {
                receivedMap[normId].details[dateKey] = 0;
              }
              receivedMap[normId].details[dateKey] += qty;
            }
          }
        }
      });

      // Fix floating point precision
      Object.keys(receivedMap).forEach(key => {
        receivedMap[key].total = Number(receivedMap[key].total.toFixed(2));
        Object.keys(receivedMap[key].details).forEach(dateKey => {
          receivedMap[key].details[dateKey] = Number(receivedMap[key].details[dateKey].toFixed(2));
        });
      });

      return res.status(200).json({ status: 'success', data: receivedMap });
    } else {
      return res.status(200).json({
        status: 'error',
        message: `${apiData.message} (รหัส: ${outletId} / สาขา: ${branchKey})` || 'API ตอบกลับในรูปแบบที่ไม่ถูกต้อง'
      });
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
