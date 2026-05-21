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

  const { branch, startDate, endDate } = req.query;

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
  const outletId = branchMap[branchKey] || branchKey;

  const url = `http://183.89.248.221:14369/api/trn_usg?outletid=${encodeURIComponent(outletId)}`;

  try {
    const fetchRes = await fetch(url);
    
    if (!fetchRes.ok) {
      return res.status(fetchRes.status).json({ status: 'error', message: `API Error: ${fetchRes.status}` });
    }

    const apiData = await fetchRes.json();

    if (Array.isArray(apiData)) {
      const usageMap = {};
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      apiData.forEach(item => {
        if (item.Usg_Date) {
          const d = new Date(item.Usg_Date);
          if (d >= start && d <= end) {
            const itmCode = item.Itm_Code;
            if (itmCode) {
              const normId = String(itmCode).replace(/^0+/, '').toLowerCase();
              const qty = parseFloat(item.Qty) || 0;
              if (!usageMap[normId]) usageMap[normId] = 0;
              usageMap[normId] += qty;
            }
          }
        }
      });
      
      return res.status(200).json({ status: 'success', data: usageMap });
    } else {
      return res.status(200).json({ 
        status: 'error', 
        message: `${apiData.message} (ลองค้นหาด้วยรหัส: ${outletId} จากสาขา: ${branchKey})` || 'API ตอบกลับในรูปแบบที่ไม่ถูกต้อง' 
      });
    }

  } catch (error) {
    console.error('Fetch error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
