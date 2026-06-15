import mysql from 'mysql2/promise';

// ใบรับ (ยอดรับเข้าสาขา) — ดึงตรงจาก MySQL: inventory.dyndns.tv / myfbdata.trans
// ของที่รับเข้าสาขาถูกบันทึกเป็น Trn_Type IN ('TRF','RCV') โดยปลายทาง Trn_To = เลขสาขา
// (ต้องกรอง type เพราะ SLS = การขาย ก็มี Trn_To = สาขาเช่นกัน)

let pool;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'inventory.dyndns.tv',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'myfbdata',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
    });
  }
  return pool;
}

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

  try {
    const [rows] = await getPool().query(
      `SELECT Trn_itemCode AS itemCode, Trn_Unit AS unit,
              DATE_FORMAT(Trn_DocDate, '%Y-%m-%d') AS d,
              SUM(Trn_InvQty) AS qty
         FROM trans
        WHERE Trn_Type IN ('TRF','RCV')
          AND Trn_To = ?
          AND Trn_DocDate BETWEEN ? AND ?
        GROUP BY Trn_itemCode, Trn_Unit, d`,
      [outletId, startDate, endDate]
    );

    const receivedMap = {};
    for (const r of rows) {
      if (!r.itemCode) continue;
      const normId = String(r.itemCode).replace(/^0+/, '').toLowerCase();
      const qty = Number(r.qty) || 0;
      if (!receivedMap[normId]) {
        receivedMap[normId] = { total: 0, details: {}, unit: r.unit || '' };
      }
      receivedMap[normId].total += qty;
      receivedMap[normId].details[r.d] = (receivedMap[normId].details[r.d] || 0) + qty;
      if (!receivedMap[normId].unit && r.unit) receivedMap[normId].unit = r.unit;
    }

    // Fix floating point precision
    Object.keys(receivedMap).forEach(key => {
      receivedMap[key].total = Number(receivedMap[key].total.toFixed(2));
      Object.keys(receivedMap[key].details).forEach(dateKey => {
        receivedMap[key].details[dateKey] = Number(receivedMap[key].details[dateKey].toFixed(2));
      });
    });

    return res.status(200).json({ status: 'success', data: receivedMap });
  } catch (error) {
    console.error('MySQL orderd error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
