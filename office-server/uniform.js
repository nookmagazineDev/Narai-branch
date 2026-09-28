// ยูนิฟอร์มพนักงาน — ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน
//
// สองงานที่กล่องนี้ทำ ลงคนละที่โดยตั้งใจ:
//   1) "บันทึกข้อมูล"   -> dbo.UniformBranch (ตารางใหม่ ดู docs/schema-uniform.sql)
//      บันทึกว่าใครได้อะไรไป ไซซ์อะไร กี่ชิ้น วันไหน
//   2) "เบิกเข้าสาขา"   -> ไม่ได้อยู่ในไฟล์นี้เลย ฝั่งเว็บเรียก saveStock ของ stock.js ตรง ๆ
//      จึงได้เลขที่ใบเบิกรูปแบบเดิมและลง dbo.stock_request ตารางเดียวกับใบเบิกของสต๊อก
//      (ถ้าทำตารางใบเบิกของยูนิฟอร์มแยก ทีมโกดังจะต้องเปิดดูสองที่ และใบเบิกค้าง/หน้าสั่งของ
//       จะมองไม่เห็นใบพวกนี้เลย)
//
// ทุกสาขาบันทึกของพนักงานตัวเองได้ ไม่จำกัดเฉพาะผู้ใช้สิทธิ์ all — branchFor() กันไว้แล้วว่า
// สาขาหนึ่งจะไปอ่าน/เขียนข้อมูลของอีกสาขาไม่ได้

import { sql, stockDb } from './hr-db.js';
import { branchFor, branchGroup } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;
const runSql = queryRead;

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
   เฉพาะรหัสที่ขึ้นต้นด้วย 800000 — กรองที่ SQL ไม่ใช่ส่งสินค้าทั้งทะเบียน (หลักพันรายการ)
   ไปให้เบราว์เซอร์กรองเอง ช่องค้นหาในกล่องจึงขึ้นทันทีและไม่กินเน็ตสาขา

   ไม่กรองตามสาขา (ไม่ join stock_item_branch) ต่างจาก getStockItems โดยตั้งใจ:
   ยูนิฟอร์มเป็นของกลางที่ทุกสาขาเบิกได้ ถ้ากรองตามทะเบียนสินค้าของสาขา สาขาที่ยังไม่เคย
   ผูกไอเทมพวกนี้ไว้จะค้นไม่เจออะไรเลยทั้งที่เบิกได้ */
const UNIFORM_CODE_PREFIX = '800000';

async function getUniformItems() {
  const rows = await queryRead(
    `SELECT item_key, item_code, item_name, unit, request_unit, pos_item_id
       FROM dbo.stock_item
      WHERE item_code LIKE @prefix + '%'
        AND ISNULL(status, N'') <> N'ปิดการใช้งาน'
      ORDER BY item_code`,
    { prefix: { type: sql.NVarChar(20), value: UNIFORM_CODE_PREFIX } }
  );
  return {
    prefix: UNIFORM_CODE_PREFIX,
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

/* ===================== ประวัติของพนักงานหนึ่งคน =====================
   อ่านครอบรหัสสาขาพี่น้อง เหมือนทุกหน้าของสต๊อก ไม่งั้นของที่บันทึกไว้ใต้ zjp
   จะหายไปเมื่อเปิดด้วย sjp ทั้งที่เป็นร้านเดียวกัน */
async function getEmployeeUniform(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const hrCode = str(body.hrCode);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!hrCode) throw badRequest('ไม่ระบุรหัสพนักงาน');

  const inBranch = branchIn(branch);
  const rows = await queryRead(
    `SELECT uniform_id, item_code, item_name, unit, size, qty, note, saved_by,
            CONVERT(NVARCHAR(19), issued_at, 120) AS issued_text,
            CONVERT(NVARCHAR(19), saved_at, 120)  AS saved_text
       FROM dbo.UniformBranch
      WHERE hr_code = @hr_code AND branch IN (${inBranch.list})
      ORDER BY issued_at DESC, uniform_id DESC`,
    { hr_code: { type: sql.NVarChar(50), value: hrCode }, ...inBranch.params }
  );

  const requests = await getEmployeeRequests(branch, body.empName);

  return {
    branch,
    hrCode,
    count: rows.length,
    requests,
    data: rows.map((r) => ({
      id: Number(r.uniform_id),
      code: str(r.item_code),
      name: str(r.item_name),
      unit: str(r.unit),
      size: str(r.size),
      qty: Number(r.qty),
      note: str(r.note),
      issuedAt: thaiDateTime(r.issued_text),
      issuedDate: str(r.issued_text).slice(0, 10),
      savedAt: thaiDateTime(r.saved_text),
      savedBy: str(r.saved_by),
    })),
  };
}

/* ===================== ใบเบิกเข้าสาขาที่ขอในนามพนักงานคนนี้ =====================
   ปุ่ม "เบิกเข้าสาขา" ลง dbo.stock_request ผ่าน saveStock (ดูหัวไฟล์) ซึ่งไม่มีคอลัมน์รหัส HR
   มีแต่ requester = ชื่อพนักงานที่หน้าเว็บส่งมาเป็น requesterName จึงจับคู่ด้วยชื่อ
   และกรองเฉพาะรหัส 800000* กันใบเบิกของสต๊อกปกติที่บังเอิญใส่ชื่อคนเดียวกันปนเข้ามา
   ชื่อพนักงานเปลี่ยนทีหลัง = ใบเบิกเก่าที่ลงชื่อเดิมจะไม่ขึ้นในกล่องของชื่อใหม่ */
async function getEmployeeRequests(branch, empName) {
  const name = str(empName);
  if (!name) return [];
  const inBranch = branchIn(branch, 'rb');
  const rows = await queryRead(
    `SELECT doc_no, item_code, item_name, unit, qty, request_date,
            CONVERT(NVARCHAR(19), saved_at, 120) AS saved_text
       FROM dbo.stock_request
      WHERE requester = @requester
        AND item_code LIKE @prefix + '%'
        AND branch IN (${inBranch.list})
      ORDER BY saved_at DESC, request_id DESC`,
    {
      requester: { type: sql.NVarChar(255), value: name },
      prefix: { type: sql.NVarChar(20), value: UNIFORM_CODE_PREFIX },
      ...inBranch.params,
    }
  );
  return rows.map((r) => ({
    docNo: str(r.doc_no),
    code: str(r.item_code),
    name: str(r.item_name),
    unit: str(r.unit),
    qty: Number(r.qty),
    requestDate: str(r.request_date),
    savedAt: thaiDateTime(r.saved_text),
  }));
}

/* ===================== สรุปว่าใครมีกี่ไอเทม (ไว้ติดตัวเลขบนปุ่ม) =====================
   หน้ารายชื่อพนักงานมีได้เป็นร้อยแถว ถ้ายิงถามทีละคนจะเป็นร้อยคำขอต่อการเปิดหน้าหนึ่งครั้ง
   จึงสรุปมาทั้งสาขาในคำขอเดียว */
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

  // ยอดที่ขอเบิกเข้าสาขาในนามแต่ละคน — ใบเบิกไม่มีรหัส HR จึงคีย์ด้วยชื่อ (ดู getEmployeeRequests)
  const inReq = branchIn(branch, 'rb');
  const reqRows = await queryRead(
    `SELECT requester, COUNT(DISTINCT doc_no) AS docs, SUM(qty) AS total_qty
       FROM dbo.stock_request
      WHERE requester IS NOT NULL
        AND item_code LIKE @prefix + '%'
        AND branch IN (${inReq.list})
      GROUP BY requester`,
    { prefix: { type: sql.NVarChar(20), value: UNIFORM_CODE_PREFIX }, ...inReq.params }
  );
  const requested = {};
  for (const r of reqRows) {
    const name = str(r.requester);
    if (name) requested[name] = { docs: Number(r.docs), qty: Number(r.total_qty) || 0 };
  }

  return { branch, count: rows.length, data, requested };
}

/* ===================== บันทึกการจ่าย =====================
   หลายไอเทมในคำขอเดียว ทั้งชุดอยู่ใน transaction เดียว — สำเร็จหมดหรือไม่เกิดอะไรเลย
   (กติกาเดียวกับ saveStock ที่บันทึกยอดนับทั้งชั้นในครั้งเดียว) */
async function saveEmployeeUniform(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const hrCode = str(body.hrCode);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!hrCode) throw badRequest('ไม่ระบุรหัสพนักงาน');

  const empName = str(body.empName);
  const savedBy = str(body.username) || str(session?.username);
  const savedAt = localStamp();

  // วันที่จ่ายเลือกเองได้ (กรอกย้อนหลังได้) ส่งมาเป็น YYYY-MM-DD — ไม่ส่งมาก็ถือว่าวันนี้
  // เก็บเวลาที่กดบันทึกต่อท้ายวันที่ที่เลือก เพื่อให้เรียงลำดับภายในวันเดียวกันได้
  const dateOnly = str(body.issuedDate);
  const issuedAt = /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)
    ? `${dateOnly} ${savedAt.slice(11)}`
    : savedAt;

  const items = Array.isArray(body.items) ? body.items : [];
  const rows = [];
  for (const it of items) {
    const code = str(it.code ?? it.productId ?? it.itemCode);
    const key = normCode(code);
    const qty = num(it.qty);
    if (!key || qty <= 0) continue;
    rows.push({
      key,
      code,
      name: str(it.name),
      unit: str(it.unit),
      size: str(it.size),
      note: str(it.note),
      qty,
    });
  }
  if (rows.length === 0) throw badRequest('ไม่มีรายการที่จะบันทึก (ต้องเลือกไอเทมและใส่จำนวน)');

  await withTransaction(async (run) => {
    for (const r of rows) {
      await run(
        `INSERT INTO dbo.UniformBranch
           (branch, hr_code, emp_name, item_key, item_code, item_name, unit, size, qty, note, issued_at, saved_at, saved_by)
         VALUES (@branch, @hr_code, @emp_name, @item_key, @item_code, @item_name, @unit, @size, @qty, @note,
                 CONVERT(DATETIME2(0), @issued_at, 120), CONVERT(DATETIME2(0), @saved_at, 120), @saved_by);`,
        {
          branch: { type: sql.NVarChar(50), value: branch },
          hr_code: { type: sql.NVarChar(50), value: hrCode },
          emp_name: { type: sql.NVarChar(255), value: empName || null },
          item_key: { type: sql.NVarChar(50), value: r.key },
          item_code: { type: sql.NVarChar(50), value: r.code },
          item_name: { type: sql.NVarChar(255), value: r.name || null },
          unit: { type: sql.NVarChar(50), value: r.unit || null },
          size: { type: sql.NVarChar(20), value: r.size || null },
          qty: { type: sql.Decimal(18, 2), value: r.qty },
          note: { type: sql.NVarChar(500), value: r.note || null },
          issued_at: { type: sql.NVarChar(19), value: issuedAt },
          saved_at: { type: sql.NVarChar(19), value: savedAt },
          saved_by: { type: sql.NVarChar(255), value: savedBy || null },
        }
      );
    }
  });

  return {
    message: `บันทึกยูนิฟอร์ม ${rows.length} รายการเรียบร้อยแล้ว`,
    branch,
    hrCode,
    saved: rows.length,
    issuedAt,
  };
}

/* ===================== ลบแถวที่บันทึกผิด =====================
   ไม่มีการ "แก้ไข" แถวเดิมโดยตั้งใจ — ลบแล้วบันทึกใหม่เห็นร่องรอยชัดกว่าการทับค่าเงียบ ๆ
   เงื่อนไข branch IN (...) ในคำสั่งลบคือด่านจริง: ต่อให้ยิง API ตรง ๆ ด้วย uniform_id
   ของสาขาอื่นก็ลบไม่ได้ (ผู้ใช้สิทธิ์ all ที่เลือกสาขาไว้แล้วยังลบได้ตามปกติ) */
async function deleteEmployeeUniform(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const id = Number(body.uniformId ?? body.id);
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  if (!Number.isFinite(id) || id <= 0) throw badRequest('ไม่ระบุรายการที่จะลบ');

  const inBranch = branchIn(branch);
  const res = await runSql(
    `DELETE FROM dbo.UniformBranch
      WHERE uniform_id = @id AND branch IN (${inBranch.list});
     SELECT @@ROWCOUNT AS deleted;`,
    { id: { type: sql.Int, value: id }, ...inBranch.params }
  );

  // queryRead คืน recordset เป็นอาเรย์ (ดู hr-db.js) — ของคำสั่ง SELECT ตัวท้ายในก้อนนี้
  const deleted = Number(res?.[0]?.deleted ?? 0);
  if (!deleted) throw badRequest('ไม่พบรายการนี้ในสาขาของคุณ (อาจถูกลบไปแล้ว)');
  return { message: 'ลบรายการเรียบร้อยแล้ว', branch, uniformId: id, deleted };
}

export const UNIFORM_ACTIONS = {
  getUniformItems,
  getUniformSummary,
  getEmployeeUniform,
  saveEmployeeUniform,
  deleteEmployeeUniform,
};
