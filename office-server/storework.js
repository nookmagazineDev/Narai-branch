// งานสโตร์/โกดัง (จัดของ / รับของ / ดึงข้อมูลใบเบิก / ยกเลิกใบเบิก) บน SQL Server
//
// เรียกจากแอป storefct (nookmagazineDev/narai-storefct) ผ่าน POST /schedule เหมือน action อื่น
// เพราะ Vercel ต่อ SQL Server ตรงไม่ได้ — ไฟร์วอลล์เปิดพอร์ต 1433 ให้เฉพาะ IP ในไทย
//
//   เบราว์เซอร์ -> /api/* ของ storefct (Vercel) -> office-server :8787/schedule -> SQL Server
//
// ตารางอยู่ที่ InventoryNarai (ฐานเดียวกับ stock_count/stock_item) — สคีมาอยู่ที่
// docs/schema-store-sqlserver.sql ของ repo storefct ต้องรันก่อนเปิดใช้
//
// ทำไมงานชุดนี้ย้ายมาที่นี่: ชีท 'รับของ' เขียนโดยหน้า "รับสินค้า" ของแอปนี้ ส่วน storefct เป็น
// คนอ่านและกดอนุมัติ เดิมสองแอปคุยกันผ่านชีทเป็นตัวกลาง พอมาอยู่ตารางเดียวกันก็ไม่ต้องมี
// สะพานซิงก์ค้างไว้ถาวรอีก

// ฐานข้อมูลคือ InventoryNarai ตัวเดียวกับตารางสต๊อก จึงใช้ stockDb ไม่ใช่ hrDb
import { sql, stockDb } from './hr-db.js';
import { branchFor, branchGroup } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;
// คำสั่งเขียนที่ไม่ต้องอ่านผลลัพธ์ — ใช้ตัวเดียวกับการอ่าน (กติกาเดียวกับ stock.js)
// ระวัง: queryRead คืน recordset เป็น array ไม่ใช่ result object จึงอ่าน rowsAffected ไม่ได้
// ถ้าต้องรู้ว่าโดนกี่แถว ให้ใช้ OUTPUT clause แล้วนับแถวที่คืนมาแทน
const runSql = queryRead;

const str = (v) => String(v === null || v === undefined ? '' : v).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const orNull = (v) => (str(v) === '' ? null : str(v));

/** วันที่ 'YYYY-MM-DD' หรือ null — กันค่าขยะจากชีทเก่าลงคอลัมน์ DATE */
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : null);
/** เวลา 'YYYY-MM-DD HH:mm:ss' หรือ null */
const ymdhms = (v) => (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(str(v)) ? str(v).replace('T', ' ') : null);

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** normalize รหัสสินค้าให้ตรงกับ item_key — กติกาเดียวกับ stock.js และฝั่ง storefct */
const normCode = (code) => String(code === null || code === undefined ? '' : code)
  .replace(/^'/, '').trim().replace(/\.0+$/, '').replace(/^0+/, '').trim();

/** วันที่/เวลาไทยตอนนี้ — เครื่องนี้ตั้งโซนเวลาไทยอยู่แล้ว แต่ระบุให้ชัดกันเครื่องถูกย้าย */
function bangkokNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }); // 'YYYY-MM-DD HH:mm:ss'
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}

// ---------------------------------------------------------------------------
// เขียน
// ---------------------------------------------------------------------------

/**
 * บันทึกการจัดของทั้งใบ — หนึ่งแถวต่อหนึ่ง (ใบเบิก, สินค้า) บันทึกซ้ำคือทับแถวเดิม
 *
 * ทำใน transaction เดียวเพื่อให้ใบหนึ่งลงครบหรือไม่ลงเลย ไม่ใช่ลงครึ่งใบแล้วค้าง
 * ยิงทีละแถวโดยตั้งใจ — ชุดหนึ่งไม่เกิน 500 รายการ บน localhost จึงจบในหลักไม่กี่ร้อยมิลลิวินาที
 * และ MERGE รายแถวกันการกดซ้ำได้ตรงไปตรงมากว่าการยัด table-valued parameter
 */
async function saveFulfillment(body) {
  const docNo = str(body.docNo);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!docNo) throw badRequest('ไม่ระบุเลขที่ใบเบิก');
  if (items.length === 0) throw badRequest('ไม่มีรายการที่จะบันทึก');
  if (items.length > 500) throw badRequest('รายการเกิน 500 รายการต่อใบ');

  const common = {
    doc_no: { type: sql.NVarChar(50), value: docNo },
    outlet_id: { type: sql.Int, value: Number.isFinite(Number(body.outletId)) ? Number(body.outletId) : null },
    ord_no: { type: sql.Int, value: Number.isFinite(Number(body.ordNo)) ? Number(body.ordNo) : null },
    branch: { type: sql.NVarChar(50), value: str(body.branch) },
    del_date: { type: sql.NVarChar(10), value: ymd(body.delDate) },
    recorded_at: { type: sql.NVarChar(19), value: ymdhms(body.recordedAt) },
  };

  await withTransaction(async (run) => {
    for (const it of items) {
      const itemKey = str(it.itemKey);
      if (!itemKey) continue;
      await run(
        `MERGE dbo.store_fulfillment AS t
         USING (SELECT @doc_no AS doc_no, @item_key AS item_key) AS s
           ON t.doc_no = s.doc_no AND t.item_key = s.item_key
         WHEN MATCHED THEN UPDATE SET
           outlet_id = COALESCE(@outlet_id, t.outlet_id),
           ord_no    = COALESCE(@ord_no, t.ord_no),
           branch    = @branch,
           del_date  = COALESCE(CONVERT(DATE, @del_date, 23), t.del_date),
           item_code = @item_code, item_name = @item_name,
           req_qty   = @req_qty, del_qty = @del_qty,
           status    = @status, note = @note,
           recorded_at = COALESCE(CONVERT(DATETIME2(0), @recorded_at, 120), t.recorded_at),
           source    = @source, updated_at = SYSDATETIME()
         WHEN NOT MATCHED THEN INSERT
           (doc_no, outlet_id, ord_no, branch, del_date, item_key, item_code, item_name,
            req_qty, del_qty, status, note, recorded_at, source)
           VALUES
           (@doc_no, @outlet_id, @ord_no, @branch, CONVERT(DATE, @del_date, 23), @item_key,
            @item_code, @item_name, @req_qty, @del_qty, @status, @note,
            CONVERT(DATETIME2(0), @recorded_at, 120), @source);`,
        {
          ...common,
          item_key: { type: sql.NVarChar(50), value: itemKey },
          item_code: { type: sql.NVarChar(50), value: str(it.itemCode) },
          item_name: { type: sql.NVarChar(255), value: orNull(it.itemName) },
          req_qty: { type: sql.Decimal(18, 3), value: num(it.reqQty) },
          del_qty: { type: sql.Decimal(18, 3), value: num(it.delQty) },
          status: { type: sql.NVarChar(50), value: orNull(it.status) },
          note: { type: sql.NVarChar(500), value: orNull(it.note) },
          source: { type: sql.NVarChar(20), value: str(body.source) || 'app' },
        }
      );
    }
  });

  return { docNo, count: items.length, message: `บันทึกการจัดของแล้ว ${items.length} รายการ` };
}

/** ธง "ดึงข้อมูลแล้ว" — คีย์ (outlet_id, ord_no) เพราะใบเบิกเลขเดียวกันมีได้หลายสาขา */
async function markFetched(body) {
  const outletId = Number(body.outletId);
  const ordNo = Number(body.ordNo);
  if (!Number.isFinite(outletId) || !Number.isFinite(ordNo)) {
    throw badRequest('ต้องระบุ outletId และ ordNo');
  }

  await runSql(
    `MERGE dbo.store_fetched_log AS t
     USING (SELECT @outlet_id AS outlet_id, @ord_no AS ord_no) AS s
       ON t.outlet_id = s.outlet_id AND t.ord_no = s.ord_no
     WHEN MATCHED THEN UPDATE SET
       doc_no = @doc_no, branch = @branch,
       del_date = COALESCE(CONVERT(DATE, @del_date, 23), t.del_date),
       fetched_at = CONVERT(DATETIME2(0), @fetched_at, 120),
       source = @source, updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT (outlet_id, ord_no, doc_no, branch, del_date, fetched_at, source)
       VALUES (@outlet_id, @ord_no, @doc_no, @branch, CONVERT(DATE, @del_date, 23),
               CONVERT(DATETIME2(0), @fetched_at, 120), @source);`,
    {
      outlet_id: { type: sql.Int, value: outletId },
      ord_no: { type: sql.Int, value: ordNo },
      doc_no: { type: sql.NVarChar(50), value: str(body.docNo) },
      branch: { type: sql.NVarChar(50), value: str(body.branch) },
      del_date: { type: sql.NVarChar(10), value: ymd(body.delDate) },
      fetched_at: { type: sql.NVarChar(19), value: ymdhms(body.fetchedAt) },
      source: { type: sql.NVarChar(20), value: str(body.source) || 'app' },
    }
  );

  return { docNo: str(body.docNo), fetchedAt: str(body.fetchedAt) };
}

/**
 * โกดังอนุมัติรายการที่สาขาแจ้งแก้ไข
 *
 * แถวต้องมีอยู่แล้ว (สาขาเป็นคนสร้างตอนกดรับของ) — ถ้าไม่เจอถือว่าผิดจริง ไม่ใช่เรื่องปกติ
 * ต้องบอกกลับไป ไม่ใช่เงียบแล้วให้หน้าเว็บขึ้นว่าอนุมัติสำเร็จทั้งที่ไม่มีอะไรเปลี่ยน
 */
async function approveReceivedEdit(body) {
  const docNo = str(body.docNo);
  const itemKey = str(body.itemKey);
  if (!docNo || !itemKey) throw badRequest('ต้องระบุ docNo และ itemKey');

  const approvedAt = ymdhms(body.approvedAt);
  // OUTPUT ทำให้รู้ว่าอัปเดตโดนแถวไหนบ้าง — queryRead คืนแค่ recordset ไม่มี rowsAffected ให้ดู
  const updated = await runSql(
    `UPDATE dbo.store_receiving
        SET approved_by = @approved_by,
            approved_at = COALESCE(CONVERT(DATETIME2(0), @approved_at, 120), SYSDATETIME()),
            updated_at = SYSDATETIME()
      OUTPUT inserted.doc_no, inserted.item_key,
             CONVERT(NVARCHAR(19), inserted.approved_at, 120) AS approved_at
      WHERE doc_no = @doc_no AND item_key = @item_key;`,
    {
      doc_no: { type: sql.NVarChar(50), value: docNo },
      item_key: { type: sql.NVarChar(50), value: itemKey },
      approved_by: { type: sql.NVarChar(255), value: str(body.approvedBy) || 'โกดัง' },
      approved_at: { type: sql.NVarChar(19), value: approvedAt },
    }
  );

  if (updated.length === 0) {
    throw badRequest('ไม่พบรายการที่ตรงกันในตารางรับของ (เลขที่ใบเบิก + รหัสสินค้า)');
  }
  return { docNo, itemKey, approvedAt: updated[0].approved_at || approvedAt || null };
}

// ---------------------------------------------------------------------------
// อ่าน
// ---------------------------------------------------------------------------

/** สรุปสถานะรับของรายใบ — ใช้ตอบว่า "สาขารับของแล้ว" และ "มีรายการแจ้งแก้ไขไหม" */
async function getStoreReceivingStatus() {
  const rows = await queryRead(
    `SELECT doc_no,
            MIN(branch) AS branch,
            COUNT(*) AS item_count,
            MAX(CASE WHEN status = N'แก้ไข' THEN 1 ELSE 0 END) AS has_edit,
            CONVERT(NVARCHAR(19), MAX(recorded_at), 120) AS last_recorded_at
       FROM dbo.store_receiving
      GROUP BY doc_no`
  );
  return rows.map((r) => ({
    docNo: r.doc_no,
    branch: str(r.branch),
    itemCount: num(r.item_count),
    hasEdit: Boolean(r.has_edit),
    lastRecordedAt: r.last_recorded_at || '',
  }));
}

/** ใบเบิกที่โกดังดึงข้อมูลไปแล้วทั้งหมด */
async function getStoreFetchedLog() {
  const rows = await queryRead(
    `SELECT outlet_id, ord_no, doc_no, branch,
            CONVERT(NVARCHAR(10), del_date, 23) AS del_date,
            CONVERT(NVARCHAR(19), fetched_at, 120) AS fetched_at
       FROM dbo.store_fetched_log`
  );
  return rows.map((r) => ({
    outletId: r.outlet_id,
    ordNo: r.ord_no,
    docNo: str(r.doc_no),
    branch: str(r.branch),
    delDate: r.del_date || '',
    fetchedAt: r.fetched_at || '',
  }));
}

/** ใบเบิกที่ถูกยกเลิก */
async function getStoreCancelledDocs() {
  const rows = await queryRead(
    `SELECT doc_no, branch,
            CONVERT(NVARCHAR(10), order_date, 23) AS order_date,
            CONVERT(NVARCHAR(10), del_date, 23) AS del_date,
            item_count, recorder,
            CONVERT(NVARCHAR(19), cancelled_at, 120) AS cancelled_at
       FROM dbo.store_cancelled_doc`
  );
  return rows.map((r) => ({
    docNo: str(r.doc_no),
    branch: str(r.branch),
    orderDate: r.order_date || '',
    delDate: r.del_date || '',
    itemCount: num(r.item_count),
    recorder: str(r.recorder),
    cancelledAt: r.cancelled_at || '',
  }));
}

/** จำนวนที่จัดส่งจริงรายไอเทมของใบเดียว */
async function getStoreFulfillmentDetail(body) {
  const docNo = str(body.docNo);
  if (!docNo) throw badRequest('ต้องระบุ docNo');
  const rows = await queryRead(
    `SELECT item_key, item_code, item_name, req_qty, del_qty, status, note
       FROM dbo.store_fulfillment WHERE doc_no = @doc_no`,
    { doc_no: { type: sql.NVarChar(50), value: docNo } }
  );
  return rows.map((r) => ({
    itemKey: str(r.item_key),
    itemCode: str(r.item_code),
    itemName: str(r.item_name),
    reqQty: num(r.req_qty),
    delQty: num(r.del_qty),
    status: str(r.status),
    note: str(r.note),
  }));
}

/** รายละเอียดการรับของของใบเดียว */
async function getStoreReceivingDetail(body) {
  const docNo = str(body.docNo);
  if (!docNo) throw badRequest('ต้องระบุ docNo');
  const rows = await queryRead(
    `SELECT item_key, item_code, item_name, req_qty, del_qty, qty_received,
            status, note, photo_url, recorder,
            CONVERT(NVARCHAR(19), recorded_at, 120) AS recorded_at,
            approved_by,
            CONVERT(NVARCHAR(19), approved_at, 120) AS approved_at
       FROM dbo.store_receiving WHERE doc_no = @doc_no`,
    { doc_no: { type: sql.NVarChar(50), value: docNo } }
  );
  return rows.map((r) => ({
    itemKey: str(r.item_key),
    itemCode: str(r.item_code),
    itemName: str(r.item_name),
    reqQty: num(r.req_qty),
    delQty: num(r.del_qty),
    qtyReceived: num(r.qty_received),
    status: str(r.status),
    note: str(r.note),
    photoUrl: str(r.photo_url),
    recorder: str(r.recorder),
    recordedAt: r.recorded_at || '',
    approvedBy: str(r.approved_by),
    approvedAt: r.approved_at || '',
  }));
}

/** รายการที่สาขาแจ้งแก้ไขแล้วโกดังยังไม่อนุมัติ — การ์ดแจ้งเตือนของหน้า "ตรวจสอบสถานะ" */
async function getStorePendingEditApprovals() {
  const rows = await queryRead(
    `SELECT doc_no, branch, item_key, item_code, item_name,
            req_qty, del_qty, qty_received, status, note, photo_url, recorder,
            CONVERT(NVARCHAR(19), recorded_at, 120) AS recorded_at,
            approved_by
       FROM dbo.store_receiving
      WHERE status = N'แก้ไข' AND (approved_by IS NULL OR approved_by = N'')`
  );
  return rows.map((r) => ({
    docNo: str(r.doc_no),
    branch: str(r.branch),
    itemKey: str(r.item_key),
    itemCode: str(r.item_code),
    itemName: str(r.item_name),
    reqQty: num(r.req_qty),
    delQty: num(r.del_qty),
    qtyReceived: num(r.qty_received),
    status: str(r.status),
    note: str(r.note),
    photoUrl: str(r.photo_url),
    recorder: str(r.recorder),
    recordedAt: r.recorded_at || '',
    approvedBy: str(r.approved_by),
  }));
}

// ---------------------------------------------------------------------------
// หน้า "รับสินค้า" ของแอปนี้
//
// ย้ายมาจาก Apps Script (action ชื่อเดียวกัน) ซึ่งเคยอ่านชีท 'จัดของ' และเขียนชีท 'รับของ'
// รูปแบบคำตอบเหมือนเดิมทุกฟิลด์ หน้าเว็บจึงแทบไม่ต้องแก้ — ต่างกันแค่รูปภาพ ดูหมายเหตุที่
// saveGoodsReceived
// ---------------------------------------------------------------------------

/**
 * ใบเบิกที่โกดังจัดของแล้วและรอสาขารับ — อ่านจาก store_fulfillment ที่ storefct เขียนไว้
 *
 * เทียบสาขาด้วย LOWER() ทั้งสองฝั่ง เพราะ storefct บันทึกชื่อสาขาตามที่ POS เก็บ (ตัวใหญ่ เช่น
 * 'CRM') ส่วน session ของหน้าเว็บเป็นตัวเล็ก — กติกาเดียวกับที่ Apps Script เดิมใช้
 */
async function getGoodsToReceive(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();

  // ครอบทั้งกลุ่มรหัสพี่น้อง (เช่น zjp กับ sjp เป็นร้านเดียวกัน) — branchFor คืนรหัสที่ล็อกอิน
  // เสมอ ไม่ใช่รหัสที่ขอมา ส่วน storefct บันทึกชื่อสาขาตามที่ POS เก็บ ซึ่งอาจเป็นอีกรหัสในกลุ่ม
  // ถ้าเทียบตรงตัวรหัสเดียว สาขานั้นจะไม่เห็นใบของตัวเองเลยโดยไม่มีอะไรฟ้อง
  const codes = branch ? branchGroup(branch).map((c) => String(c).toLowerCase()) : [];

  // สร้างพารามิเตอร์ทีละตัว — รายการรหัสเอาไปใส่ IN (?) แบบ MySQL ไม่ได้ ต้องกางเป็น @b0, @b1
  const branchParams = {};
  codes.forEach((code, i) => { branchParams[`b${i}`] = { type: sql.NVarChar(50), value: code }; });
  const branchFilter = codes.length
    ? `LOWER(f.branch) IN (${codes.map((_, i) => `@b${i}`).join(', ')})`
    : '1 = 1';

  const rows = await queryRead(
    `SELECT f.doc_no, f.branch,
            CONVERT(NVARCHAR(10), f.del_date, 23) AS del_date,
            f.item_key, f.item_code, f.item_name, f.req_qty, f.del_qty, f.status,
            CASE WHEN r.receiving_id IS NULL THEN 0 ELSE 1 END AS already_received
       FROM dbo.store_fulfillment f
       LEFT JOIN dbo.store_receiving r
              ON r.doc_no = f.doc_no AND r.item_key = f.item_key
      WHERE ${branchFilter}
      ORDER BY f.del_date DESC, f.doc_no DESC`,
    branchParams
  );

  const groups = new Map();
  for (const r of rows) {
    const orderNo = str(r.doc_no);
    if (!orderNo) continue;
    if (!groups.has(orderNo)) {
      groups.set(orderNo, { orderNo, branch: str(r.branch), date: r.del_date || '', received: false, items: [] });
    }
    const g = groups.get(orderNo);
    const alreadyReceived = Boolean(r.already_received);
    // "ใบนี้รับแล้ว" = มีรายการไหนสักรายการที่รับไปแล้ว — กติกาเดียวกับที่ Apps Script เดิมใช้
    if (alreadyReceived) g.received = true;
    g.items.push({
      code: str(r.item_code) || str(r.item_key),
      itemKey: str(r.item_key),
      name: str(r.item_name),
      qtyRequested: num(r.req_qty),
      qtySent: num(r.del_qty),
      storeStatus: str(r.status),
      alreadyReceived,
    });
  }

  return [...groups.values()];
}

/** เขียนแถวรับของหนึ่งรายการ (ใช้ร่วมกันระหว่างบันทึกทั้งใบกับยืนยันทีละรายการ) */
function upsertReceivingRow(run, common, it) {
  return run(
    `MERGE dbo.store_receiving AS t
     USING (SELECT @doc_no AS doc_no, @item_key AS item_key) AS s
       ON t.doc_no = s.doc_no AND t.item_key = s.item_key
     WHEN MATCHED THEN UPDATE SET
       branch = @branch,
       receive_date = CONVERT(DATE, @receive_date, 23),
       item_code = @item_code, item_name = @item_name,
       req_qty = @req_qty, del_qty = @del_qty, qty_received = @qty_received,
       status = @status, note = @note,
       photo_url = COALESCE(NULLIF(@photo_url, N''), t.photo_url),
       recorder = @recorder,
       recorded_at = CONVERT(DATETIME2(0), @recorded_at, 120),
       source = N'app', updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT
       (doc_no, branch, receive_date, item_key, item_code, item_name,
        req_qty, del_qty, qty_received, status, note, photo_url, recorder, recorded_at, source)
       VALUES
       (@doc_no, @branch, CONVERT(DATE, @receive_date, 23), @item_key, @item_code, @item_name,
        @req_qty, @del_qty, @qty_received, @status, @note, @photo_url, @recorder,
        CONVERT(DATETIME2(0), @recorded_at, 120), N'app');`,
    {
      ...common,
      item_key: { type: sql.NVarChar(50), value: str(it.itemKey) || normCode(it.code) },
      item_code: { type: sql.NVarChar(50), value: str(it.code) },
      item_name: { type: sql.NVarChar(255), value: orNull(it.name) },
      req_qty: { type: sql.Decimal(18, 3), value: num(it.qtyRequested) },
      del_qty: { type: sql.Decimal(18, 3), value: num(it.qtySent) },
      qty_received: { type: sql.Decimal(18, 3), value: num(it.qtyReceived) },
      status: { type: sql.NVarChar(50), value: str(it.status) || 'ยืนยัน' },
      note: { type: sql.NVarChar(500), value: orNull(it.note) },
      photo_url: { type: sql.NVarChar(500), value: str(it.photoUrl) },
    }
  );
}

/**
 * บันทึกผลรับของทั้งใบ
 *
 * ต่างจาก Apps Script เดิมตรงเดียว: รับ `photoUrl` ที่อัปโหลดเสร็จแล้ว ไม่ใช่ `photoBase64`
 * เครื่องนี้ไม่มีสิทธิ์เขียน Google Drive รูปจึงยังขึ้น Drive เหมือนเดิมผ่าน Apps Script
 * (action uploadReceivePhotos) แล้วหน้าเว็บค่อยส่ง URL มาที่นี่
 *
 * เช็คซ้ำฝั่งเซิร์ฟเวอร์ว่ารายการ "แก้ไข" มีหมายเหตุและรูปครบ — กัน validation ฝั่งเว็บถูกข้าม
 */
async function saveGoodsReceived(body, session) {
  const branch = str(branchFor(session, body.branch));
  const docNo = str(body.orderNo);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!docNo) throw badRequest('ไม่ระบุเลขที่ใบเบิก');
  if (items.length === 0) throw badRequest('ไม่มีรายการที่รับของ');

  for (const it of items) {
    if (str(it.status) !== 'แก้ไข') continue;
    const label = str(it.name) || str(it.code);
    if (!str(it.note)) throw badRequest(`รายการ "${label}" แก้ไขจำนวนแล้วต้องใส่หมายเหตุด้วย`);
    if (!str(it.photoUrl)) throw badRequest(`รายการ "${label}" แก้ไขจำนวนแล้วต้องแนบรูปภาพด้วย`);
  }

  const now = bangkokNow();
  const common = {
    doc_no: { type: sql.NVarChar(50), value: docNo },
    branch: { type: sql.NVarChar(50), value: branch },
    receive_date: { type: sql.NVarChar(10), value: now.date },
    recorder: { type: sql.NVarChar(255), value: str(body.recorder) || str(session?.username) || 'Unknown' },
    recorded_at: { type: sql.NVarChar(19), value: `${now.date} ${now.time}` },
  };

  await withTransaction(async (run) => {
    for (const it of items) {
      if (!str(it.itemKey) && !str(it.code)) continue;
      await upsertReceivingRow(run, common, it);
    }
  });

  return { count: items.length, message: `บันทึกรับของใบเบิกเลขที่ ${docNo} เรียบร้อยแล้ว (${items.length} รายการ)` };
}

/**
 * สาขากด "ยืนยันแก้ไข" ทีละรายการ — ยอมรับจำนวนที่โกดังส่งมาจริงโดยไม่ต้องกรอกเอง
 * จึงบันทึกเป็นสถานะ "ยืนยัน" ไม่ใช่ "แก้ไข" และไม่ต้องมีหมายเหตุ/รูป
 */
async function confirmReceivedItem(body, session) {
  const branch = str(branchFor(session, body.branch));
  const docNo = str(body.orderNo);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!docNo) throw badRequest('ไม่ระบุเลขที่ใบเบิก');
  if (!str(body.code) && !str(body.itemKey)) throw badRequest('ไม่ระบุรหัสสินค้า');

  const now = bangkokNow();
  const common = {
    doc_no: { type: sql.NVarChar(50), value: docNo },
    branch: { type: sql.NVarChar(50), value: branch },
    receive_date: { type: sql.NVarChar(10), value: now.date },
    recorder: { type: sql.NVarChar(255), value: str(body.recorder) || str(session?.username) || 'Unknown' },
    recorded_at: { type: sql.NVarChar(19), value: `${now.date} ${now.time}` },
  };

  await withTransaction((run) => upsertReceivingRow(run, common, {
    itemKey: body.itemKey,
    code: body.code,
    name: body.name,
    qtyRequested: body.qtyRequested,
    qtySent: body.qtySent,
    qtyReceived: body.qtySent, // ยืนยัน = รับตามที่ส่งมา
    status: 'ยืนยัน',
    note: '',
    photoUrl: '',
  }));

  return { docNo, code: str(body.code), message: 'ยืนยันรับของเรียบร้อยแล้ว' };
}

// ---------------------------------------------------------------------------
// ย้ายข้อมูลเก่า
// ---------------------------------------------------------------------------

// คอลัมน์ที่ยอมให้ตัวย้ายเขียนได้ แยกตามตาราง — allowlist ไม่ใช่การรับชื่อคอลัมน์มาจากผู้เรียก
// ตรงๆ เพราะชื่อคอลัมน์เอาไปใส่ใน SQL แบบ parameter ไม่ได้
const IMPORT_TABLES = {
  fulfillment: {
    table: 'dbo.store_fulfillment',
    keys: ['doc_no', 'item_key'],
    cols: {
      doc_no: sql.NVarChar(50), outlet_id: sql.Int, ord_no: sql.Int,
      branch: sql.NVarChar(50), del_date: 'date', item_key: sql.NVarChar(50),
      item_code: sql.NVarChar(50), item_name: sql.NVarChar(255),
      req_qty: sql.Decimal(18, 3), del_qty: sql.Decimal(18, 3),
      status: sql.NVarChar(50), note: sql.NVarChar(500), recorded_at: 'datetime',
    },
  },
  receiving: {
    table: 'dbo.store_receiving',
    keys: ['doc_no', 'item_key'],
    cols: {
      doc_no: sql.NVarChar(50), branch: sql.NVarChar(50), receive_date: 'date',
      item_key: sql.NVarChar(50), item_code: sql.NVarChar(50), item_name: sql.NVarChar(255),
      req_qty: sql.Decimal(18, 3), del_qty: sql.Decimal(18, 3), qty_received: sql.Decimal(18, 3),
      status: sql.NVarChar(50), note: sql.NVarChar(500), photo_url: sql.NVarChar(500),
      recorder: sql.NVarChar(255), recorded_at: 'datetime',
      approved_by: sql.NVarChar(255), approved_at: 'datetime',
    },
  },
  fetched: {
    table: 'dbo.store_fetched_log',
    keys: ['outlet_id', 'ord_no'],
    cols: {
      outlet_id: sql.Int, ord_no: sql.Int, doc_no: sql.NVarChar(50),
      branch: sql.NVarChar(50), del_date: 'date', fetched_at: 'datetime',
    },
  },
  cancelled: {
    table: 'dbo.store_cancelled_doc',
    keys: ['doc_no'],
    cols: {
      doc_no: sql.NVarChar(50), branch: sql.NVarChar(50), order_date: 'date',
      del_date: 'date', item_count: sql.Int, recorder: sql.NVarChar(255),
      cancelled_at: 'datetime',
    },
  },
};

/**
 * ย้ายแถวเก่าจากชีทเข้าตาราง — ใช้ครั้งเดียวตอนเปลี่ยนระบบ
 *
 * รับมาเป็นก้อน (storefct เป็นคนอ่านชีทแล้วส่งมาให้) เพราะเครื่องนี้ไม่ต้องรู้จักชีทเลย
 * MERGE ตามคีย์ จึงรันซ้ำกี่รอบก็ไม่เกิดแถวซ้ำ และรันทับของที่ย้ายไปแล้วได้
 */
async function importStoreRows(body) {
  const spec = IMPORT_TABLES[str(body.target)];
  if (!spec) throw badRequest(`target ต้องเป็นหนึ่งใน: ${Object.keys(IMPORT_TABLES).join(', ')}`);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) return { target: str(body.target), imported: 0 };
  if (rows.length > 1000) throw badRequest('ส่งได้ครั้งละไม่เกิน 1000 แถว');

  let imported = 0;
  await withTransaction(async (run) => {
    for (const row of rows) {
      // เอาเฉพาะคอลัมน์ที่อยู่ใน allowlist และมีค่าส่งมาจริง
      const present = Object.keys(spec.cols).filter((c) => row[c] !== undefined);
      if (spec.keys.some((k) => !present.includes(k))) continue;

      const params = {};
      const valueExpr = {};
      for (const col of present) {
        const type = spec.cols[col];
        if (type === 'date') {
          params[col] = { type: sql.NVarChar(10), value: ymd(row[col]) };
          valueExpr[col] = `CONVERT(DATE, @${col}, 23)`;
        } else if (type === 'datetime') {
          params[col] = { type: sql.NVarChar(19), value: ymdhms(row[col]) };
          valueExpr[col] = `CONVERT(DATETIME2(0), @${col}, 120)`;
        } else {
          params[col] = { type, value: row[col] === null ? null : row[col] };
          valueExpr[col] = `@${col}`;
        }
      }

      const updates = present.filter((c) => !spec.keys.includes(c));
      const onClause = spec.keys.map((k) => `t.${k} = ${valueExpr[k]}`).join(' AND ');

      await run(
        `MERGE ${spec.table} AS t
         USING (SELECT 1 AS x) AS s ON ${onClause}
         ${updates.length ? `WHEN MATCHED THEN UPDATE SET ${updates.map((c) => `${c} = ${valueExpr[c]}`).join(', ')}, updated_at = SYSDATETIME()` : ''}
         WHEN NOT MATCHED THEN INSERT (${present.join(', ')}, source)
           VALUES (${present.map((c) => valueExpr[c]).join(', ')}, N'sheet');`,
        params
      );
      imported++;
    }
  });

  return { target: str(body.target), imported };
}

export const STORE_WORK_ACTIONS = {
  getGoodsToReceive,
  saveGoodsReceived,
  confirmReceivedItem,
  saveFulfillment,
  markFetched,
  approveReceivedEdit,
  getStoreReceivingStatus,
  getStoreFetchedLog,
  getStoreCancelledDocs,
  getStoreFulfillmentDetail,
  getStoreReceivingDetail,
  getStorePendingEditApprovals,
  importStoreRows,
};

/** action ที่อ่านอย่างเดียว — ปลอดภัยที่จะลองใหม่เมื่อเน็ตสะดุด (ดู READ_ONLY ใน api/schedule.js) */
export const STORE_WORK_READ_ONLY = [
  'getGoodsToReceive',
  'getStoreReceivingStatus',
  'getStoreFetchedLog',
  'getStoreCancelledDocs',
  'getStoreFulfillmentDetail',
  'getStoreReceivingDetail',
  'getStorePendingEditApprovals',
];
