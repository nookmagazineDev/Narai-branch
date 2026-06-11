/*
 * เพิ่ม endpoint นี้เข้าไปใน "เซิร์ฟเวอร์ express เดิม" (ตัวที่รันพอร์ต 14365 / มี /express/ctranbetweendate)
 * พอร์ต 14365 เปิดออกเน็ตอยู่แล้ว จึงไม่ต้องแตะ router
 *
 * ✅ snippet นี้ "สร้าง MySQL pool ของตัวเอง" ไม่ต้องพึ่ง connection เดิมของเซิร์ฟเวอร์
 *    -> แค่วางโค้ด + ติดตั้ง mysql2 + restart ก็ใช้ได้เลย
 *
 * ขั้นตอน (ที่เครื่องซึ่งรันเซิร์ฟเวอร์ 14365):
 *   1) ติดตั้ง driver:  npm install mysql2
 *   2) ก๊อปทั้งบล็อกนี้ไปวางในไฟล์เดียวกับ /express/ctranbetweendate (ที่มีตัวแปร app อยู่แล้ว)
 *   3) restart เซิร์ฟเวอร์
 *   4) ตั้ง Vercel: USAGE_API_BASE = http://storenarai.dyndns.tv:14365/express
 *
 * เรียก: GET /express/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
 *        -> { status:'success', data:{ "1000046":[{menu,qty}, ...], ... } }
 *
 * หมายเหตุ: ถ้าไฟล์เซิร์ฟเวอร์ใช้ ESM (import) ให้เปลี่ยนบรรทัด require เป็น:
 *           import mysql from 'mysql2/promise';
 */

const mysql = require('mysql2/promise');

// --- ตั้งค่าการต่อ MySQL (แก้ได้ถ้าจำเป็น) ---
const usagePool = mysql.createPool({
  host: 'inventory.dyndns.tv',
  port: 3306,
  user: 'root',
  password: '5021',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // ให้ DATE เป็น 'YYYY-MM-DD' กันปัญหา timezone
});

app.get('/express/usagebymenu', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    if (!branch || !start || !end) {
      return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
    }
    if (!/^[a-z0-9]+$/.test(branch)) return res.json({ status: 'success', data: {} });
    const db = 'myfbdata' + branch; // เช่น zjp -> myfbdatazjp

    const sql =
      'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
      'FROM `' + db + '`.trn_usg u ' +
      'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
      'WHERE u.Usg_Date BETWEEN ? AND ?';

    const [rows] = await usagePool.query(sql, [start, end]);
    res.json({ status: 'success', data: buildUsageByMenu(rows) });
  } catch (e) {
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) {
      return res.json({ status: 'success', data: {} });
    }
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// แกะ Usg_Dtls ("ชื่อเมนู : จำนวนขาย (ปริมาณที่ใช้)") -> { itemCode: [{menu, qty}] }
function buildUsageByMenu(rows) {
  const norm = (id) => id == null ? '' : String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
  const result = {};
  for (const r of rows) {
    const item = norm(r.code);
    if (!item) continue;
    for (const raw of String(r.dtls || '').split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(.*) : ([-\d.]+) \(([-\d.]+)\)\s*$/);
      if (!m) continue;
      const menu = m[1].trim();
      const used = parseFloat(m[3]) || 0;
      if (!menu || !used) continue;
      if (!result[item]) result[item] = {};
      result[item][menu] = (result[item][menu] || 0) + used;
    }
  }
  const data = {};
  for (const item of Object.keys(result)) {
    data[item] = Object.entries(result[item])
      .map(([menu, qty]) => ({ menu, qty: Number(qty.toFixed(2)) }))
      .filter((x) => x.qty > 0)
      .sort((a, b) => b.qty - a.qty);
  }
  return data;
}
