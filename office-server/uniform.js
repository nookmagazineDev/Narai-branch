// ยูนิฟอร์มพนักงาน — ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน
//
// โฟลว์ (ตาราง dbo.UniformRequest ดู docs/schema-uniform.sql):
//   1) สาขากด "ส่งคำขอเบิก"   -> submitUniformRequest   สถานะ pending (กำลังรออนุมัติ)
//   2) ออฟฟิศ (naraipizzeria หน้า HR → ยูนิฟอร์ม) กด รอสินค้าเข้า / อนุมัติเบิก / กำลังรอจัดส่ง
//      "กำลังรอจัดส่ง" เป็นจุดเดียวที่ส่งใบเบิกไปคลัง ลง dbo.stock_request (เลขที่ใบเบิกรูปแบบเดิม)
//      ทีมโกดังจึงยังเห็นใบเบิกยูนิฟอร์มในที่เดียวกับใบเบิกของสต๊อก
//   3) สาขากด "ได้รับของแล้ว"  -> receiveUniformRequest  สถานะ received + ลง dbo.UniformBranch
//
// ทุกสาขาบันทึกของพนักงานตัวเองได้ ไม่จำกัดเฉพาะผู้ใช้สิทธิ์ all — branchFor() กันไว้แล้วว่า
// สาขาหนึ่งจะไปอ่าน/เขียนข้อมูลของอีกสาขาไม่ได้

import { sql, stockDb } from './hr-db.js';
import { branchFor, branchGroup } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** รหัสสินค้าที่ normalize แล้ว — ต้องให้ผลตรงกับ normCode() ใน stock.js เป๊ะ */
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });

/** '2026-09-21 14:05' -> '21/09/2026 14:05' (กติกาเดียวกับ stock.js) */
const thaiDateTime = (v) => {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
};

const two = (n) => String(n).padStart(2, '0');
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** ชุดพารามิเตอร์ `WHERE branch IN (...)` ที่ครอบรหัสพี่น้อง (zjp/sjp) — เหมือน stock.js */
function branchIn(branch, prefix = 'ba') {
  const params = {};
  const list = branchGroup(branch)
    .map((code, i) => {
      params[`${prefix}${i}`] = { type: sql.NVarChar(50), value: code };
      return `@${prefix}${i}`;
    })
    .join(', ');
  return { list, params };
}

/* ===================== รายการไอเทมยูนิฟอร์ม =====================
   เฉพาะรหัสที่ขึ้นต้นด้วย 80000, 80001 หรือ 8001 (เอี๊ยม 800107) — กรองที่ SQL ไม่ใช่ส่งสินค้าทั้งทะเบียน (หลักพันรายการ)
   ไปให้เบราว์เซอร์กรองเอง ช่องค้นหาในกล่องจึงขึ้นทันทีและไม่กินเน็ตสาขา

   ไม่กรองตามสาขา (ไม่ join stock_item_branch) ต่างจาก getStockItems โดยตั้งใจ:
   ยูนิฟอร์มเป็นของกลางที่ทุกสาขาเบิกได้ ถ้ากรองตามทะเบียนสินค้าของสาขา สาขาที่ยังไม่เคย
   ผูกไอเทมพวกนี้ไว้จะค้นไม่เจออะไรเลยทั้งที่เบิกได้ */
const UNIFORM_CODE_PREFIXES = ['80000', '80001', '8001'];

/** เงื่อนไข `(col LIKE '80000%' OR ...)` + พารามิเตอร์ ใช้ทุกคำสั่งที่กรองรหัสยูนิฟอร์ม */
function uniformCodeFilter(col = 'item_code') {
  const params = {};
  const cond = UNIFORM_CODE_PREFIXES
    .map((prefix, i) => {
      params[`up${i}`] = { type: sql.NVarChar(20), value: prefix };
      return `${col} LIKE @up${i} + '%'`;
    })
    .join(' OR ');
  return { cond: `(${cond})`, params };
}

async function getUniformItems() {
  const codeFilter = uniformCodeFilter();
  const rows = await queryRead(
    `SELECT item_key, item_code, item_name, unit, request_unit, pos_item_id
       FROM dbo.stock_item
      WHERE ${codeFilter.cond}
        AND ISNULL(status, N'') <> N'ปิดการใช้งาน'
      ORDER BY item_code`,
    codeFilter.params
  );
  return {
    prefix: UNIFORM_CODE_PREFIXES[0],
    prefixes: UNIFORM_CODE_PREFIXES,
    count: rows.length,
    data: rows.map((r) => ({
      itemKey: str(r.item_key),
      code: str(r.item_code),
      name: str(r.item_name),
      unit: str(r.unit),
      requestUnit: str(r.request_unit),
      posItemId: str(r.pos_item_id),
    })),
  };
}

/* ===================== สถานะคำขอเบิก =====================
   ต้องตรงกับ UNIFORM_REQUEST_STATUS ใน lib/uniformSql.mjs ของรีโป naraipizzeria (ฝั่งออฟฟิศที่กดอนุมัติ)
     pending       สาขาส่งคำขอแล้ว รอออฟฟิศอนุมัติ
     waiting_stock ออฟฟิศรับเรื่องแล้ว แต่ของยังไม่มี
     approved      ออฟฟิศอนุมัติเบิกแล้ว ยังไม่ส่งคลัง
     shipping      ออฟฟิศกดกำลังรอจัดส่ง — ใบเบิกถูกส่งไปคลัง ลง dbo.stock_request ตอนนี้ (doc_no)
     received      สาขากด "ได้รับของแล้ว" — จบงาน และลง dbo.UniformBranch ว่าพนักงานได้ของไป */
export const UNIFORM_REQUEST_STATUS = ['pending', 'waiting_stock', 'approved', 'shipping', 'received'];
const REQUEST_TABLE = 'dbo.UniformRequest';

/* ===================== คำขอเบิกของพนักงานหนึ่งคน =====================
   อ่านครอบรหัสสาขาพี่น้อง เหมือนทุกหน้าของสต๊อก ไม่งั้นของที่ขอไว้ใต้ zjp
   จะหายไปเมื่อเปิดด้วย sjp ทั้งที่เป็นร้านเดียวกัน */
async function getEmployeeUniform(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const hrCode = str(body.hrCode);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!hrCode) throw badRequest('ไม่ระบุรหัสพนักงาน');

  const inBranch = branchIn(branch);
  const rows = await queryRead(
    `SELECT request_id, item_code, item_name, unit, qty, want_date, status, doc_no, status_by, received_by,
            CONVERT(NVARCHAR(19), requested_at, 120) AS requested_text,
            CONVERT(NVARCHAR(19), status_at, 120)    AS status_text,
            CONVERT(NVARCHAR(19), received_at, 120)  AS received_text
       FROM ${REQUEST_TABLE}
      WHERE hr_code = @hr_code AND branch IN (${inBranch.list})
      ORDER BY requested_at DESC, request_id DESC`,
    { hr_code: { type: sql.NVarChar(50), value: hrCode }, ...inBranch.params }
  );

  return {
    branch,
    hrCode,
    count: rows.length,
    requests: rows.map((r) => ({
      id: Number(r.request_id),
      code: str(r.item_code),
      name: str(r.item_name),
      unit: str(r.unit),
      qty: Number(r.qty),
      wantDate: str(r.want_date),
      status: UNIFORM_REQUEST_STATUS.includes(str(r.status)) ? str(r.status) : 'pending',
      docNo: str(r.doc_no),
      requestedAt: thaiDateTime(r.requested_text),
      statusAt: thaiDateTime(r.status_text),
      statusBy: str(r.status_by),
      receivedAt: thaiDateTime(r.received_text),
      receivedBy: str(r.received_by),
    })),
  };
}

/* ===================== ตัวเลขบนปุ่ม =====================
   หน้ารายชื่อพนักงานมีได้เป็นร้อยแถว ถ้ายิงถามทีละคนจะเป็นร้อยคำขอต่อการเปิดหน้าหนึ่งครั้ง
   จึงสรุปมาทั้งสาขาในคำขอเดียว
     data[hrCode]      = ได้รับของไปแล้ว (dbo.UniformBranch)
     requested[hrCode] = คำขอที่ยังไม่จบ (ทุกสถานะยกเว้น received) */
async function getUniformSummary(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');

  const inBranch = branchIn(branch);
  const rows = await queryRead(
    `SELECT hr_code, COUNT(*) AS n, SUM(qty) AS total_qty,
            CONVERT(NVARCHAR(19), MAX(issued_at), 120) AS last_text
       FROM dbo.UniformBranch
      WHERE branch IN (${inBranch.list})
      GROUP BY hr_code`,
    inBranch.params
  );

  const data = {};
  for (const r of rows) {
    data[str(r.hr_code)] = {
      rows: Number(r.n),
      qty: Number(r.total_qty) || 0,
      lastIssued: thaiDateTime(r.last_text),
    };
  }

  const reqRows = await queryRead(
    `SELECT hr_code, COUNT(*) AS n, SUM(qty) AS total_qty,
            SUM(CASE WHEN status = N'shipping' THEN 1 ELSE 0 END) AS shipping
       FROM ${REQUEST_TABLE}
      WHERE status <> N'received' AND branch IN (${inBranch.list})
      GROUP BY hr_code`,
    inBranch.params
  );
  const requested = {};
  for (const r of reqRows) {
    requested[str(r.hr_code)] = {
      rows: Number(r.n),
      qty: Number(r.total_qty) || 0,
      shipping: Number(r.shipping) || 0,
    };
  }

  return { branch, count: rows.length, data, requested };
}

/* ===================== ส่งคำขอเบิก =====================
   สาขาไม่สร้างใบเบิกเองแล้ว — ลงแค่ dbo.UniformRequest สถานะ pending
   ใบเบิกจริง (dbo.stock_request) ออกตอนออฟฟิศกด "กำลังรอจัดส่ง" ที่ naraipizzeria
   หลายไอเทมในคำขอเดียว ทั้งชุดอยู่ใน transaction เดียว — สำเร็จหมดหรือไม่เกิดอะไรเลย */
async function submitUniformRequest(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const hrCode = str(body.hrCode);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!hrCode) throw badRequest('ไม่ระบุรหัสพนักงาน');

  const empName = str(body.empName);
  const requestedBy = str(body.username) || str(session?.username);
  const requestedAt = localStamp();
  const wantDate = str(body.wantDate);

  const items = Array.isArray(body.items) ? body.items : [];
  const rows = [];
  for (const it of items) {
    const code = str(it.code ?? it.productId ?? it.itemCode);
    const key = normCode(code);
    const qty = num(it.qty);
    if (!key || qty <= 0) continue;
    rows.push({ key, code, name: str(it.name), unit: str(it.unit), qty });
  }
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่จะส่ง (ต้องเลือกไอเทมและใส่จำนวน)');

  await withTransaction(async (run) => {
    for (const r of rows) {
      await run(
        `INSERT INTO ${REQUEST_TABLE}
           (branch, hr_code, emp_name, item_key, item_code, item_name, unit, qty, want_date,
            status, requested_at, requested_by)
         VALUES (@branch, @hr_code, @emp_name, @item_key, @item_code, @item_name, @unit, @qty, @want_date,
                 N'pending', CONVERT(DATETIME2(0), @requested_at, 120), @requested_by);`,
        {
          branch: { type: sql.NVarChar(50), value: branch },
          hr_code: { type: sql.NVarChar(50), value: hrCode },
          emp_name: { type: sql.NVarChar(255), value: empName || null },
          item_key: { type: sql.NVarChar(50), value: r.key },
          item_code: { type: sql.NVarChar(50), value: r.code },
          item_name: { type: sql.NVarChar(255), value: r.name || null },
          unit: { type: sql.NVarChar(50), value: r.unit || null },
          qty: { type: sql.Decimal(18, 2), value: r.qty },
          want_date: { type: sql.NVarChar(30), value: wantDate || null },
          requested_at: { type: sql.NVarChar(19), value: requestedAt },
          requested_by: { type: sql.NVarChar(255), value: requestedBy || null },
        }
      );
    }
  });

  return {
    message: `ส่งคำขอเบิก ${rows.length} รายการแล้ว · กำลังรออนุมัติ`,
    branch,
    hrCode,
    saved: rows.length,
  };
}

/* ===================== ได้รับของแล้ว (จบงาน) =====================
   รับได้เฉพาะแถวที่ออฟฟิศตั้งเป็น "กำลังรอจัดส่ง" แล้ว และเป็นของสาขาตัวเอง (branch IN (...) คือด่านจริง)
   แถวที่รับแล้วลง dbo.UniformBranch ด้วย — การ์ด "อยู่ในสาขา" ของออฟฟิศกับตัวเลขบนปุ่มนับจากตารางนั้น */
async function receiveUniformRequest(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  const ids = [...new Set((Array.isArray(body.requestIds) ? body.requestIds : [body.requestId])
    .map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('ไม่ระบุรายการที่ได้รับ');
  if (ids.length > 200) throw badRequest('กดรับได้ครั้งละไม่เกิน 200 รายการ');

  const receivedBy = str(body.username) || str(session?.username);
  const receivedAt = localStamp();
  const inBranch = branchIn(branch);
  const idParams = {};
  const idList = ids.map((id, i) => {
    idParams[`id${i}`] = { type: sql.Int, value: id };
    return `@id${i}`;
  }).join(', ');

  const done = await withTransaction(async (run) => {
    const upd = await run(
      `UPDATE ${REQUEST_TABLE}
          SET status = N'received', received_at = CONVERT(DATETIME2(0), @received_at, 120), received_by = @received_by
       OUTPUT inserted.request_id, inserted.branch, inserted.hr_code, inserted.emp_name, inserted.item_key,
              inserted.item_code, inserted.item_name, inserted.unit, inserted.qty, inserted.doc_no
        WHERE request_id IN (${idList}) AND status = N'shipping' AND branch IN (${inBranch.list});`,
      {
        received_at: { type: sql.NVarChar(19), value: receivedAt },
        received_by: { type: sql.NVarChar(255), value: receivedBy || null },
        ...idParams,
        ...inBranch.params,
      }
    );
    const rows = upd.recordset || [];
    for (const r of rows) {
      await run(
        `INSERT INTO dbo.UniformBranch
           (branch, hr_code, emp_name, item_key, item_code, item_name, unit, size, qty, note, issued_at, saved_at, saved_by)
         VALUES (@branch, @hr_code, @emp_name, @item_key, @item_code, @item_name, @unit, NULL, @qty, @note,
                 CONVERT(DATETIME2(0), @at, 120), CONVERT(DATETIME2(0), @at, 120), @saved_by);`,
        {
          branch: { type: sql.NVarChar(50), value: str(r.branch) },
          hr_code: { type: sql.NVarChar(50), value: str(r.hr_code) },
          emp_name: { type: sql.NVarChar(255), value: str(r.emp_name) || null },
          item_key: { type: sql.NVarChar(50), value: str(r.item_key) },
          item_code: { type: sql.NVarChar(50), value: str(r.item_code) },
          item_name: { type: sql.NVarChar(255), value: str(r.item_name) || null },
          unit: { type: sql.NVarChar(50), value: str(r.unit) || null },
          qty: { type: sql.Decimal(18, 2), value: Number(r.qty) },
          note: { type: sql.NVarChar(500), value: r.doc_no ? `ใบเบิก ${str(r.doc_no)}` : null },
          at: { type: sql.NVarChar(19), value: receivedAt },
          saved_by: { type: sql.NVarChar(255), value: receivedBy || null },
        }
      );
    }
    return rows.length;
  });

  if (!done) throw badRequest('ไม่มีรายการที่รับได้ (ต้องเป็นสถานะ "กำลังรอจัดส่ง" ของสาขานี้ — ลองโหลดใหม่)');
  return { message: `รับของแล้ว ${done} รายการ`, branch, received: done };
}

export const UNIFORM_ACTIONS = {
  getUniformItems,
  getUniformSummary,
  getEmployeeUniform,
  submitUniformRequest,
  receiveUniformRequest,
};
