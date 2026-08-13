#!/usr/bin/env node
/**
 * ย้ายข้อมูลตารางงานจาก Google Sheets เข้า MS SQL Server (narai_hr)
 *
 * ย้ายให้ 4 อย่าง: สาขา+เป้าขาย, พนักงาน, ยอดขายรายวัน, ตารางงานย้อนหลัง
 *
 * วิธีใช้ (รันจากเครื่องที่ต่อฐานข้อมูลได้):
 *   1) สร้างตารางก่อน:  sqlcmd -S 203.154.185.48 -U <user> -P <pass> -i docs/schema-hr.sql
 *   2) ตั้ง env:        HR_DB_USER, HR_DB_PASSWORD (และ HR_DB_HOST/HR_DB_NAME ถ้าไม่ใช้ค่าเริ่มต้น)
 *   3) ลองแบบไม่เขียนจริงก่อน:
 *        node scripts/migrate-schedule.mjs --months=6 --dry-run
 *   4) ย้ายจริง:
 *        node scripts/migrate-schedule.mjs --months=6
 *
 * ตัวเลือก
 *   --months=6        ย้ายตารางงานย้อนหลังกี่เดือน (ค่าเริ่มต้น 6)
 *   --only=timesheet  ย้ายเฉพาะบางส่วน: branches | employees | sales | timesheet (คั่นด้วย ,)
 *   --dry-run         อ่านชีทและสรุปผลอย่างเดียว ไม่เขียนลงฐานข้อมูล
 *
 * ข้อควรรู้
 * - อ่านชีทผ่าน gviz แบบไม่ต้องล็อกอิน ชีททั้ง 3 ไฟล์จึงต้องตั้งลิงก์เป็น
 *   "ผู้ที่มีลิงก์ • ผู้อ่าน" ก่อน ไม่งั้นจะได้ HTML หน้า login แทนข้อมูล (สคริปต์จะแจ้งให้)
 * - ชีทตารางงานเป็น log ต่อท้าย วันเดียวกันของคนเดียวกันมีได้หลายแถว
 *   สคริปต์จึงหยิบ "แถวล่าสุด" ตาม Timestamp เหมือนที่ Apps Script ทำตอนอ่าน
 *   และแถวที่หมายเหตุเป็น 'ล้างข้อมูล' = ถือว่าถูกลบ ไม่ย้ายเข้า SQL
 * - รันซ้ำได้ ใช้ MERGE ทับของเดิม ไม่เกิดข้อมูลซ้ำ
 */

import process from 'node:process';
import { sql, getPool, withTransaction, describeDbError } from '../lib/mssql.js';

/* ---- ไอดีชีทต้นทาง (ยกมาจาก Apps Script เดิม indexลงตารางงาน.txt) ---- */
const SOURCE_SPREADSHEET_ID = '1CLyJb_6QxWTNV0NOmJklMzrLxmqn6AlWABRvzt4bFng'; // พนักงาน (ชีทแรก)
const DESTINATION_SPREADSHEET_ID = '1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U'; // ลงตารางงาน
const SALES_DATA_SPREADSHEET_ID = '1kxVqX_hp5B0YTNSPj7mhyFl1OLbnhN-dIWm9ywzHA60'; // Details + ยอดขายสาขา
const LOG_SHEET_NAME = 'ลงตารางงาน';

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const MONTHS = Math.max(1, Number(argVal('months', '6')) || 6);
const ONLY = String(argVal('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wants = (part) => ONLY.length === 0 || ONLY.includes(part);

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const cutoff = (() => {
  const d = new Date();
  d.setMonth(d.getMonth() - MONTHS);
  d.setHours(0, 0, 0, 0);
  return d;
})();

/* ------------------------------ อ่านชีท ------------------------------ */

/** ดึงชีทหนึ่งแผ่นผ่าน gviz แล้วคืนเป็น array ของ array (แถว x คอลัมน์) */
async function fetchSheetRows(spreadsheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json${
    sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : ''
  }`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(
      `อ่านชีทไม่ได้ (${spreadsheetId}${sheetName ? ` / ${sheetName}` : ''}) — ` +
        'ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง'
    );
  }
  const json = JSON.parse(text.slice(start, end + 1));
  const cols = json.table.cols || [];
  return (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      if (!cell) return '';
      // gviz ส่งวันที่มาเป็นข้อความ "Date(2026,7,13)" (เดือนเริ่มที่ 0)
      if (typeof cell.v === 'string') {
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)/);
        if (m) return `${m[1]}-${pad(Number(m[2]) + 1)}-${pad(Number(m[3]))}`;
      }
      if (cell.v === null || cell.v === undefined) return '';
      return cell.v;
    })
  );
}

/** ค่าที่อาจเป็น 'YYYY-MM-DD', Date หรือข้อความไทย -> 'YYYY-MM-DD' (คืน null ถ้าอ่านไม่ออก) */
function toDateKey(v) {
  const s = str(v);
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/MM/yyyy
  if (dmy) return `${dmy[3]}-${pad(Number(dmy[2]))}-${pad(Number(dmy[1]))}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : fmtDate(d);
}

/** timestamp ของชีท ('dd/MM/yyyy HH:mm:ss' หรือรูปแบบอื่น) -> เลขไว้เทียบว่าแถวไหนใหม่กว่า */
function toStamp(v) {
  const s = str(v);
  if (!s) return 0;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

const timeText = (v) => {
  const s = str(v);
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
};
const orNull = (v) => (str(v) === '' ? null : str(v));

/* ------------------------------ เขียน SQL ------------------------------ */

async function runBatch(label, rows, buildStatement) {
  if (rows.length === 0) {
    console.log(`  ${label}: ไม่มีข้อมูล`);
    return;
  }
  if (DRY_RUN) {
    console.log(`  ${label}: ${rows.length} แถว (dry-run ไม่ได้เขียนลงฐานข้อมูล)`);
    console.log(`    ตัวอย่าง: ${JSON.stringify(rows[0])}`);
    return;
  }
  // แบ่งเป็นก้อนละ 200 แถว — ก้อนใหญ่เกินไปจะทำให้ transaction ค้างนานและ timeout ง่าย
  const CHUNK = 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withTransaction(async (run) => {
      for (const row of chunk) {
        const { text, params } = buildStatement(row);
        await run(text, params);
      }
    });
    done += chunk.length;
    process.stdout.write(`\r  ${label}: ${done}/${rows.length} แถว`);
  }
  console.log('');
}

/* --------------------------- ส่วนที่ย้ายแต่ละชุด --------------------------- */

// ชีท Details: A=สาขา, B=ยอดขาย, C=เป้าต่อวัน, D=เป้าต่อเดือน, F=ค่าแรงสูงสุด
async function migrateBranches() {
  console.log('\n[1/4] สาขา + เป้าขาย (ชีท Details)');
  const rows = await fetchSheetRows(SALES_DATA_SPREADSHEET_ID, 'Details');
  const seen = new Set();
  const data = [];
  for (const r of rows.slice(1)) {
    const branch = str(r[0]);
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    data.push({
      branch,
      dailyTarget: num(r[2]),
      monthlyTarget: num(r[3]),
      maxWage: num(r[5]),
    });
  }
  await runBatch('สาขา', data, (row) => ({
    text: `MERGE dbo.hr_branch WITH (HOLDLOCK) AS t
             USING (SELECT @branch AS branch) AS s ON t.branch = s.branch
           WHEN MATCHED THEN UPDATE SET
             daily_target = @dailyTarget, monthly_target = @monthlyTarget,
             max_wage = @maxWage, updated_at = SYSDATETIME()
           WHEN NOT MATCHED THEN
             INSERT (branch, branch_name, daily_target, monthly_target, max_wage)
             VALUES (@branch, @branch, @dailyTarget, @monthlyTarget, @maxWage);`,
    params: {
      branch: { type: sql.NVarChar(50), value: row.branch },
      dailyTarget: { type: sql.Decimal(14, 2), value: row.dailyTarget },
      monthlyTarget: { type: sql.Decimal(14, 2), value: row.monthlyTarget },
      maxWage: { type: sql.Decimal(14, 2), value: row.maxWage },
    },
  }));
}

// ชีทพนักงาน (แผ่นแรก): C=รหัส HR, D=ชื่อ, E=สาขา, F=ประเภท, G=สถานะ, I=ตำแหน่ง, J=ค่าแรง/วัน, O=วันที่ลาออก
async function migrateEmployees() {
  console.log('\n[2/4] พนักงาน');
  const rows = await fetchSheetRows(SOURCE_SPREADSHEET_ID, '');
  const byCode = new Map();
  for (const r of rows.slice(1)) {
    const hrCode = str(r[2]);
    const name = str(r[3]);
    if (!hrCode || !name) continue;
    byCode.set(hrCode, {
      hrCode,
      name,
      branch: str(r[4]),
      empType: str(r[5]),
      status: str(r[6]) || 'ทำงาน',
      position: str(r[8]),
      dailyWage: num(r[9]),
      resignDate: toDateKey(r[14]),
    });
  }
  const data = [...byCode.values()];
  await runBatch('พนักงาน', data, (row) => ({
    text: `MERGE dbo.hr_employee WITH (HOLDLOCK) AS t
             USING (SELECT @hrCode AS hr_code) AS s ON t.hr_code = s.hr_code
           WHEN MATCHED THEN UPDATE SET
             full_name = @name, branch = @branch, emp_type = @empType, position = @position,
             daily_wage = @dailyWage, status = @status, resign_date = @resignDate,
             updated_at = SYSDATETIME()
           WHEN NOT MATCHED THEN
             INSERT (hr_code, full_name, branch, emp_type, position, daily_wage, status, resign_date)
             VALUES (@hrCode, @name, @branch, @empType, @position, @dailyWage, @status, @resignDate);`,
    params: {
      hrCode: { type: sql.NVarChar(30), value: row.hrCode },
      name: { type: sql.NVarChar(150), value: row.name },
      branch: { type: sql.NVarChar(50), value: row.branch },
      empType: { type: sql.NVarChar(20), value: orNull(row.empType) },
      position: { type: sql.NVarChar(100), value: orNull(row.position) },
      dailyWage: { type: sql.Decimal(12, 2), value: row.dailyWage },
      status: { type: sql.NVarChar(20), value: row.status },
      resignDate: { type: sql.Date, value: row.resignDate },
    },
  }));

  // สาขาที่มีพนักงานแต่ยังไม่มีในตารางสาขา (ชีท Details ไม่ครบ) — เติมให้ ไม่งั้นดรอปดาวน์สาขาจะขาด
  const branches = [...new Set(data.map((d) => d.branch).filter(Boolean))];
  await runBatch('สาขาที่พบจากพนักงาน', branches.map((b) => ({ branch: b })), (row) => ({
    text: `IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch WHERE branch = @branch)
             INSERT INTO dbo.hr_branch (branch, branch_name) VALUES (@branch, @branch);`,
    params: { branch: { type: sql.NVarChar(50), value: row.branch } },
  }));
}

// ชีท "ยอดขายสาขา": A=วันที่, C=สาขา, D=ยอดขาย
async function migrateDailySales() {
  console.log('\n[3/4] ยอดขายรายวัน');
  const rows = await fetchSheetRows(SALES_DATA_SPREADSHEET_ID, 'ยอดขายสาขา');
  const byKey = new Map();
  for (const r of rows.slice(1)) {
    const date = toDateKey(r[0]);
    const branch = str(r[2]);
    if (!date || !branch) continue;
    if (new Date(date) < cutoff) continue;
    byKey.set(`${date}_${branch}`, { date, branch, sales: num(r[3]) });
  }
  const data = [...byKey.values()];
  await runBatch(`ยอดขาย (ย้อนหลัง ${MONTHS} เดือน)`, data, (row) => ({
    text: `MERGE dbo.hr_daily_sales WITH (HOLDLOCK) AS t
             USING (SELECT @d AS sale_date, @branch AS branch) AS s
                ON t.sale_date = s.sale_date AND t.branch = s.branch
           WHEN MATCHED THEN UPDATE SET sales = @sales, updated_at = SYSDATETIME()
           WHEN NOT MATCHED THEN INSERT (sale_date, branch, sales) VALUES (@d, @branch, @sales);`,
    params: {
      d: { type: sql.Date, value: row.date },
      branch: { type: sql.NVarChar(50), value: row.branch },
      sales: { type: sql.Decimal(14, 2), value: row.sales },
    },
  }));
}

// ชีท "ลงตารางงาน" — คอลัมน์ A..V ตามที่ Apps Script เดิมเขียนไว้
//  A Timestamp | B วันที่ลงงาน | C สาขา | D รหัส HR | E ชื่อ | F ตำแหน่ง | G เข้า | H ออก
//  I เบรค | J OT | K ค่าแรง | L สถานะ | M ลา(รับค่าแรง) | N ประเภท | O หยุด(ไม่รับค่าแรง)
//  P ชั่วโมงสะสม | Q ลารายชั่วโมง | R หมายเหตุ | S ช่วงเบรค | T จุดปฏิบัติงาน | U ผู้อนุมัติ OT | V ใช้ชั่วโมงสะสม
async function migrateTimesheet() {
  console.log(`\n[4/4] ตารางงาน (ย้อนหลัง ${MONTHS} เดือน ตั้งแต่ ${fmtDate(cutoff)})`);
  const rows = await fetchSheetRows(DESTINATION_SPREADSHEET_ID, LOG_SHEET_NAME);

  // ชีทเป็น log ต่อท้าย — เก็บเฉพาะแถวล่าสุดของแต่ละ (วันที่, สาขา, รหัส) เหมือนที่ Apps Script อ่าน
  const latest = new Map();
  let skippedOld = 0;
  let cleared = 0;

  for (const r of rows.slice(1)) {
    const workDate = toDateKey(r[1]);
    const branch = str(r[2]);
    const hrCode = str(r[3]) || str(r[4]); // แถวเก่าบางแถวไม่มีรหัส ใช้ชื่อแทนเหมือนของเดิม
    if (!workDate || !branch || !hrCode) continue;
    if (new Date(workDate) < cutoff) {
      skippedOld++;
      continue;
    }
    const key = `${workDate}_${branch}_${hrCode}`;
    const stamp = toStamp(r[0]);
    const prev = latest.get(key);
    if (prev && prev.stamp > stamp) continue;
    latest.set(key, { stamp, row: r, workDate, branch, hrCode });
  }

  const data = [];
  for (const { row: r, workDate, branch, hrCode } of latest.values()) {
    if (str(r[17]) === 'ล้างข้อมูล') {
      cleared++; // ถูกสั่งล้างไปแล้ว ไม่ต้องย้ายเข้า SQL
      continue;
    }
    data.push({
      workDate,
      branch,
      hrCode,
      name: str(r[4]),
      position: str(r[5]),
      empType: str(r[13]),
      checkIn: timeText(r[6]),
      checkOut: timeText(r[7]),
      breakTime: orNull(r[8]),
      breakRange: orNull(r[18]),
      ot: num(r[9]),
      otAcc: num(r[15]),
      hourlyLeave: num(r[16]),
      useAcc: num(r[21]),
      wage: num(r[10]),
      status: str(r[11]) || 'มาทำงาน',
      leaveNote: orNull(r[12]),
      unpaidLeave: orNull(r[14]),
      otherNote: orNull(r[17]),
      workStation: orNull(r[19]),
      otApprover: orNull(r[20]),
    });
  }

  console.log(`  อ่านจากชีท ${rows.length - 1} แถว | เก่ากว่ากำหนด ${skippedOld} | ถูกล้างไปแล้ว ${cleared}`);
  await runBatch('ตารางงาน', data, (row) => ({
    text: `MERGE dbo.hr_timesheet WITH (HOLDLOCK) AS t
             USING (SELECT @d AS work_date, @branch AS branch, @hrCode AS hr_code) AS s
                ON t.work_date = s.work_date AND t.branch = s.branch AND t.hr_code = s.hr_code
           WHEN MATCHED THEN UPDATE SET
             emp_name = @name, position = @position, emp_type = @empType,
             check_in = @checkIn, check_out = @checkOut,
             break_time = @breakTime, break_range = @breakRange,
             ot_hours = @ot, ot_accumulated = @otAcc,
             use_accumulated_hours = @useAcc, hourly_leave = @hourlyLeave,
             wage = @wage, status = @status, leave_note = @leaveNote,
             unpaid_leave = @unpaidLeave, other_note = @otherNote,
             work_station = @workStation, ot_approver = @otApprover,
             updated_at = SYSDATETIME(), updated_by = N'migration'
           WHEN NOT MATCHED THEN INSERT (
             work_date, branch, hr_code, emp_name, position, emp_type,
             check_in, check_out, break_time, break_range,
             ot_hours, ot_accumulated, use_accumulated_hours, hourly_leave,
             wage, status, leave_note, unpaid_leave, other_note,
             work_station, ot_approver, updated_by)
           VALUES (
             @d, @branch, @hrCode, @name, @position, @empType,
             @checkIn, @checkOut, @breakTime, @breakRange,
             @ot, @otAcc, @useAcc, @hourlyLeave,
             @wage, @status, @leaveNote, @unpaidLeave, @otherNote,
             @workStation, @otApprover, N'migration');`,
    params: {
      d: { type: sql.Date, value: row.workDate },
      branch: { type: sql.NVarChar(50), value: row.branch },
      hrCode: { type: sql.NVarChar(30), value: row.hrCode },
      name: { type: sql.NVarChar(150), value: orNull(row.name) },
      position: { type: sql.NVarChar(100), value: orNull(row.position) },
      empType: { type: sql.NVarChar(20), value: orNull(row.empType) },
      checkIn: { type: sql.VarChar(5), value: row.checkIn },
      checkOut: { type: sql.VarChar(5), value: row.checkOut },
      breakTime: { type: sql.NVarChar(20), value: row.breakTime },
      breakRange: { type: sql.VarChar(20), value: row.breakRange },
      ot: { type: sql.Decimal(5, 2), value: row.ot },
      otAcc: { type: sql.Decimal(5, 2), value: row.otAcc },
      useAcc: { type: sql.Decimal(5, 2), value: row.useAcc },
      hourlyLeave: { type: sql.Decimal(5, 2), value: row.hourlyLeave },
      wage: { type: sql.Decimal(12, 2), value: row.wage },
      status: { type: sql.NVarChar(20), value: row.status },
      leaveNote: { type: sql.NVarChar(100), value: row.leaveNote },
      unpaidLeave: { type: sql.NVarChar(100), value: row.unpaidLeave },
      otherNote: { type: sql.NVarChar(255), value: row.otherNote },
      workStation: { type: sql.NVarChar(100), value: row.workStation },
      otApprover: { type: sql.NVarChar(100), value: row.otApprover },
    },
  }));
}

/* --------------------------------- main --------------------------------- */

async function main() {
  console.log(`ย้ายข้อมูลตารางงาน -> ${process.env.HR_DB_HOST || '203.154.185.48'}/${process.env.HR_DB_NAME || 'narai_hr'}`);
  if (DRY_RUN) console.log('โหมด dry-run: อ่านชีทและสรุปผลเท่านั้น ไม่เขียนลงฐานข้อมูล');
  if (!DRY_RUN && (!process.env.HR_DB_USER || !process.env.HR_DB_PASSWORD)) {
    console.error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD');
    process.exit(1);
  }
  if (!DRY_RUN) await getPool(); // ต่อฐานข้อมูลให้พังตั้งแต่ต้นถ้าต่อไม่ได้ จะได้ไม่เสียเวลาอ่านชีท

  // เรียงตามลำดับนี้เสมอ: สาขาต้องมาก่อนพนักงาน และพนักงานมาก่อนตารางงาน
  if (wants('branches')) await migrateBranches();
  if (wants('employees')) await migrateEmployees();
  if (wants('sales')) await migrateDailySales();
  if (wants('timesheet')) await migrateTimesheet();

  console.log('\nเสร็จเรียบร้อย');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nย้ายข้อมูลไม่สำเร็จ:', describeDbError(err));
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
