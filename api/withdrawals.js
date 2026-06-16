import mysql from 'mysql2/promise';

// ใบเบิก (รายการเอกสารโอน/รับเข้าสาขา) — ดึงตรงจาก MySQL: inventory.dyndns.tv / myfbdata.trans
// จัดกลุ่มตาม Trn_InvNo (เลขที่ใบเบิก) พร้อมรายการสินค้าในแต่ละใบ
// ใช้เกณฑ์เดียวกับใบรับ: Trn_Type IN ('TRF','RCV') ที่ Trn_To = เลขสาขา ในช่วง Trn_DocDate

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

const r2 = (n) => Number((Number(n) || 0).toFixed(2));

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
      `SELECT Trn_InvNo AS invNo, Trn_Type AS docType, Trn_DocNo AS docNo,
              DATE_FORMAT(Trn_DocDate, '%Y-%m-%d') AS docDate,
              Trn_itemCode AS itemCode, Trn_itemName AS itemName,
              Trn_InvQty AS qty, Trn_Unit AS unit, Trn_UnitPr AS unitPrice
         FROM trans
        WHERE Trn_Type IN ('TRF','RCV')
          AND Trn_To = ?
          AND Trn_DocDate BETWEEN ? AND ?
        ORDER BY Trn_DocDate DESC, Trn_InvNo DESC, Trn_Seq ASC`,
      [outletId, startDate, endDate]
    );

    // จัดกลุ่มเป็นใบเบิกตาม Trn_InvNo
    const docsMap = {};
    const order = [];
    for (const r of rows) {
      const key = r.invNo || `DOC-${r.docNo}`;
      if (!docsMap[key]) {
        docsMap[key] = {
          invNo: r.invNo || '',
          docNo: r.docNo,
          docDate: r.docDate,
          docType: r.docType,
          items: [],
          itemCount: 0,
          totalQty: 0,
          totalAmt: 0,
        };
        order.push(key);
      }
      const qty = Number(r.qty) || 0;
      const price = Number(r.unitPrice) || 0;
      const doc = docsMap[key];
      doc.items.push({
        itemCode: r.itemCode || '',
        itemName: r.itemName || '',
        qty: r2(qty),
        unit: r.unit || '',
        unitPrice: r2(price),
        amount: r2(qty * price),
      });
      doc.itemCount += 1;
      doc.totalQty += qty;
      doc.totalAmt += qty * price;
    }

    const data = order.map(k => {
      const d = docsMap[k];
      d.totalQty = r2(d.totalQty);
      d.totalAmt = r2(d.totalAmt);
      return d;
    });

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('MySQL withdrawals error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
