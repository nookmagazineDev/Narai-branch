// ตารางงาน (ลงตารางสัปดาห์ / ประวัติ / อนุมัติ OT) — อ่าน-เขียนตรงกับ MS SQL Server
//   เครื่อง 203.154.185.48 ฐานข้อมูล narai_hr (ดู docs/schema-hr.sql และ lib/mssql.js)
//
// แทนที่ Google Apps Script เดิมที่เก็บข้อมูลในชีท "ลงตารางงาน"
// รับเป็น POST เดียวแล้วแยกด้วย body.action ให้เหมือนสัญญาเดิมของ apiCall()
// ฝั่งเว็บจึงไม่ต้องแก้หน้าไหนเลย (ดู SQL_ACTIONS ใน src/services/api.js)
//   { action, ...payload }  ->  { status:'success', data } | { status:'error', message }
//
// รวมทุก action ไว้ไฟล์เดียวเพราะ Vercel จำกัด 12 Serverless Functions และตอนนี้เต็มพอดี

import { sql, queryRead, withTransaction, replyDbError, isConfigured } from '../lib/mssql.js';

/* ลำดับตำแหน่งสำหรับเรียงพนักงานในตาราง — ยกมาจาก Apps Script เดิมทั้งชุด */
const POSITION_PRIORITY = {
  'ผู้จัดการ': 1, 'ผู้จัดการ ฝึก': 2, 'ผู้จัดการฝึก': 2,
  'ผช.ผู้จัดการ': 3, 'ผช.ผู้จัดการ ฝึก': 4, 'ผช.ผู้จัดการฝึก': 4,
  'ซุปเปอร์ไวเซอร์': 5, 'Supervisor': 5, 'ซุปเปอร์ไวเซอร์ ฝึก': 6, 'ซุปเปอร์ไวเซอร์ฝึก': 6,
  'Pre.Sup': 7, 'แคชเชียร์': 8, 'บริการ': 9, 'หัวหน้ากุ๊ก': 10, 'กุ๊ก': 11, 'ล้างจาน': 12,
};
const positionPriority = (p) => POSITION_PRIORITY[String(p || '').trim()] || 99;

const CLEAR_NOTE = 'ล้างข้อมูล'; // ค่าที่ฝั่งเว็บส่งมาเมื่อสั่งล้างช่องนั้นทิ้ง

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
/** เก็บเวลาเป็นข้อความ 'HH:mm' — ค่า '24:00' ใช้ได้จริงในระบบเดิม จึงไม่แปลงเป็นชนิด TIME */
const timeOrNull = (v) => (/^\d{1,2}:\d{2}$/.test(str(v)) ? str(v).padStart(5, '0') : null);
const textOrNull = (v) => (str(v) === '' ? null : str(v));

/* ---------------------------- ผู้ใช้ที่ล็อกอินไว้ ----------------------------
   ไม่มีการล็อกอินซ้อนอีกชั้นที่นี่ — ใช้ user เดิมที่ล็อกอินเข้าระบบมาตั้งแต่แรก
   ฝั่งเว็บแนบมาให้ในฟิลด์ _user อัตโนมัติทุกคำสั่ง (ดู src/services/api.js)

   ข้อจำกัดที่ต้องรู้: _user มาจาก localStorage ของเบราว์เซอร์ ผู้ใช้แก้เองได้
   จึงกันได้แค่การกดผิดสาขาโดยไม่ตั้งใจ ไม่ใช่การกันคนที่ตั้งใจปลอม
   ถ้าต้องการกันจริงต้องให้ตอน login ออก token ที่เซ็นชื่อไว้แล้วตรวจที่นี่
   (ตอนนี้ Apps Script เดิมก็เชื่อสาขาที่ฝั่งเว็บส่งมาแบบเดียวกัน)
------------------------------------------------------------------------- */
function sessionOf(body) {
  const u = body && typeof body._user === 'object' ? body._user : null;
  const username = str(u?.username);
  if (!username) return null;
  const branch = str(u?.branch);
  return { username, branch, isAll: branch.toLowerCase() === 'all' };
}

/**
 * สาขาที่คำสั่งนี้ทำงานด้วยได้จริง
 * user สิทธิ์ all เลือกสาขาไหนก็ได้ นอกนั้นถูกล็อกไว้ที่สาขาตัวเองเสมอ
 * (หน้าเว็บล็อกไว้อยู่แล้ว ตรงนี้กันซ้ำอีกชั้นเผื่อเรียก API ตรงๆ)
 */
function branchFor(session, requested) {
  const want = str(requested);
  if (!session) return want;
  if (session.isAll) return want;
  if (want && want.toLowerCase() !== session.branch.toLowerCase()) {
    throw Object.assign(new Error(`ไม่มีสิทธิ์ดูข้อมูลของสาขา ${want}`), { forbidden: true });
  }
  return session.branch;
}

/** แปลงแถวในตารางเป็นรูปแบบเดียวกับที่ Apps Script เคยตอบ ฝั่งเว็บจะได้ไม่ต้องแก้ */
function toHistoryRow(r) {
  const d = r.work_date instanceof Date ? r.work_date : new Date(r.work_date);
  const workDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    timestamp: r.updated_at ? new Date(r.updated_at).toISOString() : '',
    workDate,
    branch: r.branch || '',
    hrCode: r.hr_code || '',
    name: r.emp_name || '',
    position: r.position || '',
    empType: r.emp_type || '',
    checkIn: r.check_in || '',
    checkOut: r.check_out || '',
    breakTime: r.break_time || '',
    breakTimeRange: r.break_range || '',
    ot: String(r.ot_hours ?? 0),
    otAccumulated: String(r.ot_accumulated ?? 0),
    useAccumulatedHours: String(r.use_accumulated_hours ?? 0),
    hourlyLeave: String(r.hourly_leave ?? 0),
    wage: String(r.wage ?? 0),
    status: r.status || '',
    leaveNote: r.leave_note || '',
    unpaidLeave: r.unpaid_leave || '',
    otherNote: r.other_note || '',
    workStation: r.work_station || '',
    otApprover: r.ot_approver || '',
  };
}

const HISTORY_COLUMNS = `
  work_date, branch, hr_code, emp_name, position, emp_type,
  check_in, check_out, break_time, break_range,
  ot_hours, ot_accumulated, use_accumulated_hours, hourly_leave,
  wage, status, leave_note, unpaid_leave, other_note, work_station, ot_approver, updated_at`;

/* ------------------------------- actions -------------------------------- */

/** รายชื่อสาขา — ตอบเป็น [{name, outletId}] ให้ตรงกับที่หน้าเว็บอ่าน (br.name) */
async function getBranches(body, session) {
  const rows = await queryRead(
    `SELECT branch, branch_name, outlet_id FROM dbo.hr_branch WHERE is_active = 1 ORDER BY branch`
  );
  return rows
    // user ที่ไม่ใช่สิทธิ์ all เห็นแค่สาขาตัวเอง
    .filter((r) => !session || session.isAll || str(r.branch).toLowerCase() === session.branch.toLowerCase())
    .map((r) => ({ name: r.branch, fullName: r.branch_name || r.branch, outletId: r.outlet_id ?? null }));
}

/** พนักงานที่ยังทำงานอยู่ของสาขานั้น เรียงตามลำดับตำแหน่งแบบเดิม */
async function getScheduleEmployees(body, session) {
  const branch = branchFor(session, body.branch);
  if (!branch) return [];
  const rows = await queryRead(
    `SELECT hr_code, full_name, branch, emp_type, position, daily_wage
       FROM dbo.hr_employee
      WHERE branch = @branch AND status = N'ทำงาน'`,
    { branch: { type: sql.NVarChar(50), value: branch } }
  );
  return rows
    .map((r) => ({
      hrCode: r.hr_code,
      name: r.full_name,
      branch: r.branch,
      type: r.emp_type || '',
      empType: r.emp_type || '', // ชื่อเดิมของฟิลด์ เผื่อหน้าที่ยังอ่านชื่อนี้อยู่
      position: r.position || '',
      dailyWage: Number(r.daily_wage ?? 0),
    }))
    .sort((a, b) => positionPriority(a.position) - positionPriority(b.position));
}

/** เป้าขาย/ค่าแรงสูงสุดต่อวันของสาขา */
async function getBranchStats(body, session) {
  const branch = branchFor(session, body.branch);
  const rows = await queryRead(
    `SELECT daily_target, monthly_target, max_wage FROM dbo.hr_branch WHERE branch = @branch`,
    { branch: { type: sql.NVarChar(50), value: branch } }
  );
  const r = rows[0];
  return {
    dailyTarget: r ? Number(r.daily_target) : 0,
    monthlyTarget: r ? Number(r.monthly_target) : 0,
    maxWage: r ? Number(r.max_wage) : 0,
  };
}

/** ยอดขายของวัน (หน้าประวัติใช้เทียบกับค่าแรง) */
async function getDailySales(body, session) {
  const branch = branchFor(session, body.searchBranch || body.branch);
  const date = str(body.searchDateStr || body.searchDate || body.date);
  if (!isDateStr(date)) return { sales: 0 };
  const rows = await queryRead(
    `SELECT sales FROM dbo.hr_daily_sales WHERE sale_date = @d AND branch = @branch`,
    { d: { type: sql.Date, value: date }, branch: { type: sql.NVarChar(50), value: branch } }
  );
  return { sales: rows[0] ? Number(rows[0].sales) : 0 };
}

/**
 * ประวัติตารางงาน — รับได้สองแบบให้ตรงกับที่หน้าเว็บเรียกอยู่
 *   { branch, startDate, endDate } ช่วงสัปดาห์ (หน้าลงตาราง)
 *   { branch, searchDate }         วันเดียว (หน้าประวัติ)
 */
async function getHistoryData(body, session) {
  const branch = branchFor(session, body.branch || body.searchBranch);
  if (!branch) return [];

  const single = str(body.searchDate);
  const start = isDateStr(single) ? single : str(body.startDate);
  const end = isDateStr(single) ? single : str(body.endDate);
  if (!isDateStr(start) || !isDateStr(end)) {
    throw Object.assign(new Error('ระบุช่วงวันที่ไม่ถูกต้อง'), { badRequest: true });
  }

  const rows = await queryRead(
    `SELECT ${HISTORY_COLUMNS}
       FROM dbo.hr_timesheet
      WHERE branch = @branch AND work_date BETWEEN @start AND @end`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      start: { type: sql.Date, value: start },
      end: { type: sql.Date, value: end },
    }
  );
  return rows
    .map(toHistoryRow)
    .sort((a, b) =>
      a.workDate === b.workDate
        ? positionPriority(a.position) - positionPriority(b.position)
        : a.workDate < b.workDate ? -1 : 1
    );
}

/**
 * บันทึกตารางงาน — หนึ่งแถวต่อพนักงานต่อวัน
 * ชีทเดิมต่อท้ายแถวใหม่ทุกครั้งแล้วค่อยหยิบแถวล่าสุดตอนอ่าน ที่นี่เขียนทับด้วย MERGE
 * และถ้า otherNote === 'ล้างข้อมูล' คือสั่งลบแถวนั้นจริงๆ
 * ทั้งชุดอยู่ใน transaction เดียว — บันทึกทั้งสัปดาห์แล้วพลาดกลางคันจะไม่เหลือข้อมูลครึ่งๆ
 */
async function saveTimesheet(body, session) {
  const logs = Array.isArray(body.logs) ? body.logs : [];
  if (logs.length === 0) {
    throw Object.assign(new Error('ไม่มีข้อมูลที่จะบันทึก'), { badRequest: true });
  }
  // คนที่กดบันทึก = user ที่ล็อกอินไว้ ไม่ได้เอาค่าที่หน้าเว็บส่งมาเอง
  const actor = textOrNull(session?.username);

  let saved = 0;
  let cleared = 0;

  await withTransaction(async (run) => {
    for (const item of logs) {
      const workDate = str(item.workDate);
      const branch = branchFor(session, item.branch);
      const hrCode = str(item.hrCode);
      if (!isDateStr(workDate) || !branch || !hrCode) continue;

      const key = {
        d: { type: sql.Date, value: workDate },
        branch: { type: sql.NVarChar(50), value: branch },
        hrCode: { type: sql.NVarChar(30), value: hrCode },
      };
      const isClear = str(item.otherNote) === CLEAR_NOTE;

      if (isClear) {
        await run(
          `DELETE FROM dbo.hr_timesheet WHERE work_date = @d AND branch = @branch AND hr_code = @hrCode`,
          key
        );
        cleared++;
      } else {
        await run(
          `MERGE dbo.hr_timesheet WITH (HOLDLOCK) AS t
             USING (SELECT @d AS work_date, @branch AS branch, @hrCode AS hr_code) AS s
                ON t.work_date = s.work_date AND t.branch = s.branch AND t.hr_code = s.hr_code
           WHEN MATCHED THEN UPDATE SET
                emp_name = @name, position = @position, emp_type = @empType,
                check_in = @checkIn, check_out = @checkOut,
                break_time = @breakTime, break_range = @breakRange,
                ot_hours = @ot, ot_accumulated = @otAcc,
                use_accumulated_hours = @useAcc, hourly_leave = @hourlyLeave,
                wage = @wage, status = @status,
                leave_note = @leaveNote, unpaid_leave = @unpaidLeave,
                other_note = @otherNote, work_station = @workStation,
                updated_at = SYSDATETIME(), updated_by = @actor
           WHEN NOT MATCHED THEN INSERT (
                work_date, branch, hr_code, emp_name, position, emp_type,
                check_in, check_out, break_time, break_range,
                ot_hours, ot_accumulated, use_accumulated_hours, hourly_leave,
                wage, status, leave_note, unpaid_leave, other_note, work_station, updated_by)
           VALUES (
                @d, @branch, @hrCode, @name, @position, @empType,
                @checkIn, @checkOut, @breakTime, @breakRange,
                @ot, @otAcc, @useAcc, @hourlyLeave,
                @wage, @status, @leaveNote, @unpaidLeave, @otherNote, @workStation, @actor);`,
          {
            ...key,
            name: { type: sql.NVarChar(150), value: textOrNull(item.name) },
            position: { type: sql.NVarChar(100), value: textOrNull(item.position) },
            empType: { type: sql.NVarChar(20), value: textOrNull(item.empType) },
            checkIn: { type: sql.VarChar(5), value: timeOrNull(item.checkIn) },
            checkOut: { type: sql.VarChar(5), value: timeOrNull(item.checkOut) },
            breakTime: { type: sql.NVarChar(20), value: textOrNull(item.breakTime) },
            breakRange: { type: sql.VarChar(20), value: textOrNull(item.breakTimeRange) },
            ot: { type: sql.Decimal(5, 2), value: num(item.ot) },
            otAcc: { type: sql.Decimal(5, 2), value: num(item.otAccumulated) },
            useAcc: { type: sql.Decimal(5, 2), value: num(item.useAccumulatedHours) },
            hourlyLeave: { type: sql.Decimal(5, 2), value: num(item.hourlyLeave) },
            wage: { type: sql.Decimal(12, 2), value: num(item.wage) },
            status: { type: sql.NVarChar(20), value: str(item.status) || (item.isStop ? 'หยุด' : 'มาทำงาน') },
            leaveNote: { type: sql.NVarChar(100), value: textOrNull(item.leaveNote) },
            unpaidLeave: { type: sql.NVarChar(100), value: textOrNull(item.unpaidLeave) },
            otherNote: { type: sql.NVarChar(255), value: textOrNull(item.otherNote) },
            workStation: { type: sql.NVarChar(100), value: textOrNull(item.workStation) },
            actor: { type: sql.NVarChar(100), value: actor },
          }
        );
        saved++;
      }

      await run(
        `INSERT INTO dbo.hr_timesheet_log (action, work_date, branch, hr_code, actor, payload)
         VALUES (@action, @d, @branch, @hrCode, @actor, @payload)`,
        {
          ...key,
          action: { type: sql.VarChar(10), value: isClear ? 'clear' : 'save' },
          actor: { type: sql.NVarChar(100), value: actor },
          payload: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(item) },
        }
      );
    }
  });

  return { saved, cleared };
}

/**
 * อนุมัติ OT ทั้งวันของสาขา — ติ๊ก = ใส่ชื่อผู้อนุมัติ, ไม่ติ๊ก = ล้างชื่อทิ้ง
 * จับคู่ด้วย hrCode ถ้ามี (ชีทเดิมจับด้วยชื่อ พนักงานชื่อซ้ำกันจะโดนอนุมัติพร้อมกันทั้งคู่)
 */
async function updateOTApprovalBulk(body, session) {
  const dateStr = str(body.dateStr);
  const branch = branchFor(session, body.branch);
  const updates = Array.isArray(body.updates) ? body.updates : [];
  // ผู้อนุมัติ = user ที่ล็อกอินไว้เสมอ จะได้ปลอมชื่อผู้อนุมัติจากหน้าเว็บไม่ได้
  const approver = str(session?.username) || str(body.approverName) || 'Admin';

  if (!isDateStr(dateStr) || !branch) {
    throw Object.assign(new Error('ระบุวันที่หรือสาขาไม่ถูกต้อง'), { badRequest: true });
  }

  let updated = 0;
  await withTransaction(async (run) => {
    for (const u of updates) {
      const hrCode = str(u.hrCode);
      const name = str(u.name);
      if (!hrCode && !name) continue;

      const value = u.isApproved ? approver : null;
      const r = await run(
        `UPDATE dbo.hr_timesheet
            SET ot_approver = @approver, updated_at = SYSDATETIME()
          WHERE work_date = @d AND branch = @branch
            AND (${hrCode ? 'hr_code = @hrCode' : 'emp_name = @name'})`,
        {
          d: { type: sql.Date, value: dateStr },
          branch: { type: sql.NVarChar(50), value: branch },
          hrCode: { type: sql.NVarChar(30), value: hrCode || null },
          name: { type: sql.NVarChar(150), value: name || null },
          approver: { type: sql.NVarChar(100), value: value },
        }
      );
      updated += r.rowsAffected?.[0] || 0;

      await run(
        `INSERT INTO dbo.hr_timesheet_log (action, work_date, branch, hr_code, actor, payload)
         VALUES ('ot', @d, @branch, @hrCode, @actor, @payload)`,
        {
          d: { type: sql.Date, value: dateStr },
          branch: { type: sql.NVarChar(50), value: branch },
          hrCode: { type: sql.NVarChar(30), value: hrCode || name },
          actor: { type: sql.NVarChar(100), value: approver },
          payload: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(u) },
        }
      );
    }
  });

  return { updated };
}

/** จุดปฏิบัติงานของวัน (ยังไม่มีหน้าไหนเรียก แต่ระบบเดิมมี จึงย้ายมาด้วยกัน) */
async function updateWorkStation(body, session) {
  const dateStr = str(body.dateStr);
  const branch = branchFor(session, body.branch);
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!isDateStr(dateStr) || !branch) {
    throw Object.assign(new Error('ระบุวันที่หรือสาขาไม่ถูกต้อง'), { badRequest: true });
  }

  let updated = 0;
  await withTransaction(async (run) => {
    for (const u of updates) {
      const hrCode = str(u.hrCode);
      const name = str(u.name);
      if (!hrCode && !name) continue;
      const r = await run(
        `UPDATE dbo.hr_timesheet
            SET work_station = @station, updated_at = SYSDATETIME()
          WHERE work_date = @d AND branch = @branch
            AND (${hrCode ? 'hr_code = @hrCode' : 'emp_name = @name'})`,
        {
          d: { type: sql.Date, value: dateStr },
          branch: { type: sql.NVarChar(50), value: branch },
          hrCode: { type: sql.NVarChar(30), value: hrCode || null },
          name: { type: sql.NVarChar(150), value: name || null },
          station: { type: sql.NVarChar(100), value: textOrNull(u.station) },
        }
      );
      updated += r.rowsAffected?.[0] || 0;
    }
  });
  return { updated };
}

const ACTIONS = {
  getBranches,
  getBranchList: getBranches,
  getScheduleEmployees,
  getBranchStats,
  getDailySales,
  getHistoryData,
  saveTimesheet,
  updateOTApprovalBulk,
  updateWorkStation,
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ POST' });
  }

  // body อาจมาเป็นข้อความล้วนถ้า Content-Type ไม่ใช่ application/json
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ status: 'error', message: 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง' });
    }
  }
  body = body || {};

  const action = str(body.action);
  const run = ACTIONS[action];
  if (!run) {
    return res.status(400).json({ status: 'error', message: `ไม่รู้จักคำสั่ง "${action}"` });
  }

  if (!isConfigured()) {
    return res.status(503).json({
      status: 'error',
      message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล HR (HR_DB_USER / HR_DB_PASSWORD) บนเซิร์ฟเวอร์',
    });
  }

  // ใช้ user ที่ล็อกอินเข้าระบบมาตั้งแต่แรก ไม่มีการล็อกอินซ้ำที่นี่
  // ถ้า session หลุด (ล้าง localStorage / ยังไม่ได้ล็อกอิน) ให้บอกไปตรงๆ ว่าต้องเข้าสู่ระบบใหม่
  const session = sessionOf(body);
  if (!session) {
    return res.status(401).json({ status: 'error', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }

  try {
    const data = await run(body, session);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    if (error?.badRequest) {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    if (error?.forbidden) {
      return res.status(403).json({ status: 'error', message: error.message });
    }
    return replyDbError(res, error, `schedule:${action}`);
  }
}
