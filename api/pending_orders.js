import mysql from 'mysql2/promise';

// ใบเบิกค้าง (สั่งแล้วยังไม่ได้รับของ) — อ่านตรงจาก myfbdata.orderd
//   ใบที่ยังไม่ได้รับ = ยังไม่มีรายการไหนถูกบันทึกรับเข้า (Ord_Rcv ยังว่าง)
//   ใบที่รับของแล้ว POS จะเติมค่า Ord_Rcv ให้ทุกแถว
// GET ?outletId=7[&days=120][&no=3498]

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

// รหัสสาขา → ชื่อฐานข้อมูลสาขา (ใช้อ่านเลขใบล่าสุดจาก config — ชุดเดียวกับ insert_order)
const DB_SUFFIX = {
  7: 'zjp', 12: 'crm', 19: 'xcm', 37: 'slr', 51: 'sum', 55: 'sts', 59: 'xum',
  61: 'scs', 63: 'smp', 67: 'xsb', 72: 'xhh', 78: 'hrs', 79: 'clk', 80: 'p90',
  400: 'zbw', 401: 'zpt', 501: 'wrm', 902: 'hps', 906: 'zk3', 950: 'fct',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { outletId, days, no } = req.query;
  if (!outletId) {
    return res.status(400).json({ status: 'error', message: 'ระบุ outletId ไม่ครบถ้วน' });
  }

  try {
    // ดูรายการสินค้าในใบเดียว
    if (no) {
      const [items] = await getPool().query(
        `SELECT Ord_Seq AS seq, Ord_ItmID AS itemId, Ord_itemCode AS itemCode,
                Ord_ItemName AS itemName, Ord_Qty AS qty, Ord_Unit AS unit,
                Ord_UnPr AS unitPrice, Ord_Rcv AS received
           FROM orderd WHERE Ord_StrID = ? AND Ord_No = ? ORDER BY Ord_Seq`,
        [Number(outletId), Number(no)]
      );
      return res.status(200).json({ status: 'success', no: Number(no), count: items.length, items });
    }

    const back = Math.min(Number(days) || 120, 400);

    // ตาราง orderd มี 2.2 ล้านแถวและไม่มี index ตามสาขา/วันที่ — คิวรีตรงๆ กวาดทั้งตาราง (6-9 วิ)
    // เร่งด้วยการอ่านเลขใบล่าสุดจาก config ของสาขา แล้วระบุช่วงเลขเป็นรายตัว (IN)
    // ให้ MySQL ใช้ PRIMARY KEY (Ord_No นำหน้า) ชี้ตรงจุด → เหลือ ~0.2 วิ
    let inClause = '';
    let inParams = [];
    const suffix = DB_SUFFIX[Number(outletId)];
    if (suffix) {
      try {
        const [cfg] = await getPool().query(`SELECT Cfg_LstOrdID AS v FROM \`myfbdata${suffix}\`.config LIMIT 1`);
        const last = Number(cfg[0]?.v) || 0;
        if (last > 0) {
          // 500 เลขย้อนหลังครอบคลุมเกิน 120 วันของทุกสาขา (สาขาที่สั่งถี่สุดใช้ ~210 เลข)
          const nos = [];
          for (let n = last + 10; n > Math.max(0, last - 500); n--) nos.push(n);
          inClause = 'Ord_No IN (?) AND ';
          inParams = [nos];
        }
      } catch (e) { /* อ่าน config ไม่ได้ → ใช้คิวรีเต็มตาราง */ }
    }

    const [rows] = await getPool().query(
      `SELECT Ord_No AS no,
              DATE_FORMAT(Ord_OrdDate, '%Y-%m-%d') AS orderDate,
              DATE_FORMAT(Ord_DelDate, '%Y-%m-%d') AS deldate,
              COUNT(*) AS itemCount,
              SUM(Ord_Qty) AS totalQty,
              SUM(COALESCE(Ord_Rcv, 0)) AS receivedQty
         FROM orderd
        WHERE ${inClause}Ord_StrID = ?
          AND Ord_OrdDate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY Ord_No, Ord_OrdDate, Ord_DelDate
        ORDER BY Ord_OrdDate DESC, Ord_No DESC`,
      [...inParams, Number(outletId), back]
    );

    const all = rows.map(r => ({
      no: r.no,
      orderDate: r.orderDate,
      deldate: r.deldate,
      itemCount: Number(r.itemCount),
      totalQty: r2(r.totalQty),
      received: Number(r.receivedQty) > 0,
      status: Number(r.receivedQty) > 0 ? 'รับของแล้ว' : 'รอรับของ',
    }));

    return res.status(200).json({
      status: 'success',
      data: all.filter(o => !o.received),  // เฉพาะที่ยังค้าง
      all,                                  // ทั้งหมดในช่วงเวลา
    });
  } catch (error) {
    console.error('pending_orders error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
