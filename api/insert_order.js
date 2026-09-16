import { getPool, queryRead, replyDbError } from '../lib/mysql.js';
import { USAGE_API_BASE, fetchUpstream } from '../lib/upstream.js';

// สั่งของ/ขอเบิกจากสาขา — เขียนตรงลง MySQL: inventory.dyndns.tv
//   หัวใจคือตาราง myfbdata.orderd (ใบสั่งของกลาง, Ord_ReqType='TRF')
//   เลขที่ใบสั่ง (Ord_No) เดินจาก myfbdata<สาขา>.config.Cfg_LstOrdID + 1 แล้วอัปเดตกลับ
//   ทำใน transaction + ล็อกแถว config (FOR UPDATE) กันเลขชนกับ POS ที่สาขา
//
// POST body: { outletId, branch, deldate:'YYYY-MM-DD', items:[{itemId,itemCode,itemName,qty,unit,price}], dryRun }
// GET  ?peek=<Ord_No>&outletId=<id>  → ดูใบที่บันทึกไปแล้ว (ใช้ตรวจสอบผลลัพธ์)

// รหัสสาขา (outletId) → ชื่อฐานข้อมูลสาขา myfbdata<suffix>
// ตรวจสอบแล้วจากค่า Cfg_LstOrdID ที่ตรงกับใบสั่งล่าสุดของแต่ละสาขาจริง
const DB_SUFFIX = {
  7: 'zjp', 12: 'crm', 19: 'xcm', 37: 'slr', 51: 'sum', 55: 'sts', 59: 'xum',
  61: 'scs', 63: 'smp', 67: 'xsb', 72: 'xhh', 78: 'hrs', 79: 'clk', 80: 'p90',
  400: 'zbw', 401: 'zpt', 501: 'wrm', 902: 'hps', 906: 'zk3', 950: 'fct',
};
// สาขาที่รหัสในเว็บกับชื่อ DB ไม่ตรงกัน
const BRANCH_ALIAS = { sjp: 'zjp', zip: 'zjp' };

const SUP_ID = 490;      // คลังกลางที่จ่ายของ (ตรงกับ Trn_From ในใบรับ)
const REQ_TYPE = 'TRF';  // ใบขอโอน/เบิกระหว่างสาขา (ใช้ทั้ง Ord_ReqType และ Inv_Type)
const BATCH_ID = 1;      // Inv_BatchID

// ทะเบียนสินค้า — itemid ที่ใช้เป็น Ord_ItmID (pos_item_id) และหน่วยเบิก (request_unit)
//
// เดิมอ่านชีท 'item' ของไฟล์ BOM ตรง ๆ ผ่าน gviz ทั้งที่หน้านับสต๊อกย้ายมาอ่านทะเบียนตัวจริงใน SQL
// (InventoryNarai.dbo.stock_item) ตั้งแต่ย้ายระบบแล้ว — สองแหล่งนี้ไม่ตรงกันเมื่อไหร่ สาขาจะเห็น
// สินค้าในตารางนับแต่กดส่งใบเบิกไม่ได้เพราะหา itemid ไม่เจอ (หรือได้ itemid ของคนละตัว)
// ตอนนี้จึงอ่านที่เดียวกับที่หน้าเว็บอ่าน โดย office-server ซิงก์ชีทเข้า SQL ให้ทุกชั่วโมง (item-sync.js)
//
// Vercel ต่อ SQL Server ที่ออฟฟิศตรงไม่ได้ (ไฟร์วอลล์เปิดให้เฉพาะ IP ในไทย) จึงเดินผ่าน
// office-server เหมือน /api/schedule และ /api/stockcount
const REGISTRY_TTL_MS = 10 * 60 * 1000;
let registryCache = { at: 0, map: null, units: null };

/** รหัสที่ normalize แล้ว — ให้ตรงกับ item_key ใน SQL (ตัด .0 ท้าย + 0 นำหน้า) */
const normCode = (c) => String(c == null ? '' : c).replace(/\.0+$/, '').replace(/^0+/, '').trim();

async function loadItemRegistry() {
  // แคช 10 นาที กันยิงข้ามประเทศซ้ำทุกครั้งที่สั่งของ (ทะเบียนเปลี่ยนวันละไม่กี่ครั้ง)
  if (registryCache.map && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache;

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.USAGE_API_TOKEN) headers['x-api-token'] = process.env.USAGE_API_TOKEN;
  // _user เป็นตัวแทนของ endpoint นี้เอง (ทะเบียนสินค้าไม่แยกตามสาขาอยู่แล้ว) เหมือนที่ /api/stockcount ทำ
  const r = await fetchUpstream(`${USAGE_API_BASE}/schedule`, {
    method: 'POST',
    headers,
    timeoutMs: 12000,
    retries: 1,
    deadlineMs: 26000,
    body: JSON.stringify({ action: 'getItemRegistry', _user: { username: 'insert-order-api', branch: 'all' } }),
  });
  const body = await r.json().catch(() => null);
  if (!body) throw new Error(`เซิร์ฟเวอร์ที่ออฟฟิศตอบกลับมาไม่ใช่ JSON (HTTP ${r.status})`);
  if (body.status !== 'success') throw new Error(body.message || `อ่านทะเบียนสินค้าไม่ได้ (HTTP ${r.status})`);

  const map = new Map();   // รหัสสินค้า → itemid
  const units = {};        // รหัสสินค้า → หน่วยเบิก
  for (const it of (Array.isArray(body.data) ? body.data : [])) {
    const code = String(it.code ?? '').trim();
    if (!code) continue;
    const id = Number(it.itemId) || 0;
    if (id) {
      map.set(code, id);
      // เผื่อรหัสที่ส่งมามี 0 นำหน้าไม่ตรงกับที่เก็บไว้ — เส้นทางนี้เป็นตัวสำรองอยู่แล้ว ใส่ไว้ทั้งสองแบบ
      map.set(normCode(code), id);
    }
    const u = Number(it.requestUnit) || 0;
    // หน่วยเบิกคีย์ด้วยรหัสดิบอย่างเดียว — หน้าเว็บค้นด้วย productId ซึ่งมาจากคอลัมน์เดียวกันเป๊ะ
    if (u > 0) units[code] = u;
  }
  if (map.size === 0) throw new Error('ทะเบียนสินค้าไม่มี itemid สักรายการ (คอลัมน์ K ของชีท item)');

  registryCache = { at: Date.now(), map, units };
  return registryCache;
}

async function itemIdMap() {
  return (await loadItemRegistry()).map;
}

// เวลาไทย (Vercel รันเป็น UTC)
function bangkokNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); // 'YYYY-MM-DD HH:mm:ss'
  return { date: s.slice(0, 10), time: s.slice(11, 19), hour: Number(s.slice(11, 13)) };
}

async function resolveDb(conn, outletId, branch) {
  const cands = [];
  if (DB_SUFFIX[Number(outletId)]) cands.push(DB_SUFFIX[Number(outletId)]);
  const b = String(branch || '').toLowerCase().trim();
  if (b) cands.push(BRANCH_ALIAS[b] || b);
  for (const suffix of cands) {
    const db = 'myfbdata' + suffix;
    try {
      await conn.query(`SELECT Cfg_LstOrdID FROM \`${db}\`.config LIMIT 1`);
      return db;
    } catch (e) { /* ลองตัวถัดไป */ }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Content-Type, Date');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- โหมดหน่วยเบิก: คืนแมพ รหัสสินค้า → หน่วยเบิก (stock_item.request_unit) ----
  if (req.method === 'GET' && req.query.units) {
    try {
      const { units } = await loadItemRegistry();
      return res.status(200).json({ status: 'success', count: Object.keys(units).length, units });
    } catch (e) {
      return res.status(500).json({ status: 'error', message: e.message });
    }
  }

  // ---- โหมดตรวจสอบ: ดูใบที่บันทึกไปแล้ว ----
  if (req.method === 'GET' && req.query.peek) {
    const { peek, outletId } = req.query;
    if (!outletId) return res.status(400).json({ status: 'error', message: 'ระบุ outletId' });
    try {
      const rows = await queryRead(
        `SELECT Ord_No, Ord_Seq, DATE_FORMAT(Ord_OrdDate,'%Y-%m-%d') ordDate,
                DATE_FORMAT(Ord_DelDate,'%Y-%m-%d') delDate, Ord_PostTime postTime,
                Ord_ItmID itemId, Ord_itemCode itemCode, Ord_ItemName itemName,
                Ord_Qty qty, Ord_Unit unit, Ord_UnPr unitPrice, Ord_ReqType reqType
           FROM orderd WHERE Ord_StrID = ? AND Ord_No = ? ORDER BY Ord_Seq`,
        [Number(outletId), Number(peek)]
      );
      return res.status(200).json({ status: 'success', orderNo: Number(peek), count: rows.length, items: rows });
    } catch (e) {
      return res.status(500).json({ status: 'error', message: e.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'ใช้ POST เพื่อส่งใบสั่งของ' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { outletId, branch, deldate, items, dryRun } = body;

  if (!outletId) return res.status(400).json({ status: 'error', message: 'ไม่พบรหัสสาขา (outletId)' });
  if (!deldate || !/^\d{4}-\d{2}-\d{2}$/.test(String(deldate))) {
    return res.status(400).json({ status: 'error', message: 'วันที่รับสินค้า (deldate) ไม่ถูกต้อง ต้องเป็น YYYY-MM-DD' });
  }

  // เตรียมรายการ: เอาเฉพาะที่ขอเบิก > 0 และต้องมี itemId
  const clean = (Array.isArray(items) ? items : [])
    .map(it => ({
      itemId: Number(it.itemId) || 0,
      itemCode: String(it.itemCode ?? '').trim(),
      itemName: String(it.itemName ?? '').trim().slice(0, 100),
      qty: Number(it.qty) || 0,
      unit: String(it.unit ?? '').trim().slice(0, 20),
      price: Number(it.price) || 0,
    }))
    .filter(it => it.qty > 0);

  if (clean.length === 0) return res.status(400).json({ status: 'error', message: 'ไม่มีรายการที่ขอเบิก' });
  if (clean.length > 500) return res.status(400).json({ status: 'error', message: 'รายการเกิน 500 รายการ' });

  const conn = await getPool().getConnection();
  try {
    // หา itemId ให้รายการที่เว็บไม่ได้ส่งมา — ลำดับ: ทะเบียนสินค้า (SQL) → รหัสสินค้าใน POS
    if (clean.some(it => !it.itemId)) {
      try {
        const fromRegistry = await itemIdMap();
        for (const it of clean) {
          if (!it.itemId) it.itemId = fromRegistry.get(it.itemCode) || fromRegistry.get(normCode(it.itemCode)) || 0;
        }
      } catch (e) {
        console.error('อ่าน itemid จากทะเบียนสินค้าไม่สำเร็จ:', e.message);
      }
    }

    // สำรองชั้นสุดท้าย: หาจากรหัสสินค้าใน POS (ใช้เฉพาะรหัสที่ชี้ไปสินค้าตัวเดียว)
    const needLookup = clean.filter(it => !it.itemId && it.itemCode);
    if (needLookup.length) {
      const [found] = await conn.query(
        'SELECT Itm_Code code, MIN(Itm_ID) id, COUNT(*) n FROM item WHERE Itm_Code IN (?) GROUP BY Itm_Code HAVING n = 1',
        [needLookup.map(it => it.itemCode)]
      );
      const map = new Map(found.map(r => [String(r.code).trim(), Number(r.id)]));
      for (const it of clean) {
        if (!it.itemId) it.itemId = map.get(it.itemCode) || 0;
      }
    }

    const noItemId = clean.filter(it => !it.itemId);
    if (noItemId.length) {
      return res.status(400).json({
        status: 'error',
        message: `มี ${noItemId.length} รายการที่ไม่มี itemId — กรุณาเติมคอลัมน์ K ในชีท item แล้วรอรอบซิงก์ (หรือสั่งซิงก์เอง)`,
        missing: noItemId.map(it => `${it.itemCode} ${it.itemName}`),
      });
    }

    const db = await resolveDb(conn, outletId, branch);
    if (!db) {
      return res.status(400).json({ status: 'error', message: `ไม่พบฐานข้อมูลของสาขา (outletId=${outletId}, branch=${branch || '-'})` });
    }

    const now = bangkokNow();
    const shift = now.hour < 15 ? 1 : 3;
    const oid = Number(outletId);

    const buildRows = (ordNo) => clean.map((it, idx) => [
      ordNo, oid, idx + 1, deldate, SUP_ID, now.date,
      it.itemId, it.qty, it.unit, it.price, 0, it.qty, 1,
      now.date, now.time, shift,
      '', '', '', '', '', '', '', '', '', '',
      it.qty, it.itemCode, it.itemName, REQ_TYPE, '', '', '',
    ]);

    if (dryRun) {
      const [cfg] = await conn.query(`SELECT Cfg_LstOrdID AS last FROM \`${db}\`.config LIMIT 1`);
      const next = (Number(cfg[0]?.last) || 0) + 1;
      return res.status(200).json({
        status: 'success', dryRun: true, db, orderNo: next,
        message: `ทดสอบเท่านั้น — ไม่ได้บันทึกจริง (ใบถัดไปจะเป็นเลข ${next})`,
        deldate, ordDate: now.date, count: clean.length,
        preview: clean.slice(0, 5),
      });
    }

    // ตาราง POS เป็น MyISAM — ไม่มี transaction และ SELECT ... FOR UPDATE ไม่ทำงาน
    // จึงต้องใช้ LOCK TABLES ซึ่งเป็นการล็อกที่ MyISAM รองรับจริง
    // ระหว่างที่ล็อก ไม่มีใคร (รวมถึงเครื่อง POS ที่สาขา) แทรกใบใหม่ได้ ใช้เวลาแค่เสี้ยววินาที
    let orderNo = 0;
    await conn.query(`LOCK TABLES \`myfbdata\`.orderd WRITE, \`myfbdata\`.invoice WRITE, \`${db}\`.config WRITE`);
    try {
      const [cfg] = await conn.query(`SELECT Cfg_LstOrdID AS last FROM \`${db}\`.config LIMIT 1`);
      let candidate = (Number(cfg[0]?.last) || 0) + 1;

      // ถ้าเลขนั้นมีคนใช้ไปแล้ว (config ไม่ตรงกับข้อมูลจริง) ให้ข้ามไปเลขถัดไป
      // เช็คทั้งรายการสินค้าและหัวใบ เพราะต้องว่างทั้งคู่ถึงจะใช้เลขนั้นได้
      for (let i = 0; i < 100; i++) {
        const [dup] = await conn.query(
          `SELECT (SELECT COUNT(*) FROM \`myfbdata\`.orderd WHERE Ord_StrID = ? AND Ord_No = ?)
                + (SELECT COUNT(*) FROM \`myfbdata\`.invoice WHERE Inv_StrID = ? AND Inv_DocNo = ? AND Inv_Type = ?) AS c`,
          [oid, candidate, oid, candidate, REQ_TYPE]
        );
        if (!Number(dup[0].c)) break;
        candidate += 1;
      }
      orderNo = candidate;

      try {
        await conn.query(
          `INSERT INTO \`myfbdata\`.orderd
             (Ord_No, Ord_StrID, Ord_Seq, Ord_DelDate, Ord_SupID, Ord_OrdDate,
              Ord_ItmID, Ord_Qty, Ord_Unit, Ord_UnPr, Ord_Total, Ord_Rest, Ord_Size,
              Ord_PostDate, Ord_PostTime, Ord_Shift,
              Ord_Rmk1, Ord_Rmk2, Ord_Rmk3, Ord_Rmk4, Ord_Rmk5,
              Ord_Rmk6, Ord_Rmk7, Ord_Rmk8, Ord_Rmk9, Ord_Rmk10,
              Ord_Qty3, Ord_itemCode, Ord_ItemName, Ord_ReqType,
              Ord_Remark, Ord_ItmRemark, Ord_Send)
           VALUES ?`,
          [buildRows(orderNo)]
        );
        // หัวใบเบิกในตาราง invoice — คู่กับรายการสินค้าใน orderd
        //   Inv_DocDate = วันที่ส่งของ, Inv_InvDate = วันที่กรอกข้อมูล
        await conn.query(
          `INSERT INTO \`myfbdata\`.invoice
             (Inv_Type, Inv_DocNo, Inv_StrID, Inv_InvNo, Inv_DocDate, Inv_DocType,
              Inv_SupID, Inv_InvDate, Inv_VatType, Inv_BatchID, Inv_Remark,
              Inv_Rmk1, Inv_Rmk2, Inv_Rmk3, Inv_Rmk4, Inv_Rmk5,
              Inv_Rmk6, Inv_Rmk7, Inv_Rmk8, Inv_Rmk9, Inv_Rmk10)
           VALUES (?, ?, ?, '', ?, '', ?, ?, '', ?, '',
                   ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ')`,
          [REQ_TYPE, orderNo, oid, deldate, SUP_ID, now.date, BATCH_ID]
        );
      } catch (insErr) {
        // MyISAM ไม่มี rollback — ถ้าใส่ไปได้บางส่วนต้องเก็บกวาดเอง
        // ปลอดภัยเพราะเช็คแล้วว่าเลขนี้ว่างตอนที่ยังถือล็อกอยู่
        await conn.query('DELETE FROM `myfbdata`.orderd WHERE Ord_StrID = ? AND Ord_No = ?', [oid, orderNo]);
        await conn.query('DELETE FROM `myfbdata`.invoice WHERE Inv_StrID = ? AND Inv_DocNo = ? AND Inv_Type = ?', [oid, orderNo, REQ_TYPE]);
        throw insErr;
      }

      await conn.query(`UPDATE \`${db}\`.config SET Cfg_LstOrdID = ?`, [orderNo]);
    } finally {
      await conn.query('UNLOCK TABLES');
    }

    return res.status(200).json({
      status: 'success', orderNo, db, deldate, ordDate: now.date,
      count: clean.length,
      totalQty: Number(clean.reduce((s, i) => s + i.qty, 0).toFixed(3)),
      message: `ส่งใบสั่งของเลขที่ ${orderNo} จำนวน ${clean.length} รายการ เรียบร้อย`,
    });
  } catch (error) {
    return replyDbError(res, error, 'insert_order');
  } finally {
    conn.release();
  }
}
