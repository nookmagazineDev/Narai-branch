/*
 * Endpoint สำหรับ "เซิร์ฟเวอร์ express ในออฟฟิศ" (ตัวเดียวกับที่มี /express/ctranbetweendate)
 * หน้าที่: ดึงข้อมูลการใช้วัตถุดิบรายวันของสาขาจากตาราง trn_usg ส่งกลับเป็น raw
 *         แล้วฝั่ง Vercel (api/usagemenu.js) จะแกะ Usg_Dtls + รวมยอดเอง
 *
 * วิธีติดตั้ง:
 *   1) เอาฟังก์ชัน route ด้านล่างไปวางในไฟล์เดียวกับ /express/ctranbetweendate
 *   2) เปลี่ยน `pool` ให้เป็นตัวแปร connection/pool ของ MySQL ที่เซิร์ฟเวอร์ใช้อยู่แล้ว
 *      (ตัวที่ต่อ inventory.dyndns.tv อยู่ — ต้องมีสิทธิ์อ่าน database myfbdata*<สาขา>)
 *   3) ถ้าเซิร์ฟเวอร์ใช้ mysql แบบ callback ดูเวอร์ชัน callback ด้านล่างสุด
 *
 * เรียกใช้:
 *   GET /express/usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
 *   -> { "status":"success", "data":[ { "code":"01000046", "dtls":"<Usg_Dtls>" }, ... ] }
 */

// ===== เวอร์ชัน mysql2/promise (แนะนำ) =====
app.get('/express/usagebymenu', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');

    if (!branch || !start || !end) {
      return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
    }
    // กันค่าแปลกปลอม (ใช้ประกอบชื่อ database)
    if (!/^[a-z0-9]+$/.test(branch)) {
      return res.json({ status: 'success', data: [] });
    }
    const db = 'myfbdata' + branch; // เช่น zjp -> myfbdatazjp

    const sql =
      'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
      'FROM `' + db + '`.trn_usg u ' +
      'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
      'WHERE u.Usg_Date BETWEEN ? AND ?';

    const [rows] = await pool.query(sql, [start, end]);
    return res.json({ status: 'success', data: rows });
  } catch (e) {
    // ไม่มี database ของสาขานั้น -> ส่งว่าง (ฝั่งหน้าเว็บจะ fallback)
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) {
      return res.json({ status: 'success', data: [] });
    }
    return res.status(500).json({ status: 'error', message: e.message });
  }
});


/*
// ===== เวอร์ชัน mysql แบบ callback (ถ้าเซิร์ฟเวอร์ใช้แบบนี้) =====
app.get('/express/usagebymenu', (req, res) => {
  const branch = String(req.query.branch || '').toLowerCase().trim();
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!branch || !start || !end) return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
  if (!/^[a-z0-9]+$/.test(branch)) return res.json({ status: 'success', data: [] });
  const db = 'myfbdata' + branch;
  const sql =
    'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
    'FROM `' + db + '`.trn_usg u ' +
    'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
    'WHERE u.Usg_Date BETWEEN ? AND ?';
  connection.query(sql, [start, end], (err, rows) => {
    if (err) {
      if (err.code === 'ER_BAD_DB_ERROR' || err.code === 'ER_NO_SUCH_TABLE') return res.json({ status: 'success', data: [] });
      return res.status(500).json({ status: 'error', message: err.message });
    }
    res.json({ status: 'success', data: rows });
  });
});
*/
