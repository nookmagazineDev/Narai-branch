// ย้ายสาขาพนักงาน — ออฟฟิศตั้งย้ายล่วงหน้าได้ ระบบย้ายให้เองเมื่อถึงวันที่มีผล
//
// ตาราง dbo.hr_branch_transfer (InventoryNarai — sql/employee-hr-002-branch-transfer.sql)
//   ตั้งย้าย   scheduleBranchTransfer  -> แถว pending (วันที่มีผลวันนี้หรือย้อนหลัง = ย้ายทันที)
//   ถึงวัน     applyDueTransfers()     -> แก้สาขาใน hr_employee + employee_doc แล้วตั้งเป็น done
//              server.js เรียกตอนเปิดเครื่องและทุก 30 นาที
//   ยกเลิก     cancelBranchTransfer    -> ได้เฉพาะรายการที่ยัง pending
//
// คนที่สังกัดหลายสาขา (branches ',sum,ipr,'): ย้ายเฉพาะสาขาหลัก สาขาอื่นในพวงคงไว้
// ตารางงาน/ค่าแรงย้อนหลังไม่ย้ายตาม — hr_timesheet เก็บสาขาไว้ในแต่ละแถวอยู่แล้ว
//
// ทุกคำสั่งในไฟล์นี้เป็นของออฟฟิศ (ผู้ใช้สิทธิ์ all) — สาขาย้ายพนักงานเองไม่ได้

import { sql, hrDb, stockDb } from './hr-db.js';
import { branchCodes, primaryBranch } from './hr-session.js';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const forbidden = (msg) => Object.assign(new Error(msg), { forbidden: true });
const who = (session) => str(session?.name) || str(session?.username) || null;

const tableMissing = (e) => e?.number === 208 || /Invalid object name/i.test(e?.message || '');
const MISSING_MSG = 'ยังไม่ได้สร้างตารางย้ายสาขา — ให้รัน update-office-server.bat บนเครื่องออฟฟิศก่อน';

function requireOffice(session) {
  if (!session?.isAll) throw forbidden('ย้ายสาขาพนักงานได้ที่ออฟฟิศเท่านั้น');
}

const BKK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayBkk = () => BKK_DATE.format(new Date());

function ymdOrNull(v) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2200 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** รหัสสาขาที่ใช้ได้: ตัวอักษร/ตัวเลข 2-10 ตัว ตัวพิมพ์เล็ก */
const branchCodeOf = (v) => {
  const c = primaryBranch(v);
  return /^[a-z0-9]{2,10}$/.test(c) ? c : '';
};

let branchesColumn = null;
function hasBranchesColumn() {
  if (branchesColumn === null) {
    branchesColumn = hrDb.queryRead(`SELECT COL_LENGTH(N'dbo.hr_employee', N'branches') AS len`)
      .then((rows) => rows[0]?.len != null)
      .catch(() => { branchesColumn = null; return false; });
  }
  return branchesColumn;
}

async function loadEmployee(hrCode) {
  const withList = await hasBranchesColumn();
  const rows = await hrDb.queryRead(
    `SELECT hr_code, full_name, branch, status${withList ? ', branches' : ''} FROM dbo.hr_employee WHERE hr_code = @c`,
    { c: { type: sql.NVarChar(30), value: str(hrCode) } }
  );
  return rows[0] || null;
}

/** พวงสาขาหลังย้าย — แทนสาขาหลักเดิมด้วยสาขาใหม่ สาขาอื่นในพวงคงไว้ (ตัดซ้ำ) */
export function branchesAfterMove(branchesValue, currentPrimary, toBranch) {
  const list = branchCodes(branchesValue);
  const from = str(currentPrimary).toLowerCase();
  const next = list.length ? list.map((c) => (c === from ? toBranch : c)) : [toBranch];
  if (!next.includes(toBranch)) next.unshift(toBranch);
  // สาขาใหม่ขึ้นก่อนเสมอ — รหัสแรกของพวงคือสาขาหลัก (ดู primaryBranch ใน hr-session.js)
  const ordered = [toBranch, ...next.filter((c) => c !== toBranch)];
  return `,${[...new Set(ordered)].join(',')},`;
}

/* ===================== ย้ายจริง (ใช้ทั้งตอนตั้งย้ายแบบมีผลทันที และตอนถึงวัน) ===================== */
async function applyTransfer(t) {
  const emp = await loadEmployee(t.hr_code);
  const to = str(t.to_branch);
  if (emp) {
    const withList = await hasBranchesColumn();
    await hrDb.queryRead(
      `UPDATE dbo.hr_employee SET branch = @to${withList ? ', branches = @list' : ''}, updated_at = SYSDATETIME()
        WHERE hr_code = @c`,
      {
        c: { type: sql.NVarChar(30), value: str(t.hr_code) },
        to: { type: sql.NVarChar(50), value: to },
        ...(withList ? { list: { type: sql.NVarChar(200), value: branchesAfterMove(emp.branches || emp.branch, emp.branch, to) } } : {}),
      }
    );
    // เอกสารต่างชาติของคนนี้ต้องไปขึ้นแจ้งเตือนที่สาขาใหม่ด้วย — ยังไม่มีตาราง/ไม่มีแถวก็ไม่เป็นไร
    await stockDb.queryRead(
      `UPDATE dbo.employee_doc SET branch = @to, updated_at = SYSDATETIME() WHERE hr_code = @c`,
      { c: { type: sql.NVarChar(30), value: str(t.hr_code) }, to: { type: sql.NVarChar(50), value: to } }
    ).catch((e) => { if (!tableMissing(e)) throw e; });
  }
  // พนักงานถูกลบไปจากรายชื่อแล้ว = ปิดรายการไปเลย ไม่ค้างเป็น pending ตลอดกาล
  await stockDb.queryRead(
    `UPDATE dbo.hr_branch_transfer SET status = N'done', applied_at = SYSDATETIME()
      WHERE transfer_id = @id AND status = N'pending'`,
    { id: { type: sql.Int, value: Number(t.transfer_id) } }
  );
}

/** ย้ายทุกรายการที่ถึงวันที่มีผลแล้ว — server.js เรียกตอนเปิดเครื่องและทุก 30 นาที */
export async function applyDueTransfers() {
  let due;
  try {
    due = await stockDb.queryRead(
      `SELECT transfer_id, hr_code, to_branch FROM dbo.hr_branch_transfer
        WHERE status = N'pending' AND effective_date <= @today ORDER BY effective_date, transfer_id`,
      { today: { type: sql.Date, value: todayBkk() } }
    );
  } catch (e) {
    if (tableMissing(e)) return { applied: 0, skipped: 'ยังไม่มีตาราง' };
    throw e;
  }
  let applied = 0;
  for (const t of due) {
    try {
      await applyTransfer(t);
      applied += 1;
    } catch (e) {
      // พลาดคนหนึ่งไม่ให้คนอื่นค้าง — รอบหน้า (30 นาที) ลองใหม่เอง เพราะยัง pending อยู่
      console.error(`ย้ายสาขา ${t.hr_code} -> ${t.to_branch} ไม่สำเร็จ:`, e?.message || e);
    }
  }
  if (applied) console.log(`ย้ายสาขาพนักงานที่ถึงวันที่มีผลแล้ว ${applied} คน`);
  return { applied };
}

/** เริ่มงานย้ายตามกำหนด — เรียกครั้งเดียวจาก server.js หลังเปิดพอร์ต */
export function startTransferScheduler() {
  const run = () => applyDueTransfers().catch((e) => console.error('งานย้ายสาขาตามกำหนดล้ม:', e?.message || e));
  setTimeout(run, 20 * 1000);
  setInterval(run, 30 * 60 * 1000);
}

/* ===================== คำสั่งจากหน้าเว็บ (ออฟฟิศ) ===================== */

/** { hrCode, toBranch, effectiveDate, reason } */
async function scheduleBranchTransfer(body, session) {
  requireOffice(session);
  const to = branchCodeOf(body.toBranch);
  if (!to) throw badRequest('เลือกสาขาที่จะย้ายไป');
  const effective = ymdOrNull(body.effectiveDate);
  if (!effective) throw badRequest('ระบุวันที่มีผลให้ถูกต้อง');
  const emp = await loadEmployee(body.hrCode);
  if (!emp) throw badRequest(`ไม่พบพนักงานรหัส ${str(body.hrCode)}`);
  if (str(emp.status) === 'ลาออก') throw badRequest('พนักงานคนนี้ลาออกแล้ว ย้ายสาขาไม่ได้');
  const from = str(emp.branch).toLowerCase();
  if (from === to) throw badRequest(`พนักงานอยู่สาขา ${to.toUpperCase()} อยู่แล้ว`);

  let row;
  try {
    const rows = await stockDb.queryRead(
      `INSERT INTO dbo.hr_branch_transfer (hr_code, full_name, from_branch, to_branch, effective_date, reason, requested_by)
       OUTPUT INSERTED.transfer_id, INSERTED.hr_code, INSERTED.to_branch
       VALUES (@c, @name, @from, @to, @eff, @reason, @by)`,
      {
        c: { type: sql.NVarChar(30), value: str(emp.hr_code) },
        name: { type: sql.NVarChar(150), value: str(emp.full_name) },
        from: { type: sql.NVarChar(50), value: from },
        to: { type: sql.NVarChar(50), value: to },
        eff: { type: sql.Date, value: effective },
        reason: { type: sql.NVarChar(500), value: str(body.reason).slice(0, 500) || null },
        by: { type: sql.NVarChar(255), value: who(session) },
      }
    );
    row = rows[0];
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    // 2601 = ชนดัชนี "รอย้ายได้คนละหนึ่งรายการ"
    if (e?.number === 2601 || e?.number === 2627) {
      throw badRequest('พนักงานคนนี้มีรายการรอย้ายอยู่แล้ว — ยกเลิกรายการเดิมในประวัติสาขาก่อน');
    }
    throw e;
  }

  // วันที่มีผลคือวันนี้หรือย้อนหลัง = ย้ายเลย ไม่ต้องรอรอบ 30 นาที
  if (effective <= todayBkk()) {
    await applyTransfer(row);
    return { message: `ย้าย ${str(emp.full_name)} จาก ${from.toUpperCase()} ไป ${to.toUpperCase()} แล้ว`, applied: true, transferId: Number(row.transfer_id) };
  }
  return {
    message: `ตั้งย้าย ${str(emp.full_name)} ไป ${to.toUpperCase()} แล้ว — ระบบจะย้ายให้เองวันที่ ${effective}`,
    applied: false,
    transferId: Number(row.transfer_id),
  };
}

/** { transferId } — ได้เฉพาะรายการที่ยังไม่ถึงวัน */
async function cancelBranchTransfer(body, session) {
  requireOffice(session);
  const id = Number(body.transferId) || 0;
  if (!id) throw badRequest('ไม่ระบุรายการ');
  try {
    const rows = await stockDb.queryRead(
      `UPDATE dbo.hr_branch_transfer SET status = N'cancelled', cancelled_by = @by, cancelled_at = SYSDATETIME()
        WHERE transfer_id = @id AND status = N'pending';
       SELECT @@ROWCOUNT AS n;`,
      { id: { type: sql.Int, value: id }, by: { type: sql.NVarChar(255), value: who(session) } }
    );
    if (!Number(rows[0]?.n)) throw badRequest('ยกเลิกไม่ได้ — รายการนี้ย้ายไปแล้วหรือถูกยกเลิกไปก่อนแล้ว');
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
  return { message: 'ยกเลิกการย้ายสาขาแล้ว' };
}

const toTransfer = (r) => ({
  id: Number(r.transfer_id),
  hrCode: str(r.hr_code),
  fullName: str(r.full_name),
  fromBranch: str(r.from_branch),
  toBranch: str(r.to_branch),
  effectiveDate: str(r.effective_text),
  reason: str(r.reason),
  status: str(r.status),
  requestedBy: str(r.requested_by),
  requestedAt: str(r.requested_text),
  appliedAt: str(r.applied_text),
  cancelledBy: str(r.cancelled_by),
});
const SELECT_COLS = `transfer_id, hr_code, full_name, from_branch, to_branch, reason, status, requested_by, cancelled_by,
  CONVERT(varchar(10), effective_date, 23) AS effective_text,
  CONVERT(varchar(16), requested_at, 120) AS requested_text,
  CONVERT(varchar(16), applied_at, 120) AS applied_text`;

/**
 * รายการย้ายสาขา (ดูอย่างเดียว)
 *   { pending: true }                 รายการรอย้ายทั้งหมด (ป้าย "รอย้าย" ในตาราง)
 *   { hrCode }                        ประวัติของคนเดียว + วันเข้าทำงาน (กล่องข้อมูลพนักงาน)
 *   { start, end, branch? }           ตามช่วงวันที่มีผล (แท็บย้ายสาขาในหน้าพนักงานเข้า-ออก)
 */
async function getBranchTransfers(body, session) {
  requireOffice(session);
  try {
    if (body.pending === true) {
      const rows = await stockDb.queryRead(`SELECT ${SELECT_COLS} FROM dbo.hr_branch_transfer WHERE status = N'pending'`);
      return { ready: true, data: rows.map(toTransfer) };
    }
    const hrCode = str(body.hrCode);
    if (hrCode) {
      const c = { type: sql.NVarChar(30), value: hrCode };
      const rows = await stockDb.queryRead(
        `SELECT ${SELECT_COLS} FROM dbo.hr_branch_transfer WHERE hr_code = @c
          ORDER BY effective_date DESC, transfer_id DESC`, { c });
      // วันเข้าทำงานจากประวัติเข้า-ออก (ถ้ามี) — ไว้เป็นจุดเริ่มของเส้นประวัติ
      const joined = await stockDb.queryRead(
        `SELECT TOP 1 branch, recorded_by, CONVERT(varchar(10), start_date, 23) AS start_text,
                CONVERT(varchar(16), recorded_at, 120) AS recorded_text
           FROM dbo.hr_employee_movement WHERE kind = N'in' AND hr_code = @c ORDER BY recorded_at`, { c }
      ).catch(() => []);
      const j = joined[0];
      return {
        ready: true,
        data: rows.map(toTransfer),
        joined: j ? { branch: str(j.branch), startDate: str(j.start_text), recordedBy: str(j.recorded_by), recordedAt: str(j.recorded_text) } : null,
      };
    }
    const start = ymdOrNull(body.start);
    const end = ymdOrNull(body.end);
    if (!start || !end || start > end) throw badRequest('ระบุช่วงวันที่ให้ถูกต้อง');
    const branch = branchCodeOf(body.branch);
    const rows = await stockDb.queryRead(
      `SELECT ${SELECT_COLS} FROM dbo.hr_branch_transfer
        WHERE effective_date BETWEEN @start AND @end AND status <> N'cancelled'
          ${branch ? 'AND (from_branch = @b OR to_branch = @b)' : ''}
        ORDER BY effective_date DESC, transfer_id DESC`,
      {
        start: { type: sql.Date, value: start },
        end: { type: sql.Date, value: end },
        ...(branch ? { b: { type: sql.NVarChar(50), value: branch } } : {}),
      }
    );
    return { ready: true, data: rows.map(toTransfer) };
  } catch (e) {
    if (tableMissing(e)) return { ready: false, data: [] };
    throw e;
  }
}

export const BRANCH_TRANSFER_ACTIONS = {
  scheduleBranchTransfer,
  cancelBranchTransfer,
  getBranchTransfers,
};
