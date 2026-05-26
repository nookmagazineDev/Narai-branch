export default async function handler(req, res) {
  // CORS setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

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
    'zk3': '906', 'zip': '12'
  };

  const branchKey = String(branch).toLowerCase().trim();
  const outletId = queryOutletId || branchMap[branchKey] || branchKey;

  // คำนวณ pstart = startDate - 1 วัน
  const startObj = new Date(startDate);
  startObj.setDate(startObj.getDate() - 1);
  const pstart = startObj.toISOString().split('T')[0];

  const url = `http://183.89.248.221:14369/api/trans/?outletid=${encodeURIComponent(outletId)}&start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}&pstart=${encodeURIComponent(pstart)}`;

  try {
    const fetchRes = await fetch(url);

    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `API Error: ${fetchRes.status}` });
    }

    const apiData = await fetchRes.json();

    if (Array.isArray(apiData)) {
      const usageMap = {};

      apiData.forEach(item => {
        // Item_code คือรหัสสินค้า, F5 คือยอดใช้ในระบบ
        const itmCode = item.Item_code;
        const qty = parseFloat(item.F5) || 0;

        if (itmCode) {
          const normId = String(itmCode).replace(/^0+/, '').toLowerCase();

          if (!usageMap[normId]) {
            usageMap[normId] = { total: 0, details: {} };
          }
          usageMap[normId].total += qty;

          // ใช้วันที่จาก item ถ้ามี หรือใช้ startDate เป็น fallback
          const dateKey = item.Date ? String(item.Date).split('T')[0] : startDate;
          if (!usageMap[normId].details[dateKey]) {
            usageMap[normId].details[dateKey] = 0;
          }
          usageMap[normId].details[dateKey] += qty;
        }
      });

      // Fix floating point precision
      Object.keys(usageMap).forEach(key => {
        usageMap[key].total = Number(usageMap[key].total.toFixed(2));
        Object.keys(usageMap[key].details).forEach(dateKey => {
          usageMap[key].details[dateKey] = Number(usageMap[key].details[dateKey].toFixed(2));
        });
      });

      return res.status(200).json({ status: 'success', data: usageMap });
    } else {
      return res.status(200).json({
        status: 'error',
        message: (apiData && apiData.message)
          ? `${apiData.message} (outletId: ${outletId})`
          : 'API ตอบกลับในรูปแบบที่ไม่ถูกต้อง'
      });
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
