// หน้ารายชื่อพนักงาน — สัญชาติ (ไทย/ต่างชาติ) + เอกสารพนักงานต่างชาติและวันหมดอายุ
//
// ตาราง dbo.employee_doc อยู่ที่ InventoryNarai (sql/employee-doc-001-table.sql) เพราะตัวรัน
// migration ของ update-office-server.bat รันลงฐานนั้น — ไม่ต้องให้ใครไปสร้างตารางเอง
//
// ทุกสาขาแก้ข้อมูลพนักงานของสาขาตัวเองได้ branchFor() กันไว้แล้วว่าสาขาหนึ่งจะไปอ่าน/เขียน
// ของอีกสาขาไม่ได้ ส่วนการนำเข้าทั้งไฟล์ Excel ทำได้เฉพาะผู้ใช้สิทธิ์ all (ไฟล์มีทุกสาขาปนกัน)
//
// การแจ้งเตือนล่วงหน้า 120 วันคำนวณที่หน้าเว็บจากวันหมดอายุที่ส่งไป — ที่นี่เก็บ/คืนข้อมูลอย่างเดียว

import { sql, stockDb, hrDb } from './hr-db.js';
import { branchFor, branchGroup, branchCodes, sameBranch } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const forbidden = (msg) => Object.assign(new Error(msg), { forbidden: true });

/** SQL Server error 208 = ยังไม่มีตาราง (ยังไม่ได้รัน update-office-server.bat) */
const tableMissing = (e) => e?.number === 208 || /Invalid object name/i.test(e?.message || '');
const MISSING_MSG = 'ยังไม่ได้สร้างตารางเอกสารพนักงาน — ให้รัน update-office-server.bat บนเครื่องออฟฟิศก่อน';

/** ชุดพารามิเตอร์ `branch IN (...)` ที่ครอบรหัสพี่น้อง (zjp/sjp) — แบบเดียวกับ uniform.js */
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

/* ---------------------------- ช่องข้อมูล ----------------------------
   [ชื่อฟิลด์ที่หน้าเว็บใช้, คอลัมน์, ความยาว]  — ช่องข้อความ
   เพิ่มช่องใหม่ที่นี่ที่เดียว ทั้งอ่าน บันทึก และนำเข้าจะได้ครบพร้อมกัน */
const TEXT_FIELDS = [
  ['prefix', 'prefix', 20],
  ['country', 'country', 50],
  ['phone', 'phone', 50],
  ['email', 'email', 150],
  ['ssoNo', 'sso_no', 50],
  ['bankAccount', 'bank_account', 50],
  ['passportNo', 'passport_no', 50],
  ['mou', 'mou', 50],
  ['wpIdNo', 'wp_id_no', 50],
  ['wpPermitNo', 'wp_permit_no', 50],
  ['pinkNo', 'pink_no', 50],
  ['missingDocs', 'missing_docs', 500],
];
/** ช่องวันที่ — หน้าเว็บส่ง 'YYYY-MM-DD' (ค.ศ.) หรือค่าว่าง */
const DATE_FIELDS = [
  ['passportExpiry', 'passport_expiry'],
  ['visaExpiry', 'visa_expiry'],
  ['wpExpiry', 'wp_expiry'],
  ['report90Date', 'report90_date'],
  ['pinkExpiry', 'pink_expiry'],
  ['pkkExpiry', 'pkk_expiry'],
];

const SELECT_COLS = [
  'doc_id', 'branch', 'hr_code', 'full_name', 'nat_type', 'updated_by',
  ...TEXT_FIELDS.map(([, col]) => col),
  ...DATE_FIELDS.map(([, col]) => `CONVERT(varchar(10), ${col}, 23) AS ${col}`),
  'CONVERT(varchar(16), updated_at, 120) AS updated_text',
].join(', ');

const toDoc = (r) => {
  const out = {
    docId: Number(r.doc_id),
    branch: str(r.branch),
    hrCode: str(r.hr_code),
    fullName: str(r.full_name),
    natType: str(r.nat_type) === 'thai' ? 'thai' : 'foreign',
    updatedBy: str(r.updated_by),
    updatedAt: str(r.updated_text),
  };
  for (const [key, col] of TEXT_FIELDS) out[key] = str(r[col]);
  for (const [key, col] of DATE_FIELDS) out[key] = str(r[col]);
  return out;
};

/** 'YYYY-MM-DD' ที่เป็นวันจริง -> ข้อความเดิม · ว่าง -> '' · รูปแบบผิด -> null */
function dateOf(v) {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // ปีต้องเป็น ค.ศ. — ถ้าหลุดมาเป็น พ.ศ. (25xx) วันหมดอายุจะไกลไป 543 ปีแล้วไม่เตือนเลย
  if (y < 1990 || y > 2200 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** พารามิเตอร์ของทุกช่องข้อมูลจาก body — โยน badRequest ถ้าวันที่ผิดรูปแบบ */
function fieldParams(body, natType) {
  const thai = natType === 'thai';
  const params = {};
  for (const [key, col, len] of TEXT_FIELDS) {
    params[col] = { type: sql.NVarChar(len), value: str(body[key]).slice(0, len) || null };
  }
  for (const [key, col] of DATE_FIELDS) {
    const d = dateOf(body[key]);
    if (d === null) throw badRequest(`วันที่ไม่ถูกต้อง (${key}: ${str(body[key])}) — ต้องเป็นปี ค.ศ.`);
    params[col] = { type: sql.Date, value: d || null };
  }
  // คนไทยไม่มีประเทศ — กันค่าค้างจากตอนที่เคยตั้งเป็นต่างชาติ
  if (thai) params.country.value = null;
  return params;
}

const FIELD_COLS = [...TEXT_FIELDS.map(([, col]) => col), ...DATE_FIELDS.map(([, col]) => col)];
const SET_FIELDS = FIELD_COLS.map((c) => `${c} = @${c}`).join(', ');
const INSERT_COLS = FIELD_COLS.join(', ');
const INSERT_VALS = FIELD_COLS.map((c) => `@${c}`).join(', ');

const natTypeOf = (v) => (str(v).toLowerCase() === 'thai' ? 'thai' : 'foreign');
const who = (session) => str(session?.name) || str(session?.username) || null;

/* ===================== อ่านทั้งสาขา =====================
   หน้ารายชื่อมีได้เป็นร้อยแถว จึงส่งเอกสารของทั้งสาขาในคำขอเดียว ไม่ถามทีละคน
   ผู้ใช้สิทธิ์ all ที่ไม่ระบุสาขา (หรือส่ง 'all') ได้ทุกสาขา */
async function getEmployeeDocs(body, session) {
  const branch = str(branchFor(session, body.branch || session?.branch)).toLowerCase();
  if (!branch) throw badRequest('ไม่ระบุสาขา');
  const everything = branch === 'all';
  const inBranch = everything ? null : branchIn(branch);
  try {
    const rows = await queryRead(
      `SELECT ${SELECT_COLS} FROM dbo.employee_doc
        ${everything ? '' : `WHERE branch IN (${inBranch.list})`}
        ORDER BY full_name`,
      everything ? {} : inBranch.params
    );
    return { branch, ready: true, data: rows.map(toDoc) };
  } catch (e) {
    // ยังไม่ได้สร้างตาราง = ยังไม่มีข้อมูลเอกสาร หน้ารายชื่อต้องใช้งานได้ตามปกติ
    if (tableMissing(e)) return { branch, ready: false, data: [] };
    throw e;
  }
}

/** แถวที่มีอยู่ + ตรวจว่าคนเรียกมีสิทธิ์กับสาขาของแถวนั้น */
async function loadRow(where, params, session) {
  const rows = await queryRead(`SELECT ${SELECT_COLS} FROM dbo.employee_doc WHERE ${where}`, params);
  const row = rows[0] ? toDoc(rows[0]) : null;
  if (row && session && !session.isAll && !sameBranch(row.branch, session.branch)) {
    throw forbidden(`ข้อมูลเอกสารของพนักงานคนนี้อยู่ที่สาขา ${row.branch.toUpperCase()} — สาขาของคุณแก้ไม่ได้`);
  }
  return row;
}

/* ===================== บันทึกของพนักงานหนึ่งคน =====================
   { branch, hrCode, fullName, natType, ...ช่องข้อมูล }  หรือ { docId, ... } สำหรับแถวที่ยังไม่ผูก
   ส่งช่องข้อมูลมาครบทุกช่องเสมอ (หน้าเว็บส่งทั้งฟอร์ม) ช่องที่ว่างคือถูกล้าง */
async function saveEmployeeDoc(body, session) {
  const hrCode = str(body.hrCode);
  const docId = Number(body.docId) || 0;
  if (!hrCode && !docId) throw badRequest('ไม่ระบุพนักงาน');
  const natType = natTypeOf(body.natType);

  try {
    const existing = hrCode
      ? await loadRow('hr_code = @hr_code', { hr_code: { type: sql.NVarChar(30), value: hrCode } }, session)
      : await loadRow('doc_id = @doc_id', { doc_id: { type: sql.Int, value: docId } }, session);
    if (!existing && !hrCode) throw badRequest('ไม่พบข้อมูลเอกสารนี้ (อาจถูกลบไปแล้ว)');

    const params = {
      ...fieldParams(body, natType),
      nat_type: { type: sql.NVarChar(10), value: natType },
      updated_by: { type: sql.NVarChar(255), value: who(session) },
    };

    if (existing) {
      await queryRead(
        `UPDATE dbo.employee_doc
            SET ${SET_FIELDS}, nat_type = @nat_type, updated_by = @updated_by, updated_at = SYSDATETIME()
          WHERE doc_id = @doc_id`,
        { ...params, doc_id: { type: sql.Int, value: existing.docId } }
      );
    } else {
      const branch = str(branchFor(session, body.branch)).toLowerCase();
      if (!branch || branch === 'all') throw badRequest('ไม่ทราบสาขาของพนักงานคนนี้');
      const fullName = str(body.fullName);
      if (!fullName) throw badRequest('ไม่ระบุชื่อพนักงาน');
      await queryRead(
        `INSERT INTO dbo.employee_doc (branch, hr_code, full_name, nat_type, updated_by, ${INSERT_COLS})
         VALUES (@branch, @hr_code, @full_name, @nat_type, @updated_by, ${INSERT_VALS})`,
        {
          ...params,
          branch: { type: sql.NVarChar(50), value: branch },
          hr_code: { type: sql.NVarChar(30), value: hrCode },
          full_name: { type: sql.NVarChar(150), value: fullName.slice(0, 150) },
        }
      );
    }

    const saved = hrCode
      ? await loadRow('hr_code = @hr_code', { hr_code: { type: sql.NVarChar(30), value: hrCode } }, null)
      : await loadRow('doc_id = @doc_id', { doc_id: { type: sql.Int, value: docId } }, null);
    return { message: 'บันทึกข้อมูลพนักงานเรียบร้อยแล้ว', doc: saved };
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
}

/* ===================== ผูกแถวที่นำเข้าไว้กับพนักงานในระบบ =====================
   { docId, hrCode } — ใช้กับแถวจาก Excel ที่หาพนักงานด้วยชื่อไม่เจอ */
async function linkEmployeeDoc(body, session) {
  const docId = Number(body.docId) || 0;
  const hrCode = str(body.hrCode);
  if (!docId || !hrCode) throw badRequest('ไม่ระบุรายการหรือพนักงานที่จะผูก');
  try {
    const row = await loadRow('doc_id = @doc_id', { doc_id: { type: sql.Int, value: docId } }, session);
    if (!row) throw badRequest('ไม่พบข้อมูลเอกสารนี้ (อาจถูกลบไปแล้ว)');
    if (row.hrCode) throw badRequest('รายการนี้ผูกกับพนักงานไปแล้ว');
    const taken = await queryRead(
      'SELECT TOP 1 full_name FROM dbo.employee_doc WHERE hr_code = @hr_code',
      { hr_code: { type: sql.NVarChar(30), value: hrCode } }
    );
    if (taken.length) throw badRequest(`พนักงานรหัส ${hrCode} มีข้อมูลเอกสารอยู่แล้ว (${str(taken[0].full_name)})`);
    await queryRead(
      `UPDATE dbo.employee_doc
          SET hr_code = @hr_code, updated_by = @updated_by, updated_at = SYSDATETIME()
        WHERE doc_id = @doc_id AND hr_code IS NULL`,
      {
        doc_id: { type: sql.Int, value: docId },
        hr_code: { type: sql.NVarChar(30), value: hrCode },
        updated_by: { type: sql.NVarChar(255), value: who(session) },
      }
    );
    return { message: 'ผูกข้อมูลเอกสารกับพนักงานแล้ว', docId, hrCode };
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
}

/** ลบแถวที่ยังไม่ผูกกับพนักงาน (เช่น คนที่ลาออกไปก่อนนำเข้า) — { docId } */
async function deleteEmployeeDoc(body, session) {
  const docId = Number(body.docId) || 0;
  if (!docId) throw badRequest('ไม่ระบุรายการที่จะลบ');
  try {
    const row = await loadRow('doc_id = @doc_id', { doc_id: { type: sql.Int, value: docId } }, session);
    if (!row) throw badRequest('ไม่พบข้อมูลเอกสารนี้ (อาจถูกลบไปแล้ว)');
    if (row.hrCode) throw badRequest('ลบได้เฉพาะรายการที่ยังไม่ได้ผูกกับพนักงาน');
    await queryRead(
      'DELETE FROM dbo.employee_doc WHERE doc_id = @doc_id AND hr_code IS NULL',
      { doc_id: { type: sql.Int, value: docId } }
    );
    return { message: 'ลบรายการแล้ว', docId };
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
}

/* ===================== นำเข้าจาก Excel (ผู้ใช้สิทธิ์ all) =====================
   หน้าเว็บอ่านไฟล์แล้วส่งมาเป็นแถว { branch, fullName, ...ช่องข้อมูล } — ไฟล์ไม่มีรหัส HR
   จึงจับคู่กับ hr_employee ด้วย "ชื่อ" (ตัดคำนำหน้า/ช่องว่าง ไม่สนตัวพิมพ์) ภายในสาขาเดียวกันก่อน
   ไม่เจอค่อยหาทั้งบริษัทและรับเฉพาะเมื่อมีคนเดียวที่ชื่อนี้ หาไม่เจอเลย = เก็บไว้แบบยังไม่ผูก

   นำเข้าซ้ำได้: คนที่ผูกแล้วเขียนทับด้วย hr_code, คนที่ยังไม่ผูกเขียนทับด้วย สาขา+ชื่อ */
const NAME_PREFIX = /^(นางสาว|นาง|นาย|น\.?\s*ส\.?|ด\.?\s*ช\.?|ด\.?\s*ญ\.?|mrs|miss|mr|ms)[.\s]*/i;
export const normName = (v) => str(v).replace(NAME_PREFIX, '').replace(/[\s.\-_/]+/g, '').toLowerCase();

async function importEmployeeDocs(body, session) {
  if (!session?.isAll) throw forbidden('นำเข้าไฟล์ได้เฉพาะผู้ใช้ที่ดูได้ทุกสาขา');
  const input = Array.isArray(body.rows) ? body.rows : [];
  if (input.length === 0) throw badRequest('ไม่มีข้อมูลให้นำเข้า');
  if (input.length > 2000) throw badRequest('ข้อมูลเกิน 2,000 แถวต่อครั้ง');

  // เตรียมแถว + ตรวจรูปแบบให้ครบก่อนแตะฐานข้อมูล ผิดแถวไหนบอกเลขแถวนั้น
  const prepared = input.map((r, i) => {
    const fullName = str(r.fullName);
    const branch = branchCodes(r.branch)[0] || '';
    if (!fullName || !branch) throw badRequest(`แถวที่ ${i + 1}: ไม่มีชื่อหรือสาขา`);
    const natType = natTypeOf(r.natType);
    try {
      return { fullName: fullName.slice(0, 150), branch, natType, key: normName(fullName), params: fieldParams(r, natType) };
    } catch (e) {
      throw badRequest(`แถวที่ ${i + 1} (${fullName}): ${e.message}`);
    }
  });

  // รายชื่อพนักงานทั้งบริษัท (ไม่กี่ร้อยแถว) — คนที่ยังทำงานอยู่มาก่อน เผื่อชื่อซ้ำกับคนที่ลาออก
  const emps = await hrDb.queryRead(
    `SELECT hr_code, full_name, branch, branches, status FROM dbo.hr_employee`
  ).catch(() => hrDb.queryRead(`SELECT hr_code, full_name, branch, status FROM dbo.hr_employee`));
  const byName = new Map();
  for (const e of emps) {
    const key = normName(e.full_name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }
  const working = (e) => str(e.status) !== 'ลาออก';
  const findEmp = (row) => {
    const hits = byName.get(row.key) || [];
    const inBranch = hits.filter((e) => sameBranch(str(e.branches) || e.branch, row.branch));
    const pick = (list) => list.find(working) || list[0];
    if (inBranch.length) return pick(inBranch);
    const active = hits.filter(working);
    if (active.length === 1) return active[0];
    return hits.length === 1 ? hits[0] : null;
  };

  let matched = 0;
  const unmatched = [];
  try {
    await withTransaction(async (run) => {
      const usedCodes = new Set();
      for (const row of prepared) {
        const emp = findEmp(row);
        // สองแถวในไฟล์ชี้ไปพนักงานคนเดียวกัน (ชื่อซ้ำในไฟล์) — แถวหลังเก็บแบบยังไม่ผูก ไม่ทับแถวแรก
        const hrCode = emp && !usedCodes.has(str(emp.hr_code).toLowerCase()) ? str(emp.hr_code) : '';
        const base = {
          ...row.params,
          branch: { type: sql.NVarChar(50), value: row.branch },
          full_name: { type: sql.NVarChar(150), value: row.fullName },
          nat_type: { type: sql.NVarChar(10), value: row.natType },
          updated_by: { type: sql.NVarChar(255), value: who(session) },
        };
        if (hrCode) {
          usedCodes.add(hrCode.toLowerCase());
          matched += 1;
          // แถวเดิมของคนนี้ที่เคยนำเข้าไว้แบบยังไม่ผูก ไม่ต้องเก็บซ้ำ
          await run(
            `DELETE FROM dbo.employee_doc WHERE hr_code = @hr_code
                 OR (hr_code IS NULL AND branch = @branch AND full_name = @full_name)`,
            { ...base, hr_code: { type: sql.NVarChar(30), value: hrCode } }
          );
        } else {
          unmatched.push({ fullName: row.fullName, branch: row.branch });
          await run(
            `DELETE FROM dbo.employee_doc WHERE hr_code IS NULL AND branch = @branch AND full_name = @full_name`,
            base
          );
        }
        await run(
          `INSERT INTO dbo.employee_doc (branch, hr_code, full_name, nat_type, updated_by, ${INSERT_COLS})
           VALUES (@branch, @hr_code, @full_name, @nat_type, @updated_by, ${INSERT_VALS})`,
          { ...base, hr_code: { type: sql.NVarChar(30), value: hrCode || null } }
        );
      }
    });
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }

  return {
    message: `นำเข้า ${prepared.length} คน · จับคู่กับพนักงานในระบบได้ ${matched} คน` +
      (unmatched.length ? ` · ยังไม่ได้จับคู่ ${unmatched.length} คน` : ''),
    imported: prepared.length,
    matched,
    unmatched,
  };
}

export const EMPLOYEE_DOC_ACTIONS = {
  getEmployeeDocs,
  saveEmployeeDoc,
  linkEmployeeDoc,
  deleteEmployeeDoc,
  importEmployeeDocs,
};
