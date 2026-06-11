// Narai Usage API — บริการเล็กๆ รันในออฟฟิศ ต่อ MySQL POS แล้วส่งยอดใช้วัตถุดิบแยกตามเมนู
// แยกต่างหากจากเซิร์ฟเวอร์ express เดิม (ไม่กระทบงานอื่น)
//
// รัน:  npm install  แล้ว  npm start   (ตั้งค่าใน .env ก่อน)
// เรียก: GET /usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
//        -> { status:'success', data:{ "1000046":[{menu, qty}, ...], ... } }
import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // ให้ DATE กลับมาเป็น 'YYYY-MM-DD' กันปัญหา timezone
});

const app = express();

// ตรวจ token (ถ้าตั้ง API_TOKEN ใน .env) — กันคนนอกยิงมั่ว
app.use((req, res, next) => {
  const need = process.env.API_TOKEN;
  if (need && req.get('x-api-token') !== need) {
    return res.status(401).json({ status: 'error', message: 'unauthorized' });
  }
  next();
});

function normItem(id) {
  if (id === null || id === undefined) return '';
  return String(id).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
}

// แยกบรรทัด Usg_Dtls: "ชื่อเมนู : จำนวนขาย (ปริมาณที่ใช้)"
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

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/usagebymenu', async (req, res) => {
  try {
    const branch = String(req.query.branch || '').toLowerCase().trim();
    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    if (!branch || !start || !end) {
      return res.status(400).json({ status: 'error', message: 'missing branch/start/end' });
    }
    if (!/^[a-z0-9]+$/.test(branch)) return res.json({ status: 'success', data: {} });
    const db = 'myfbdata' + branch; // เช่น zjp -> myfbdatazjp

    const [rows] = await pool.query(
      'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
      'FROM `' + db + '`.trn_usg u ' +
      'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
      'WHERE u.Usg_Date BETWEEN ? AND ?',
      [start, end]
    );

    // รวมตามวัตถุดิบ -> เมนู
    const result = {};
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
    res.json({ status: 'success', data });
  } catch (e) {
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) {
      return res.json({ status: 'success', data: {} });
    }
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => console.log('Narai Usage API running on port ' + PORT));
