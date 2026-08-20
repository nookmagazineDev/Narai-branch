// ตารางงาน (ลงตารางสัปดาห์ / ประวัติ / อนุมัติ OT) — อ่าน-เขียน SQL Server narai_hr
// ที่อยู่บนเครื่องเดียวกันนี้ ผ่าน localhost:1433
//
// ทำไมตรรกะนี้ถึงย้ายมาอยู่ที่ office-server แทนที่จะอยู่บน Vercel:
// ไฟร์วอลล์ของออฟฟิศเปิดพอร์ต 1433 ให้เฉพาะ IP ในไทย แต่ฟังก์ชันบน Vercel วิ่งมาจากต่างประเทศ
// จึงต่อฐานข้อมูลไม่ติด กดบันทึกตารางแล้วขึ้น error มาตลอด
// เครื่องนี้ต่อ SQL Server ผ่าน localhost ได้อยู่แล้ว (ไม่ผ่านไฟร์วอลล์) และ Vercel ก็เรียก
// เครื่องนี้ที่พอร์ต 8787 ได้อยู่แล้ว (หน้ายอดขาย/สต๊อกใช้ทางนี้ทุกวัน) จึงต่อกันสองทอดแทน
//
//   เบราว์เซอร์ -> /api/schedule (Vercel, เป็นแค่ตัวส่งต่อ) -> :8787/schedule (ไฟล์นี้) -> SQL Server
//
// รูปแบบ request/response เหมือนเดิมทุกอย่าง { action, ...payload } -> { status, data }
// หน้าเว็บจึงไม่ต้องแก้อะไรเลย
//
// ตั้งค่าใน .env: HR_DB_USER, HR_DB_PASSWORD (และ HR_DB_HOST/HR_DB_NAME/HR_DB_PORT/HR_DB_INSTANCE ถ้าไม่ใช้ค่าเริ่มต้น)

import sql from 'mssql';
import { queryRead, withTransaction, describeDbError, isConfigured } from './hr-db.js';
import { STOCK_ACTIONS } from './stock.js';
import { sessionOf, branchFor } from './hr-session.js';

export { isConfigured };

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

/**
 * คัดลอกรายชื่อพนักงานของสาขาหนึ่งจาก Google Sheet มาเก็บใน hr_employee
 *
 * Google Sheet เป็นตัวหลัก (เพิ่มคน/ให้ลาออก/แก้ค่าแรง ทำที่หน้ารายชื่อพนักงานเหมือนเดิม)
 * ฝั่งเว็บจะเรียก action นี้ให้เองทุกครั้งที่ดึงรายชื่อพนักงานสำเร็จ (ดู MIRROR_TO_SQL)
 * SQL จึงได้รหัสพนักงานชุดเดียวกับที่หน้าเว็บใช้เป๊ะ ไม่ต้องเดาว่ารหัสไหนถูก
 *
 * คนที่หายไปจากรายชื่อ = ลาออกแล้ว จึงตั้ง status เป็น 'ลาออก' ให้ (ไม่ลบ เพราะกะเก่ายังอ้างอิงอยู่)
 * แต่มีกันพลาดไว้: ถ้ารายชื่อที่ส่งมาน้อยกว่าครึ่งของที่มีอยู่ จะไม่ตั้งใครเป็นลาออกเลย
 * เพราะกรณีนั้นน่าจะเป็นชีทตอบมาไม่ครบ ไม่ใช่คนลาออกยกสาขา
 */
async function syncEmployees(body, session) {
  const branch = branchFor(session, body.branch);
  const list = Array.isArray(body.employees) ? body.employees : [];
  if (!branch || list.length === 0) return { upserted: 0, resigned: 0, skipped: 'ไม่มีข้อมูล' };

  const rows = list
    .map((e) => ({
      hrCode: str(e.hrCode),
      name: str(e.name),
      empType: str(e.type || e.empType),
      position: str(e.position),
      dailyWage: num(e.dailyWage),
    }))
    .filter((e) => e.hrCode && e.name);
  if (rows.length === 0) return { upserted: 0, resigned: 0, skipped: 'ไม่มีรหัส/ชื่อที่ใช้ได้' };

  const activeNow = await queryRead(
    `SELECT COUNT(*) AS n FROM dbo.hr_employee WHERE branch = @branch AND status = N'ทำงาน'`,
    { branch: { type: sql.NVarChar(50), value: branch } }
  );
  const before = Number(activeNow[0]?.n || 0);
  // รายชื่อหดลงเกินครึ่ง = น่าจะได้ข้อมูลมาไม่ครบ อย่าไปตั้งใครเป็นลาออก
  const safeToRetire = rows.length * 2 >= before;

  let resigned = 0;
  await withTransaction(async (run) => {
    // ส่งทั้งรายชื่อไปเป็น JSON ก้อนเดียว ให้ SQL Server แตกเองด้วย OPENJSON
    // เดิมวนยิง MERGE ทีละคน + สร้างตารางชั่วคราวแล้ว INSERT ทีละแถว
    // สาขาละ 20 คนกลายเป็น 40+ รอบข้ามประเทศ และ action นี้ทำงานทุกครั้งที่เปิดหน้า
    // จึงไปแย่งคอนเนคชันกับตอนผู้ใช้กดบันทึกตาราง ทำให้ทั้งสองฝั่งช้าและ timeout
    const rowsJson = { type: sql.NVarChar(sql.MAX), value: JSON.stringify(rows) };

    await run(
      `MERGE dbo.hr_employee WITH (HOLDLOCK) AS t
         USING (SELECT * FROM OPENJSON(@rows) WITH (
                  hr_code NVARCHAR(30) '$.hrCode',
                  full_name NVARCHAR(150) '$.name',
                  emp_type NVARCHAR(20) '$.empType',
                  position NVARCHAR(100) '$.position',
                  daily_wage DECIMAL(12,2) '$.dailyWage'
                )) AS s
            ON t.hr_code = s.hr_code
       WHEN MATCHED THEN UPDATE SET
            full_name = s.full_name, branch = @branch, emp_type = s.emp_type,
            position = s.position, daily_wage = s.daily_wage,
            status = N'ทำงาน', resign_date = NULL, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN
            INSERT (hr_code, full_name, branch, emp_type, position, daily_wage, status)
            VALUES (s.hr_code, s.full_name, @branch, s.emp_type, s.position, s.daily_wage, N'ทำงาน');`,
      { rows: rowsJson, branch: { type: sql.NVarChar(50), value: branch } }
    );

    if (safeToRetire) {
      const r = await run(
        `UPDATE dbo.hr_employee
            SET status = N'ลาออก', updated_at = SYSDATETIME()
          WHERE branch = @branch AND status = N'ทำงาน'
            AND hr_code NOT IN (SELECT hr_code FROM OPENJSON(@rows) WITH (hr_code NVARCHAR(30) '$.hrCode'));`,
        { rows: rowsJson, branch: { type: sql.NVarChar(50), value: branch } }
      );
      resigned = r.rowsAffected?.[0] || 0;
    }
  });

  return {
    upserted: rows.length,
    resigned,
    skippedRetire: safeToRetire ? undefined : `รายชื่อที่ส่งมา ${rows.length} คน น้อยกว่าครึ่งของ ${before} คนที่มีอยู่ จึงไม่ตั้งใครเป็นลาออก`,
  };
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

  // แยกเป็นสองกอง: ที่ต้องเขียน กับที่สั่งล้าง
  const upserts = [];
  const clears = [];
  const logRows = [];
  for (const item of logs) {
    const workDate = str(item.workDate);
    const branch = branchFor(session, item.branch);
    const hrCode = str(item.hrCode);
    if (!isDateStr(workDate) || !branch || !hrCode) continue;

    const isClear = str(item.otherNote) === CLEAR_NOTE;
    const base = { workDate, branch, hrCode };
    if (isClear) {
      clears.push(base);
    } else {
      upserts.push({
        ...base,
        name: textOrNull(item.name),
        position: textOrNull(item.position),
        empType: textOrNull(item.empType),
        checkIn: timeOrNull(item.checkIn),
        checkOut: timeOrNull(item.checkOut),
        breakTime: textOrNull(item.breakTime),
        breakRange: textOrNull(item.breakTimeRange),
        ot: num(item.ot),
        otAcc: num(item.otAccumulated),
        useAcc: num(item.useAccumulatedHours),
        hourlyLeave: num(item.hourlyLeave),
        wage: num(item.wage),
        status: str(item.status) || (item.isStop ? 'หยุด' : 'มาทำงาน'),
        leaveNote: textOrNull(item.leaveNote),
        unpaidLeave: textOrNull(item.unpaidLeave),
        otherNote: textOrNull(item.otherNote),
        workStation: textOrNull(item.workStation),
      });
    }
    logRows.push({ ...base, action: isClear ? 'clear' : 'save', payload: JSON.stringify(item) });
  }

  if (upserts.length === 0 && clears.length === 0) {
    throw Object.assign(new Error('ไม่มีข้อมูลที่จะบันทึก'), { badRequest: true });
  }

  await withTransaction(async (run) => {
    // ส่งทุกแถวไปเป็น JSON ก้อนเดียวแล้วให้ SQL Server แตกเองด้วย OPENJSON
    //
    // เดิมวนยิงทีละแถว (MERGE + INSERT log = 2 รอบต่อช่อง) บันทึก 15 ช่องกลายเป็น 30 รอบ
    // แต่ละรอบวิ่งจาก Vercel ข้ามประเทศมาที่เซิร์ฟเวอร์ที่ออฟฟิศ รวมกันแล้วเกินเวลา
    // จนขึ้น "เชื่อมต่อฐานข้อมูล HR ไม่ทันเวลา" ทั้งที่ฐานข้อมูลปกติดี
    // ตอนนี้เหลือ 3 รอบคงที่ ไม่ว่าจะบันทึกกี่ช่อง
    if (upserts.length) {
      await run(
        `MERGE dbo.hr_timesheet WITH (HOLDLOCK) AS t
           USING (SELECT * FROM OPENJSON(@rows) WITH (
                    work_date DATE '$.workDate',
                    branch NVARCHAR(50) '$.branch',
                    hr_code NVARCHAR(30) '$.hrCode',
                    emp_name NVARCHAR(150) '$.name',
                    position NVARCHAR(100) '$.position',
                    emp_type NVARCHAR(20) '$.empType',
                    check_in VARCHAR(5) '$.checkIn',
                    check_out VARCHAR(5) '$.checkOut',
                    break_time NVARCHAR(20) '$.breakTime',
                    break_range VARCHAR(20) '$.breakRange',
                    ot_hours DECIMAL(5,2) '$.ot',
                    ot_accumulated DECIMAL(5,2) '$.otAcc',
                    use_accumulated_hours DECIMAL(5,2) '$.useAcc',
                    hourly_leave DECIMAL(5,2) '$.hourlyLeave',
                    wage DECIMAL(12,2) '$.wage',
                    status NVARCHAR(20) '$.status',
                    leave_note NVARCHAR(100) '$.leaveNote',
                    unpaid_leave NVARCHAR(100) '$.unpaidLeave',
                    other_note NVARCHAR(255) '$.otherNote',
                    work_station NVARCHAR(100) '$.workStation'
                  )) AS s
              ON t.work_date = s.work_date AND t.branch = s.branch AND t.hr_code = s.hr_code
         WHEN MATCHED THEN UPDATE SET
              emp_name = s.emp_name, position = s.position, emp_type = s.emp_type,
              check_in = s.check_in, check_out = s.check_out,
              break_time = s.break_time, break_range = s.break_range,
              ot_hours = s.ot_hours, ot_accumulated = s.ot_accumulated,
              use_accumulated_hours = s.use_accumulated_hours, hourly_leave = s.hourly_leave,
              wage = s.wage, status = s.status,
              leave_note = s.leave_note, unpaid_leave = s.unpaid_leave,
              other_note = s.other_note, work_station = s.work_station,
              updated_at = SYSDATETIME(), updated_by = @actor
         WHEN NOT MATCHED THEN INSERT (
              work_date, branch, hr_code, emp_name, position, emp_type,
              check_in, check_out, break_time, break_range,
              ot_hours, ot_accumulated, use_accumulated_hours, hourly_leave,
              wage, status, leave_note, unpaid_leave, other_note, work_station, updated_by)
         VALUES (
              s.work_date, s.branch, s.hr_code, s.emp_name, s.position, s.emp_type,
              s.check_in, s.check_out, s.break_time, s.break_range,
              s.ot_hours, s.ot_accumulated, s.use_accumulated_hours, s.hourly_leave,
              s.wage, s.status, s.leave_note, s.unpaid_leave, s.other_note, s.work_station, @actor);`,
        {
          rows: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(upserts) },
          actor: { type: sql.NVarChar(100), value: actor },
        }
      );
    }

    if (clears.length) {
      await run(
        `DELETE t
           FROM dbo.hr_timesheet t
           JOIN OPENJSON(@rows) WITH (
                  work_date DATE '$.workDate',
                  branch NVARCHAR(50) '$.branch',
                  hr_code NVARCHAR(30) '$.hrCode'
                ) s
             ON t.work_date = s.work_date AND t.branch = s.branch AND t.hr_code = s.hr_code;`,
        { rows: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(clears) } }
      );
    }

    await run(
      `INSERT INTO dbo.hr_timesheet_log (action, work_date, branch, hr_code, actor, payload)
       SELECT s.action, s.work_date, s.branch, s.hr_code, @actor, s.payload
         FROM OPENJSON(@rows) WITH (
                action VARCHAR(10) '$.action',
                work_date DATE '$.workDate',
                branch NVARCHAR(50) '$.branch',
                hr_code NVARCHAR(30) '$.hrCode',
                payload NVARCHAR(MAX) '$.payload'
              ) s;`,
      {
        rows: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(logRows) },
        actor: { type: sql.NVarChar(100), value: actor },
      }
    );
  });

  return { saved: upserts.length, cleared: clears.length };
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

/**
 * เช็คสุขภาพการเชื่อมต่อ — ไม่แตะข้อมูลเลย ใช้ตอนเจออาการ "บันทึกไม่ได้" แล้วต้องรู้ว่าติดที่ชั้นไหน
 *
 * readMs = เส้นทางอ่าน (มีต่อใหม่แล้วลองซ้ำให้อยู่แล้ว)
 * txMs   = เส้นทางเขียนจริง (poolForWrite + begin/commit) แต่ไม่เขียนอะไร
 * ถ้า readMs ปกติแต่ txMs พัง แปลว่าปัญหาอยู่ที่ transaction/พูล ไม่ใช่เน็ตหรือไฟร์วอลล์
 */
async function ping() {
  const t0 = Date.now();
  const rows = await queryRead('SELECT SYSDATETIME() AS server_time, DB_NAME() AS db_name');
  const readMs = Date.now() - t0;

  const t1 = Date.now();
  await withTransaction(async (run) => {
    await run('SELECT 1 AS ok');
  });
  const txMs = Date.now() - t1;

  return {
    serverTime: rows[0]?.server_time ?? null,
    database: rows[0]?.db_name ?? null,
    readMs,
    txMs,
  };
}

const ACTIONS = {
  ping,
  getBranches,
  getBranchList: getBranches,
  getScheduleEmployees,
  syncEmployees,
  getBranchStats,
  getDailySales,
  getHistoryData,
  saveTimesheet,
  updateOTApprovalBulk,
  updateWorkStation,

  // หน้านับสต๊อก — ตรรกะอยู่ที่ stock.js แต่ใช้ endpoint /schedule เดียวกัน
  // เพราะฝั่ง Vercel มีตัวส่งต่ออยู่แล้วที่ /api/schedule ไม่ต้องเพิ่มไฟล์ใหม่บน Vercel
  ...STOCK_ACTIONS,
};

/**
 * endpoint เดียวรวมทุก action — ผูกกับ app.post('/schedule') ใน server.js
 * ตัวเรียกคือ /api/schedule บน Vercel ซึ่งส่ง body มาทั้งก้อนโดยไม่แก้อะไร
 */
export async function scheduleHandler(req, res) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const action = str(body.action);
  const run = ACTIONS[action];
  if (!run) {
    return res.status(400).json({ status: 'error', message: `ไม่รู้จักคำสั่ง "${action}"` });
  }

  if (!isConfigured()) {
    return res.status(503).json({
      status: 'error',
      message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล HR (HR_DB_USER / HR_DB_PASSWORD ใน .env ของ office-server)',
    });
  }

  // ใช้ user ที่ล็อกอินเข้าระบบมาตั้งแต่แรก ไม่มีการล็อกอินซ้ำที่นี่
  const session = sessionOf(body);
  if (!session) {
    return res.status(401).json({ status: 'error', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }

  try {
    const data = await run(body, session);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    if (error?.badRequest) return res.status(400).json({ status: 'error', message: error.message });
    if (error?.forbidden) return res.status(403).json({ status: 'error', message: error.message });
    console.error(`schedule:${action} error:`, error);
    return res.status(500).json({ status: 'error', message: describeDbError(error) });
  }
}
