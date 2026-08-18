#!/usr/bin/env node
/**
 * ย้ายข้อมูล HR จาก MS SQL Server -> MySQL (ฐานข้อมูล narai_hr ทั้งสองฝั่ง)
 *
 * ใช้ครั้งเดียวตอนเลิกใช้ SQL Server แล้วย้ายมาอยู่เครื่อง MySQL ตัวเดียวกับ myfbdata
 * คัดลอกอย่างเดียว ไม่แตะข้อมูลต้นทางเลย — ต้นทางยังอยู่ครบไว้ย้อนกลับได้ถ้าจำเป็น
 *
 * วิธีใช้ (รันบนเครื่องที่ต่อได้ทั้งสองฝั่ง ปกติคือเครื่องที่ออฟฟิศ)
 *   1) เตรียม driver:
 *        mkdir C:\hr-migrate && cd C:\hr-migrate
 *        npm init -y && npm i mssql mysql2
 *        (วางไฟล์นี้ไว้ในโฟลเดอร์เดียวกัน)
 *   2) ลองแบบไม่เขียนจริงก่อน — นับแถวฝั่งต้นทางอย่างเดียว ไม่ต้องมี MySQL ก็รันได้:
 *        node mssql-to-mysql.mjs --dry-run --src-host localhost --src-user narai_web --src-pass '<รหัสผ่าน>'
 *   3) ย้ายจริง (สร้างฐานข้อมูล/ตารางฝั่ง MySQL ให้เองถ้ายังไม่มี):
 *        node mssql-to-mysql.mjs --src-host localhost --src-user narai_web --src-pass '<รหัสผ่าน>' --dst-pass '<รหัสผ่าน root>'
 *
 * ตัวเลือก
 *   --dry-run             นับแถวฝั่งต้นทางอย่างเดียว ไม่ต่อ MySQL ไม่เขียนอะไร
 *   --src-host / --src-port / --src-db / --src-user / --src-pass
 *                         ต้นทาง SQL Server (ค่าเริ่มต้น localhost:1433/narai_hr)
 *   --src-instance=SQLEXPRESS
 *                         ใช้เมื่อเป็น named instance และไม่ได้ตั้งพอร์ตคงที่ (ต้องมี SQL Browser)
 *   --dst-host / --dst-port / --dst-db / --dst-user / --dst-pass
 *                         ปลายทาง MySQL (ค่าเริ่มต้น localhost:3306/narai_hr user root)
 *   --only=timesheet,log  ย้ายเฉพาะบางตาราง (branch|employee|timesheet|log|sales)
 *   --no-create           ไม่ต้องสร้างฐานข้อมูล/ตารางให้ (ใช้เมื่อรัน schema-hr-mysql.sql เองแล้ว)
 *   --truncate            ล้างตารางปลายทางก่อนเขียน (ใช้เมื่ออยากได้ผลลัพธ์เหมือนต้นทางเป๊ะๆ)
 *   --batch=500           จำนวนแถวต่อหนึ่งคำสั่ง INSERT
 *
 * ข้อควรรู้
 * - รันซ้ำได้ ใช้ INSERT ... ON DUPLICATE KEY UPDATE ทับของเดิม ไม่เกิดแถวซ้ำ
 *   (hr_timesheet_log คัดลอก log_id เดิมมาด้วย รันซ้ำจึงไม่ได้ประวัติซ้ำสองรอบ)
 * - แถวที่ "ถูกลบไปแล้วฝั่งต้นทาง" จะไม่หายไปจากปลายทางเอง ถ้าอยากให้ตรงกันเป๊ะให้ใส่ --truncate
 * - วันที่/เวลาคัดลอกเป็นตัวเลขหน้าปัดตรงๆ ไม่แปลง timezone ให้ (ดู toDate/toDateTime)
 *   เพราะทั้งสองฝั่งเก็บเป็นเวลาท้องถิ่นของออฟฟิศเหมือนกัน แปลงแล้วจะเลื่อนไป 7 ชั่วโมง
 */

import process from 'node:process';

/* ------------------------------ อ่านตัวเลือก ------------------------------ */

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  // รูปแบบ --src-host localhost (เว้นวรรค) ต้องไม่ไปกินแฟล็กตัวถัดไป
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
};

const DRY_RUN = has('dry-run');
const NO_CREATE = has('no-create');
const TRUNCATE = has('truncate');
const BATCH = Math.max(1, Number(val('batch', 500)) || 500);

const SRC = {
  host: val('src-host', process.env.HR_DB_HOST || 'localhost'),
  port: Number(val('src-port', process.env.HR_DB_PORT || 1433)) || 1433,
  database: val('src-db', process.env.HR_DB_NAME || 'narai_hr'),
  user: val('src-user', process.env.HR_DB_USER || ''),
  password: val('src-pass', process.env.HR_DB_PASSWORD || ''),
  instance: val('src-instance', ''),
};

const DST = {
  host: val('dst-host', process.env.MYSQL_HOST || 'localhost'),
  port: Number(val('dst-port', process.env.MYSQL_PORT || 3306)) || 3306,
  database: val('dst-db', 'narai_hr'),
  user: val('dst-user', process.env.MYSQL_USER || 'root'),
  password: val('dst-pass', process.env.MYSQL_PASSWORD || ''),
};

/* --------------------------- ตารางที่ต้องคัดลอก ---------------------------
   ลำดับสำคัญ: สาขา -> พนักงาน -> ตารางงาน เพื่อให้ข้อมูลอ้างอิงมาก่อน
   (ตอนนี้ยังไม่ได้ผูก foreign key ไว้ แต่เรียงให้ถูกไว้ก่อนเผื่อเพิ่มทีหลัง)

   date = คอลัมน์ชนิด DATE, datetime = ชนิดวันที่+เวลา, bit = คอลัมน์ 0/1
   ที่เหลือคัดลอกค่าดิบไปตรงๆ */
const TABLES = [
  {
    key: 'branch',
    name: 'hr_branch',
    columns: ['branch', 'branch_name', 'outlet_id', 'daily_target', 'monthly_target', 'max_wage', 'is_active', 'updated_at'],
    keys: ['branch'],
    bit: ['is_active'],
    datetime: ['updated_at'],
  },
  {
    key: 'employee',
    name: 'hr_employee',
    columns: ['hr_code', 'full_name', 'branch', 'emp_type', 'position', 'daily_wage', 'status', 'resign_date', 'updated_at'],
    keys: ['hr_code'],
    date: ['resign_date'],
    datetime: ['updated_at'],
  },
  {
    key: 'timesheet',
    name: 'hr_timesheet',
    columns: [
      'work_date', 'branch', 'hr_code', 'emp_name', 'position', 'emp_type',
      'check_in', 'check_out', 'break_time', 'break_range',
      'ot_hours', 'ot_accumulated', 'use_accumulated_hours', 'hourly_leave',
      'wage', 'status', 'leave_note', 'unpaid_leave', 'other_note', 'work_station', 'ot_approver',
      'created_at', 'updated_at', 'updated_by',
    ],
    keys: ['work_date', 'branch', 'hr_code'],
    date: ['work_date'],
    datetime: ['created_at', 'updated_at'],
  },
  {
    key: 'log',
    name: 'hr_timesheet_log',
    // คัดลอก log_id เดิมมาด้วย รันซ้ำจะได้ทับแถวเดิมแทนที่จะได้ประวัติซ้ำอีกชุด
    columns: ['log_id', 'logged_at', 'action', 'work_date', 'branch', 'hr_code', 'actor', 'payload'],
    keys: ['log_id'],
    date: ['work_date'],
    datetime: ['logged_at'],
  },
  {
    key: 'sales',
    name: 'hr_daily_sales',
    columns: ['sale_date', 'branch', 'sales', 'updated_at'],
    keys: ['sale_date', 'branch'],
    date: ['sale_date'],
    datetime: ['updated_at'],
  },
];

const only = val('only', '');
const wanted = only
  ? new Set(only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  : null;
const selected = TABLES.filter((t) => !wanted || wanted.has(t.key) || wanted.has(t.name));

/* -------------------------- DDL ฝั่ง MySQL (ย่อ) --------------------------
   ชุดเดียวกับ docs/schema-hr-mysql.sql แค่ตัดคอมเมนต์ออก — แก้ที่ไหนต้องแก้ให้ตรงกัน
   ฝังไว้ในนี้เพราะสคริปต์นี้ถูกก๊อปไปวางเดี่ยวๆ (เช่น C:\hr-migrate) ไม่ได้อยู่คู่กับรีโป */
const DDL = [
  `CREATE TABLE IF NOT EXISTS hr_branch (
     branch VARCHAR(50) NOT NULL,
     branch_name VARCHAR(150) NULL,
     outlet_id INT NULL,
     daily_target DECIMAL(14,2) NOT NULL DEFAULT 0,
     monthly_target DECIMAL(14,2) NOT NULL DEFAULT 0,
     max_wage DECIMAL(14,2) NOT NULL DEFAULT 0,
     is_active TINYINT(1) NOT NULL DEFAULT 1,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (branch)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS hr_employee (
     hr_code VARCHAR(30) NOT NULL,
     full_name VARCHAR(150) NOT NULL,
     branch VARCHAR(50) NOT NULL,
     emp_type VARCHAR(20) NULL,
     position VARCHAR(100) NULL,
     daily_wage DECIMAL(12,2) NOT NULL DEFAULT 0,
     status VARCHAR(20) NOT NULL DEFAULT 'ทำงาน',
     resign_date DATE NULL,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (hr_code),
     KEY IX_hr_employee_branch (branch, status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS hr_timesheet (
     work_date DATE NOT NULL,
     branch VARCHAR(50) NOT NULL,
     hr_code VARCHAR(30) NOT NULL,
     emp_name VARCHAR(150) NULL,
     position VARCHAR(100) NULL,
     emp_type VARCHAR(20) NULL,
     check_in VARCHAR(5) NULL,
     check_out VARCHAR(5) NULL,
     break_time VARCHAR(20) NULL,
     break_range VARCHAR(20) NULL,
     ot_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
     ot_accumulated DECIMAL(5,2) NOT NULL DEFAULT 0,
     use_accumulated_hours DECIMAL(5,2) NOT NULL DEFAULT 0,
     hourly_leave DECIMAL(5,2) NOT NULL DEFAULT 0,
     wage DECIMAL(12,2) NOT NULL DEFAULT 0,
     status VARCHAR(20) NOT NULL DEFAULT 'มาทำงาน',
     leave_note VARCHAR(100) NULL,
     unpaid_leave VARCHAR(100) NULL,
     other_note VARCHAR(255) NULL,
     work_station VARCHAR(100) NULL,
     ot_approver VARCHAR(100) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_by VARCHAR(100) NULL,
     PRIMARY KEY (work_date, branch, hr_code),
     KEY IX_hr_timesheet_branch_date (branch, work_date),
     KEY IX_hr_timesheet_emp_date (hr_code, work_date)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS hr_timesheet_log (
     log_id BIGINT NOT NULL AUTO_INCREMENT,
     logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     action VARCHAR(10) NOT NULL,
     work_date DATE NOT NULL,
     branch VARCHAR(50) NOT NULL,
     hr_code VARCHAR(30) NOT NULL,
     actor VARCHAR(100) NULL,
     payload LONGTEXT NULL,
     PRIMARY KEY (log_id),
     KEY IX_hr_timesheet_log_key (work_date, branch, hr_code)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS hr_daily_sales (
     sale_date DATE NOT NULL,
     branch VARCHAR(50) NOT NULL,
     sales DECIMAL(14,2) NOT NULL DEFAULT 0,
     updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (sale_date, branch)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

/* ---------------------------- แปลงค่าให้ MySQL ----------------------------
   tedious คืนวันที่มาเป็น Date ที่ "หน้าปัดตรงกับที่เก็บไว้ เมื่ออ่านแบบ UTC"
   จึงต้องอ่านด้วย getUTC* แล้วประกอบเป็นข้อความเอง
   ถ้าปล่อยให้ mysql2 แปลง Date ให้ มันจะใช้เวลาท้องถิ่นของเครื่องที่รัน
   ผลคือวันที่เลื่อนไปทั้งตาราง (ไทยเร็วกว่า UTC 7 ชั่วโมง) */
const pad = (n) => String(n).padStart(2, '0');

function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function toDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v.replace('T', ' ').slice(0, 19);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${toDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toRow(spec, r) {
  return spec.columns.map((c) => {
    const v = r[c];
    if (spec.date?.includes(c)) return toDate(v);
    if (spec.datetime?.includes(c)) return toDateTime(v);
    if (spec.bit?.includes(c)) return v === null || v === undefined ? null : (v ? 1 : 0);
    return v === undefined ? null : v;
  });
}

/* ------------------------------- ข้อความ error ------------------------------ */

function explain(err) {
  const code = err?.code || '';
  const msg = err?.message || String(err);
  if (code === 'ELOGIN') return 'SQL Server ไม่รับ user/รหัสผ่านนี้ (หรือยังไม่ได้เปิดโหมด SQL Server Authentication)';
  if (code === 'ER_ACCESS_DENIED_ERROR') return 'MySQL ไม่รับ user/รหัสผ่านนี้ — ใส่ --dst-user / --dst-pass ให้ถูก';
  if (code === 'ER_BAD_DB_ERROR') return `MySQL ยังไม่มีฐานข้อมูล ${DST.database} (อย่าใส่ --no-create หรือรัน docs/schema-hr-mysql.sql ก่อน)`;
  if (code === 'ER_NO_SUCH_TABLE') return 'ยังไม่มีตารางใน MySQL — เอา --no-create ออก หรือรัน docs/schema-hr-mysql.sql ก่อน';
  if (code === 'ECONNREFUSED') return 'ปลายทางไม่รับการเชื่อมต่อ — ตรวจว่าเซอร์วิสเปิดอยู่และพอร์ตถูกต้อง';
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return 'ต่อไม่ติดในเวลาที่กำหนด — ตรวจไฟร์วอลล์และชื่อเครื่อง';
  if (code === 'ENOTFOUND') return 'หาชื่อเครื่องปลายทางไม่เจอ';
  return msg;
}

/* --------------------------------- main --------------------------------- */

async function main() {
  console.log(`ต้นทาง  SQL Server : ${SRC.host}:${SRC.port}/${SRC.database} (user ${SRC.user || '(ไม่ได้ใส่)'})`);
  console.log(`ปลายทาง MySQL      : ${DST.host}:${DST.port}/${DST.database} (user ${DST.user})`);
  console.log('');
  if (DRY_RUN) console.log('โหมด --dry-run: นับอย่างเดียว ไม่เขียนอะไร\n');
  if (wanted) console.log(`ย้ายเฉพาะ: ${selected.map((t) => t.name).join(', ') || '(ไม่ตรงกับตารางไหนเลย)'}\n`);

  if (!SRC.user || !SRC.password) {
    console.error('ต้องใส่ --src-user และ --src-pass (หรือตั้ง HR_DB_USER / HR_DB_PASSWORD)');
    process.exitCode = 1;
    return;
  }
  if (selected.length === 0) {
    console.error('--only ไม่ตรงกับตารางไหนเลย (ใช้ได้: branch, employee, timesheet, log, sales)');
    process.exitCode = 1;
    return;
  }

  const mssql = (await import('mssql')).default;
  const srcConfig = {
    server: SRC.host,
    port: SRC.port,
    database: SRC.database,
    user: SRC.user,
    password: SRC.password,
    connectionTimeout: 15000,
    requestTimeout: 120000, // ตารางใหญ่อ่านทีเดียวจบ ให้เวลามากกว่าฝั่งเว็บ
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  };
  if (SRC.instance) {
    srcConfig.options.instanceName = SRC.instance;
    delete srcConfig.port;
  }

  let src;
  let dst;
  try {
    src = await new mssql.ConnectionPool(srcConfig).connect();
    console.log('ต่อ SQL Server ได้แล้ว');

    if (!DRY_RUN) {
      const mysql = (await import('mysql2/promise')).default;
      // ต่อแบบยังไม่เลือกฐานข้อมูลก่อน เผื่อ narai_hr ยังไม่ถูกสร้าง
      dst = await mysql.createConnection({
        host: DST.host,
        port: DST.port,
        user: DST.user,
        password: DST.password,
        charset: 'utf8mb4',
        multipleStatements: false,
        dateStrings: true,
      });
      console.log('ต่อ MySQL ได้แล้ว');

      if (!NO_CREATE) {
        await dst.query(
          `CREATE DATABASE IF NOT EXISTS \`${DST.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      }
      await dst.query(`USE \`${DST.database}\``);
      if (!NO_CREATE) {
        for (const ddl of DDL) await dst.query(ddl);
        console.log('สร้าง/ตรวจตารางใน MySQL เรียบร้อย');
      }
      console.log('');
    }

    const summary = [];
    for (const spec of selected) {
      const label = spec.name.padEnd(18);

      if (DRY_RUN) {
        const r = await src.request().query(`SELECT COUNT(*) AS n FROM dbo.${spec.name}`);
        const n = Number(r.recordset[0]?.n || 0);
        console.log(`${label} อ่านได้ ${n} แถว (ไม่เขียน)`);
        continue;
      }

      if (TRUNCATE) await dst.query(`DELETE FROM \`${spec.name}\``);

      const cols = spec.columns.map((c) => `[${c}]`).join(', ');
      const r = await src.request().query(`SELECT ${cols} FROM dbo.${spec.name}`);
      const rows = r.recordset || [];
      if (rows.length === 0) {
        console.log(`${label} ไม่มีข้อมูล`);
        summary.push({ name: spec.name, src: 0 });
        continue;
      }

      const colList = spec.columns.map((c) => `\`${c}\``).join(', ');
      // คอลัมน์ที่เป็นคีย์ไม่ต้องอัปเดต (ค่าเท่าเดิมอยู่แล้ว) ที่เหลือทับด้วยค่าจากต้นทาง
      const updates = spec.columns
        .filter((c) => !spec.keys.includes(c))
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(', ');
      const insert =
        `INSERT INTO \`${spec.name}\` (${colList}) VALUES ?` +
        (updates ? ` ON DUPLICATE KEY UPDATE ${updates}` : '');

      let done = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH).map((row) => toRow(spec, row));
        await dst.query(insert, [chunk]);
        done += chunk.length;
        process.stdout.write(`\r${label} เขียนแล้ว ${done}/${rows.length} แถว`);
      }
      process.stdout.write(`\r${label} อ่าน ${rows.length} -> เขียน ${done} แถว          \n`);
      summary.push({ name: spec.name, src: rows.length });
    }

    if (!DRY_RUN && summary.length) {
      // นับฝั่งปลายทางอีกรอบ ไม่ใช่เชื่อจำนวนที่เพิ่งเขียนไป — จะได้เห็นถ้ามีแถวหายหรือมีของเก่าค้าง
      console.log('\nตรวจยอดหลังย้าย (ต้นทาง -> ปลายทาง)');
      for (const s of summary) {
        const [rows] = await dst.query(`SELECT COUNT(*) AS n FROM \`${s.name}\``);
        const n = Number(rows[0]?.n || 0);
        const mark = n === s.src ? 'ตรงกัน' : n > s.src ? 'ปลายทางมีมากกว่า (มีข้อมูลเดิมค้างอยู่?)' : 'ไม่ตรงกัน';
        console.log(`  ${s.name.padEnd(18)} ${s.src} -> ${n}  ${mark}`);
      }
    }

    console.log('\nเสร็จแล้ว');
  } catch (err) {
    console.error(`\nล้มเหลว: ${explain(err)}`);
    if (err?.code) console.error(`(รหัส ${err.code})`);
    process.exitCode = 1;
  } finally {
    try {
      await src?.close();
    } catch {
      // ต่อไม่ติดตั้งแต่แรก ปิดไม่ได้ก็ไม่เป็นไร
    }
    try {
      await dst?.end();
    } catch {
      // เหมือนกัน
    }
  }
}

main();
