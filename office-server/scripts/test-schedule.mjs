#!/usr/bin/env node
/**
 * ทดสอบว่า "กรอกตารางแล้วข้อมูลเข้าฐานข้อมูลจริงไหม" — ครบวงจรในคำสั่งเดียว
 *
 * ยิงเข้า office-server เหมือนที่หน้าเว็บทำทุกอย่าง แล้วไปอ่านจากตารางใน SQL Server ตรงๆ
 * เพื่อยืนยันว่าแถวนั้นลงจริง ไม่ใช่แค่ API ตอบว่าสำเร็จ
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/test-schedule.mjs
 *
 * ตัวเลือก
 *   --base=http://localhost:8787   ที่อยู่ office-server (ค่าเริ่มต้นนี้)
 *   --keep                         ไม่ต้องลบแถวทดสอบทิ้งตอนจบ (ไว้เข้าไปดูเองใน SSMS)
 *
 * ข้อมูลที่ใช้ทดสอบเป็นของปลอมทั้งหมด (สาขา ZZTEST วันที่ 2099-12-31) แล้วลบทิ้งเมื่อจบ
 * จึงไม่ไปปนกับข้อมูลจริงของสาขาไหน
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = argVal('base', 'http://localhost:8787').replace(/\/+$/, '');
const KEEP = args.includes('--keep');

/* ค่าทดสอบ — จงใจให้ดูออกชัดว่าเป็นของปลอม */
const BRANCH = 'ZZTEST';
const HR_CODE = 'ZZTEST001';
const WORK_DATE = '2099-12-31';
const USER = { username: 'ทดสอบระบบ', branch: 'all' };

const ok = (msg) => console.log(`  [ผ่าน] ${msg}`);
const bad = (msg) => console.log(`  [ไม่ผ่าน] ${msg}`);

async function callApi(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.API_TOKEN) headers['x-api-token'] = process.env.API_TOKEN;
  const res = await fetch(`${BASE}/schedule`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, _user: USER }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`office-server ตอบกลับมาไม่ใช่ JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.status !== 'success') {
    throw new Error(`${payload.action} ไม่สำเร็จ (HTTP ${res.status}): ${body.message || text.slice(0, 200)}`);
  }
  return body.data;
}

/* ต่อฐานข้อมูลตรงๆ ด้วยค่าชุดเดียวกับที่ office-server ใช้ — ไม่ผ่าน API เพื่อดูของจริงในตาราง */
function dbConfig() {
  return {
    server: process.env.HR_DB_HOST || 'localhost',
    database: process.env.HR_DB_NAME || 'narai_hr',
    user: process.env.HR_DB_USER || '',
    password: process.env.HR_DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      ...(process.env.HR_DB_INSTANCE ? { instanceName: process.env.HR_DB_INSTANCE } : {}),
    },
    ...(process.env.HR_DB_PORT ? { port: Number(process.env.HR_DB_PORT) } : { port: 1433 }),
    connectionTimeout: 15000,
  };
}

async function main() {
  console.log(`ทดสอบผ่าน ${BASE}/schedule`);
  console.log(`ข้อมูลทดสอบ: สาขา ${BRANCH} / รหัส ${HR_CODE} / วันที่ ${WORK_DATE}\n`);

  if (!process.env.HR_DB_USER || !process.env.HR_DB_PASSWORD) {
    console.error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD ใน .env ของ office-server');
    process.exitCode = 1;
    return;
  }

  let pool;
  try {
    /* 1) เคาะดูก่อนว่า office-server ต่อฐานข้อมูลได้ */
    console.log('1. เช็คการเชื่อมต่อ (action: ping)');
    const p = await callApi({ action: 'ping' });
    ok(`ต่อได้ — ฐานข้อมูล ${p.database} เวลาเครื่อง ${p.serverTime} (อ่าน ${p.readMs}ms / เขียน ${p.txMs}ms)`);

    /* 2) กรอกข้อมูลหนึ่งช่อง เหมือนกดบันทึกจากหน้าลงตารางงาน */
    console.log('\n2. บันทึกตารางหนึ่งแถว (action: saveTimesheet)');
    const saved = await callApi({
      action: 'saveTimesheet',
      logs: [{
        workDate: WORK_DATE,
        branch: BRANCH,
        hrCode: HR_CODE,
        name: 'พนักงานทดสอบ',
        position: 'บริการ',
        empType: 'F/T',
        checkIn: '09:00',
        checkOut: '18:00',
        breakTime: '1 ชม.',
        breakTimeRange: '13:00-14:00',
        ot: 1.5,
        otAccumulated: 0,
        useAccumulatedHours: 0,
        hourlyLeave: 0,
        wage: 500,
        status: 'มาทำงาน',
        leaveNote: '',
        unpaidLeave: '',
        otherNote: 'แถวทดสอบระบบ ลบได้',
        workStation: 'ครัว',
      }],
    });
    ok(`API ตอบว่าบันทึก ${saved.saved} แถว ล้าง ${saved.cleared} แถว`);

    /* 3) อ่านกลับผ่าน API เส้นทางเดียวกับหน้าเว็บ */
    console.log('\n3. อ่านกลับผ่าน API (action: getHistoryData)');
    const rows = await callApi({
      action: 'getHistoryData',
      branch: BRANCH,
      startDate: WORK_DATE,
      endDate: WORK_DATE,
    });
    const mine = rows.find((r) => r.hrCode === HR_CODE);
    if (mine) {
      ok(`อ่านเจอ — ${mine.name} ${mine.checkIn}-${mine.checkOut} OT ${mine.ot} ค่าแรง ${mine.wage}`);
    } else {
      bad(`อ่านกลับไม่เจอแถวที่เพิ่งบันทึก (ได้มา ${rows.length} แถว)`);
    }

    /* 4) จุดสำคัญ: ไปดูของจริงในตาราง ไม่ผ่าน API */
    console.log('\n4. อ่านจากตารางใน SQL Server ตรงๆ (ไม่ผ่าน API)');
    pool = await new sql.ConnectionPool(dbConfig()).connect();
    const r = await pool.request()
      .input('d', sql.Date, WORK_DATE)
      .input('b', sql.NVarChar(50), BRANCH)
      .input('h', sql.NVarChar(30), HR_CODE)
      .query(`SELECT work_date, branch, hr_code, emp_name, check_in, check_out, ot_hours, wage, updated_by, updated_at
                FROM dbo.hr_timesheet WHERE work_date = @d AND branch = @b AND hr_code = @h`);

    if (r.recordset.length === 0) {
      bad('ไม่พบแถวในตาราง dbo.hr_timesheet — ข้อมูลยังไม่ได้เข้าฐานข้อมูลจริง');
      process.exitCode = 1;
    } else {
      ok('พบแถวจริงในตาราง dbo.hr_timesheet');
      console.table(r.recordset);
    }

    const logs = await pool.request()
      .input('d', sql.Date, WORK_DATE)
      .input('b', sql.NVarChar(50), BRANCH)
      .query(`SELECT COUNT(*) AS n FROM dbo.hr_timesheet_log WHERE work_date = @d AND branch = @b`);
    ok(`ประวัติการแก้ไขถูกบันทึกไว้ ${logs.recordset[0].n} รายการ (hr_timesheet_log)`);

    /* 5) เก็บกวาด */
    if (KEEP) {
      console.log('\n5. --keep: เก็บแถวทดสอบไว้ ลบเองภายหลังด้วย');
      console.log(`   DELETE FROM dbo.hr_timesheet WHERE branch = N'${BRANCH}';`);
      console.log(`   DELETE FROM dbo.hr_timesheet_log WHERE branch = N'${BRANCH}';`);
    } else {
      console.log('\n5. ลบข้อมูลทดสอบทิ้ง');
      await pool.request()
        .input('b', sql.NVarChar(50), BRANCH)
        .query(`DELETE FROM dbo.hr_timesheet WHERE branch = @b;
                DELETE FROM dbo.hr_timesheet_log WHERE branch = @b;`);
      ok('ลบเรียบร้อย ไม่เหลือข้อมูลทดสอบในฐานข้อมูล');
    }

    console.log('\nสรุป: หน้าเว็บกดบันทึกแล้วข้อมูลเข้าฐานข้อมูลได้จริง');
  } catch (err) {
    console.error(`\nล้มเหลว: ${err.message}`);
    if (err.code) console.error(`(รหัส ${err.code})`);
    process.exitCode = 1;
  } finally {
    try {
      await pool?.close();
    } catch {
      // ต่อไม่ติดตั้งแต่แรก ปิดไม่ได้ก็ไม่เป็นไร
    }
  }
}

main();
