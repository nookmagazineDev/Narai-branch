/*
 * เพิ่ม endpoint นี้เข้าไปใน "เซิร์ฟเวอร์ express เดิม" (ตัวที่รันพอร์ต 14365 / มี /express/ctranbetweendate)
 * พอร์ตนี้เปิดออกเน็ตอยู่แล้ว จึงไม่ต้องแตะ router
 *
 * หน้าที่: ดึงยอดใช้วัตถุดิบแยกตามเมนูของสาขา จากตาราง myfbdata<สาขา>.trn_usg
 *         (ใช้ MySQL connection/pool ตัวเดิมของเซิร์ฟเวอร์ — ตัวที่ต่อ inventory ได้อยู่แล้ว)
 *
 * เรียก: GET /express/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
 *        -> { status:'success', data:{ "1000046":[{menu,qty}, ...], ... } }
 *
 * วิธีติดตั้ง:
 *   1) ก๊อปฟังก์ชัน route ด้านล่างไปวางในไฟล์เดียวกับ /express/ctranbetweendate
 *   2) เปลี่ยน `pool` ให้เป็นชื่อตัวแปร MySQL connection/pool ที่เซิร์ฟเวอร์ใช้อยู่จริง
 *   3) restart เซิร์ฟเวอร์
 *   4) ตั้งค่า Vercel: USAGE_API_BASE = http://storenarai.dyndns.tv:14365/express
 *
 * ⚠️ MySQL user ของเซิร์ฟเวอร์ต้องมีสิทธิ์ SELECT บน database myfbdata* ทุกสาขา
 *    (ถ้าเดิมต่อแค่ mypos อาจต้อง GRANT เพิ่ม)
 */

// ===== เวอร์ชัน mysql2/promise (pool.query คืน [rows]) =====
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

    const [rows] = await pool.query(sql, [start, end]); // <-- ใช้ pool เดิมของเซิร์ฟเวอร์

    res.json({ status: 'success', data: buildUsageByMenu(rows) });
  } catch (e) {
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) {
      return res.json({ status: 'success', data: {} });
    }
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ===== ฟังก์ชันแกะ Usg_Dtls -> { itemCode: [{menu, qty}] } =====
function buildUsageByMenu(rows) {
  const norm = (id) => id == null ? '' : String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
  const result = {};
  for (const r of rows) {
    const item = norm(r.code);
    if (!item) continue;
    for (const raw of String(r.dtls || '').split(/[\r\n]+/)) {
      const line = raw.trim();
      if (!line) continue;
      // รูปแบบ: "ชื่อเมนู : จำนวนขาย (ปริมาณที่ใช้)"
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


/*
// ===== ถ้าเซิร์ฟเวอร์ใช้ mysql แบบ callback (connection.query(sql, params, cb)) =====
app.get('/express/usagebymenu', (req, res) => {
  const branch = String(req.query.branch || '').toLowerCase().trim();
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!branch || !start || !end) return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
  if (!/^[a-z0-9]+$/.test(branch)) return res.json({ status: 'success', data: {} });
  const db = 'myfbdata' + branch;
  const sql =
    'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
    'FROM `' + db + '`.trn_usg u ' +
    'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
    'WHERE u.Usg_Date BETWEEN ? AND ?';
  connection.query(sql, [start, end], (err, rows) => {
    if (err) {
      if (err.code === 'ER_BAD_DB_ERROR' || err.code === 'ER_NO_SUCH_TABLE') return res.json({ status: 'success', data: {} });
      return res.status(500).json({ status: 'error', message: err.message });
    }
    res.json({ status: 'success', data: buildUsageByMenu(rows) });
  });
});
*/
