// ยอดใช้วัตถุดิบ "แยกตามเมนูที่ขายจริง" — อ่านจากฐานข้อมูล POS โดยตรง (เร็ว+แม่นยำ)
// ระบบ POS คำนวณยอดใช้แยกเมนูไว้ให้แล้วในตาราง trn_usg.Usg_Dtls ของแต่ละสาขา
//
// แต่ละสาขามี database ของตัวเอง: myfbdata<branchcode> เช่น zjp -> myfbdatazjp
//   trn_usg: Usg_Date, Usg_ItemID, Usg_Qty(รวม), Usg_Dtls(รายละเอียดเมนู)
//   item:    Itm_ID, Itm_Code(รหัสวัตถุดิบ)
//   Usg_Dtls รูปแบบต่อบรรทัด (คั่นด้วย \r): "ชื่อเมนู : จำนวนขาย (ปริมาณวัตถุดิบที่ใช้)"
//
// credentials เก็บใน Environment Variables (ตั้งบน Vercel): MYSQL_HOST/PORT/USER/PASSWORD
import mysql from 'mysql2/promise';

function normItem(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}

// แยกบรรทัด Usg_Dtls -> { menu, used } ; รูปแบบ "ชื่อเมนู : ขาย (ใช้)"
function parseDtls(dtls) {
  if (!dtls) return [];
  const out = [];
  for (const raw of String(dtls).split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*) : ([-\d.]+) \(([-\d.]+)\)\s*$/);
    if (!m) continue;
    out.push({ menu: m[1].trim(), used: parseFloat(m[3]) || 0 });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { branch, startDate, endDate } = req.query;
  if (!branch || !startDate || !endDate) {
    return res.status(400).json({ status: 'error', message: 'ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน' });
  }

  // สาขา -> ชื่อ database (กันค่าแปลกปลอม)
  const branchKey = String(branch).toLowerCase().trim();
  if (!/^[a-z0-9]+$/.test(branchKey) || branchKey === 'all') {
    return res.status(200).json({ status: 'success', data: {}, note: `ไม่รองรับสาขา ${branchKey}` });
  }
  const database = 'myfbdata' + branchKey;

  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database,
      connectTimeout: 15000,
      dateStrings: true,
    });

    const [rows] = await conn.execute(
      'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
      'FROM trn_usg u LEFT JOIN item i ON i.Itm_ID = u.Usg_ItemID ' +
      'WHERE u.Usg_Date BETWEEN ? AND ?',
      [startDate, endDate]
    );

    // รวมตามวัตถุดิบ -> เมนู
    const result = {}; // normItem -> { menu -> usedQty }
    for (const r of rows) {
      const item = normItem(r.code);
      if (!item) continue;
      for (const { menu, used } of parseDtls(r.dtls)) {
        if (!menu || !used) continue;
        if (!result[item]) result[item] = {};
        result[item][menu] = (result[item][menu] || 0) + used;
      }
    }

    const data = {};
    for (const item of Object.keys(result)) {
      data[item] = Object.entries(result[item])
        .map(([menu, qty]) => ({ menu, qty: Number(qty.toFixed(2)) }))
        .filter(x => x.qty > 0)
        .sort((a, b) => b.qty - a.qty);
    }

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    // ไม่มี database ของสาขานั้น หรือเชื่อมต่อไม่ได้ -> คืนว่าง (หน้าจอ fallback ไปแสดงตามสูตร)
    if (error && (error.code === 'ER_BAD_DB_ERROR' || error.code === 'ER_NO_SUCH_TABLE')) {
      return res.status(200).json({ status: 'success', data: {}, note: 'ไม่พบข้อมูลสาขานี้ในฐานข้อมูล' });
    }
    console.error('usagemenu error:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  } finally {
    if (conn) { try { await conn.end(); } catch (e) { /* ignore */ } }
  }
}
