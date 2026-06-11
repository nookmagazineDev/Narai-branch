// Narai Usage API — บริการเล็กๆ รันในออฟฟิศ ต่อ MySQL POS ส่งยอดใช้วัตถุดิบแยกตามเมนู
// รัน:  npm install  แล้ว  npm start
// เรียก: GET /usagebymenu?branch=zjp&start=2026-05-01&end=2026-05-31
//        -> { status:'success', data:{ "1000046":[{menu, qty}, ...], ... } }
import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import natUpnp from 'nat-upnp';

// พยายามเปิดพอร์ตผ่าน UPnP เอง (กรณี router รองรับ) — เรียกตอนสตาร์ท + รีเฟรชเป็นระยะ
function openPortViaUpnp(port) {
  try {
    const client = natUpnp.createClient();
    client.portMapping({ public: port, private: port, ttl: 0, description: 'Narai Usage API' }, (err) => {
      client.close();
      if (err) console.log('UPnP: เปิดพอร์ตไม่สำเร็จ (' + err.message + ') — อาจต้อง forward เองที่ router');
      else console.log('UPnP: เปิดพอร์ต ' + port + ' สำเร็จ');
    });
  } catch (e) { console.log('UPnP error: ' + e.message); }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'inventory.dyndns.tv',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true,
});

const app = express();

// ตรวจ token เฉพาะเมื่อมีการตั้ง API_TOKEN ไว้
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

function buildUsageByMenu(rows) {
  const result = {};
  for (const r of rows) {
    const item = normItem(r.code);
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
    const db = 'myfbdata' + branch;

    const [rows] = await pool.query(
      'SELECT i.Itm_Code AS code, u.Usg_Dtls AS dtls ' +
      'FROM `' + db + '`.trn_usg u ' +
      'LEFT JOIN `' + db + '`.item i ON i.Itm_ID = u.Usg_ItemID ' +
      'WHERE u.Usg_Date BETWEEN ? AND ?',
      [start, end]
    );
    res.json({ status: 'success', data: buildUsageByMenu(rows) });
  } catch (e) {
    if (e && (e.code === 'ER_BAD_DB_ERROR' || e.code === 'ER_NO_SUCH_TABLE')) {
      return res.json({ status: 'success', data: {} });
    }
    console.error(e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

const PORT = Number(process.env.PORT) || 8787;
app.listen(PORT, () => {
  console.log('Narai Usage API running on port ' + PORT);
  if (process.env.UPNP !== 'off') {
    openPortViaUpnp(PORT);
    setInterval(() => openPortViaUpnp(PORT), 30 * 60 * 1000); // รีเฟรชทุก 30 นาที
  }
});
