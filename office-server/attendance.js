// หน้าสแกนเข้า-ออก — เวลาที่สาขา/แอดมินแก้ไขแทนเวลาสแกนจริง (ปุ่ม "แก้ไข" ในตารางสรุปรายวัน)
//
// ตารางอยู่ที่ InventoryNarai (sql/attendance-001-scan-fix.sql) เพราะตัวรัน migration ของ
// update-office-server.bat รันลงฐานนั้น — ไม่ต้องให้ใครไปสร้างตารางเองที่เครื่อง
//
// ทั้งสาขาและผู้ใช้สิทธิ์ all แก้ได้ branchFor() กันไว้แล้วว่าสาขาหนึ่งจะไปอ่าน/เขียนของอีกสาขาไม่ได้
// ส่วนข้อมูลของเครื่องสแกน (ZKBio9) ไม่ถูกแตะเลย เวลาสแกนดิบยังเห็นครบในแท็บ "ทุกครั้งที่สแกน"

import { sql, stockDb } from './hr-db.js';
import { branchFor, branchGroup } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));

/** 'H:mm' / 'HH:mm' -> 'HH:mm' | '' (ว่าง = ช่องนี้ไม่ได้แก้) | null (รูปแบบผิด) */
function timeOf(v) {
  const s = str(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

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

/** SQL Server error 208 = ยังไม่มีตาราง (ยังไม่ได้รัน update-office-server.bat) */
const tableMissing = (e) => e?.number === 208 || /Invalid object name/i.test(e?.message || '');
const MISSING_MSG = 'ยังไม่ได้สร้างตารางแก้ไขเวลาสแกน — ให้รัน update-office-server.bat บนเครื่องออฟฟิศก่อน';

const toFix = (r) => ({
  branch: str(r.branch),
  workDate: str(r.work_date_text),
  empCode: str(r.emp_code),
  empName: str(r.emp_name),
  timeIn: str(r.time_in),
  breakOut: str(r.break_out),
  breakIn: str(r.break_in),
  timeOut: str(r.time_out),
  reason: str(r.reason),
  note: str(r.note),
  savedBy: str(r.saved_by),
  savedAt: str(r.saved_text),
});

const SELECT_COLS = `branch, CONVERT(varchar(10), work_date, 23) AS work_date_text, emp_code, emp_name,
  time_in, break_out, break_in, time_out, reason, note, saved_by,
  CONVERT(varchar(16), saved_at, 120) AS saved_text`;

/** เวลาที่แก้ไว้ในช่วงวันที่ — { branch, startDate, endDate } */
async function getScanFixes(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  if (!branch || branch === 'all') throw badRequest('ไม่ระบุสาขา');
  if (!isDateStr(body.startDate) || !isDateStr(body.endDate)) throw badRequest('ระบุช่วงวันที่ไม่ถูกต้อง');

  const inBranch = branchIn(branch);
  try {
    const rows = await queryRead(
      `SELECT ${SELECT_COLS}
         FROM dbo.attendance_scan_fix
        WHERE branch IN (${inBranch.list}) AND work_date BETWEEN @start AND @end`,
      {
        ...inBranch.params,
        start: { type: sql.Date, value: str(body.startDate) },
        end: { type: sql.Date, value: str(body.endDate) },
      }
    );
    return rows.map(toFix);
  } catch (e) {
    // ยังไม่ได้สร้างตาราง = ยังไม่มีใครแก้อะไร หน้าสแกนต้องใช้งานได้ตามปกติ
    if (tableMissing(e)) return [];
    throw e;
  }
}

/**
 * บันทึก/แก้ทับเวลาของพนักงาน 1 คน 1 วัน
 * { branch, workDate, empCode, empName, timeIn, breakOut, breakIn, timeOut, reason, note }
 */
async function saveScanFix(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const workDate = str(body.workDate);
  const empCode = str(body.empCode);
  if (!branch || branch === 'all') throw badRequest('ไม่ระบุสาขา');
  if (!isDateStr(workDate)) throw badRequest('ระบุวันที่ไม่ถูกต้อง');
  if (!empCode) throw badRequest('ไม่ระบุรหัสพนักงาน');

  const times = {
    time_in: timeOf(body.timeIn),
    break_out: timeOf(body.breakOut),
    break_in: timeOf(body.breakIn),
    time_out: timeOf(body.timeOut),
  };
  if (Object.values(times).some((t) => t === null)) throw badRequest('รูปแบบเวลาต้องเป็น ชั่วโมง:นาที เช่น 09:00');
  if (Object.values(times).every((t) => !t)) throw badRequest('กรอกเวลาที่ถูกต้องอย่างน้อย 1 ช่อง');

  const reason = str(body.reason);
  if (!reason) throw badRequest('เลือกเหตุผลที่แก้ไข');

  const savedBy = str(session?.name) || str(session?.username);
  const inBranch = branchIn(branch);
  const base = {
    ...inBranch.params,
    work_date: { type: sql.Date, value: workDate },
    emp_code: { type: sql.NVarChar(64), value: empCode },
  };

  try {
    await withTransaction(async (run) => {
      // ลบของเดิม (ไม่ว่าลงไว้ใต้รหัสพี่น้องตัวไหน) แล้วเขียนใหม่ — วันหนึ่งมีได้แถวเดียว
      await run(
        `DELETE FROM dbo.attendance_scan_fix
          WHERE branch IN (${inBranch.list}) AND work_date = @work_date AND emp_code = @emp_code`,
        base
      );
      await run(
        `INSERT INTO dbo.attendance_scan_fix
           (branch, work_date, emp_code, emp_name, time_in, break_out, break_in, time_out, reason, note, saved_by)
         VALUES (@branch, @work_date, @emp_code, @emp_name, @time_in, @break_out, @break_in, @time_out, @reason, @note, @saved_by)`,
        {
          ...base,
          branch: { type: sql.NVarChar(50), value: branch },
          emp_name: { type: sql.NVarChar(255), value: str(body.empName) || null },
          time_in: { type: sql.NVarChar(5), value: times.time_in || null },
          break_out: { type: sql.NVarChar(5), value: times.break_out || null },
          break_in: { type: sql.NVarChar(5), value: times.break_in || null },
          time_out: { type: sql.NVarChar(5), value: times.time_out || null },
          reason: { type: sql.NVarChar(100), value: reason.slice(0, 100) },
          note: { type: sql.NVarChar(500), value: str(body.note).slice(0, 500) || null },
          saved_by: { type: sql.NVarChar(255), value: savedBy || null },
        }
      );
    });
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }

  return { message: 'บันทึกการแก้ไขเวลาเรียบร้อยแล้ว', branch, workDate, empCode };
}

/** ยกเลิกการแก้ไข — กลับไปใช้เวลาสแกนจริง { branch, workDate, empCode } */
async function deleteScanFix(body, session) {
  const branch = str(branchFor(session, body.branch)).toLowerCase();
  const workDate = str(body.workDate);
  const empCode = str(body.empCode);
  if (!branch || branch === 'all') throw badRequest('ไม่ระบุสาขา');
  if (!isDateStr(workDate) || !empCode) throw badRequest('ไม่ระบุรายการที่จะยกเลิก');

  const inBranch = branchIn(branch);
  try {
    const res = await queryRead(
      `DELETE FROM dbo.attendance_scan_fix
        WHERE branch IN (${inBranch.list}) AND work_date = @work_date AND emp_code = @emp_code;
       SELECT @@ROWCOUNT AS deleted;`,
      {
        ...inBranch.params,
        work_date: { type: sql.Date, value: workDate },
        emp_code: { type: sql.NVarChar(64), value: empCode },
      }
    );
    const deleted = Number(res?.[0]?.deleted ?? 0);
    if (!deleted) throw badRequest('ไม่พบการแก้ไขนี้ในสาขาของคุณ (อาจถูกยกเลิกไปแล้ว)');
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
  return { message: 'ยกเลิกการแก้ไขแล้ว กลับไปใช้เวลาสแกนจริง', branch, workDate, empCode };
}

export const ATTENDANCE_ACTIONS = {
  getScanFixes,
  saveScanFix,
  deleteScanFix,
};
