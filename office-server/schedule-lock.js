// ล็อกตารางงานรายสาขา — "ล็อกถึงวันที่ X" = สาขาแก้ตารางงานของวันที่ไม่เกิน X ไม่ได้
//
// คนตั้งล็อกคือออฟฟิศ (หน้า "ดูสแกนหน้า" ของโปรเจค naraipizzeria) ผ่าน setScheduleLock
// ปกติใช้ปิดงวดเงินเดือน (21–20) แล้วไม่ให้สาขาย้อนไปแก้ตารางที่เอาไปคิดค่าแรงแล้ว
//
// กติกา:
//   - ล็อกเป็นรายสาขา หนึ่งแถวต่อหนึ่งสาขา (ตั้งใหม่ = เขียนทับ, ปลดล็อก = ลบแถว)
//     ทุกครั้งที่ตั้ง/ปลดเก็บประวัติลง hr_schedule_lock_log ไว้ดูย้อนหลังว่าใครทำเมื่อไหร่
//   - รหัสพี่น้อง (zjp/sjp) ถือเป็นร้านเดียวกัน — ล็อก SJP แล้วสาขาที่ล็อกอินด้วย zjp ก็โดนด้วย
//     ถ้าทั้งคู่มีล็อกคนละวัน ใช้วันที่ไกลกว่า
//   - user สิทธิ์ all (แอดมิน และตัวออฟฟิศเอง) แก้ข้ามล็อกได้เสมอ — ล็อกมีไว้กันฝั่งสาขา
//   - ตรวจที่นี่ ไม่ใช่แค่ซ่อนปุ่มในหน้าเว็บ เพราะร่างที่ค้างในเครื่องสาขาส่งขึ้นมาเองได้ทุกเมื่อ
//
// ตารางถูกสร้างให้เองตอนตั้งล็อกครั้งแรก (ensureLockTables) ไม่ต้องรัน SQL เอง
// ถ้า login ของ service ไม่มีสิทธิ์สร้างตาราง ให้รัน docs/hr-schedule-lock.sql ครั้งเดียว
// ก่อนสร้างตาราง = ยังไม่มีสาขาไหนถูกล็อก ทุกอย่างทำงานเหมือนเดิม

import { timingSafeEqual } from 'node:crypto';
import sql from 'mssql';
import { queryRead, withTransaction } from './hr-db.js';
import { branchGroup, branchCodes } from './hr-session.js';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const pad2 = (n) => String(n).padStart(2, '0');

/** DATE จาก mssql (Date เที่ยงคืน UTC) -> 'YYYY-MM-DD' */
function ymd(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

/** DATETIME2 -> 'YYYY-MM-DD HH:mm' (mssql คืนเวลาเครื่องเป็น UTC ตรงตัว จึงอ่านส่วน UTC) */
function stamp(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${ymd(value)} ${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`;
  }
  return String(value).replace('T', ' ').slice(0, 16);
}

/** '2026-10-20' -> '20/10/2026' ไว้ใส่ในข้อความที่สาขาอ่าน */
const thaiDate = (d) => {
  const [y, m, day] = String(d || '').split('-');
  return y && m && day ? `${Number(day)}/${Number(m)}/${y}` : String(d || '');
};

const LOCK_DDL = `
IF OBJECT_ID(N'dbo.hr_schedule_lock', N'U') IS NULL
CREATE TABLE dbo.hr_schedule_lock (
    branch        NVARCHAR(50)  NOT NULL,   -- รหัสสาขา ตัวพิมพ์เล็ก
    locked_until  DATE          NOT NULL,   -- แก้ไม่ได้ตั้งแต่อดีตจนถึงวันนี้ (รวมวันนี้)
    note          NVARCHAR(255) NULL,
    locked_by     NVARCHAR(100) NULL,
    locked_at     DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_schedule_lock_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_schedule_lock PRIMARY KEY (branch)
);
IF OBJECT_ID(N'dbo.hr_schedule_lock_log', N'U') IS NULL
CREATE TABLE dbo.hr_schedule_lock_log (
    log_id        BIGINT        IDENTITY(1,1) NOT NULL,
    logged_at     DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_schedule_lock_log_at DEFAULT (SYSDATETIME()),
    branch        NVARCHAR(50)  NOT NULL,
    locked_until  DATE          NULL,       -- NULL = ปลดล็อก
    actor         NVARCHAR(100) NULL,
    note          NVARCHAR(255) NULL,
    CONSTRAINT PK_hr_schedule_lock_log PRIMARY KEY (log_id)
);`;

/* มีตารางล็อกแล้วหรือยัง — จำไว้เมื่อเจอแล้ว (ตารางไม่หายเอง) ยังไม่เจอให้ถามใหม่ทุกนาที
   เพราะออฟฟิศอาจเพิ่งตั้งล็อกครั้งแรก (ซึ่งสร้างตารางให้) จากอีกเครื่องหนึ่ง */
let tableSeen = false;
let tableCheckedAt = 0;

async function lockTableExists() {
  if (tableSeen) return true;
  if (Date.now() - tableCheckedAt < 60 * 1000) return false;
  const rows = await queryRead(`SELECT OBJECT_ID(N'dbo.hr_schedule_lock', N'U') AS id`);
  tableCheckedAt = Date.now();
  tableSeen = rows[0]?.id != null;
  return tableSeen;
}

async function ensureLockTables() {
  if (tableSeen) return;
  try {
    await withTransaction((run) => run(LOCK_DDL));
  } catch (err) {
    throw Object.assign(new Error(
      `สร้างตารางล็อกตารางงานไม่สำเร็จ (${err?.message || err}) — ` +
      'ให้รัน docs/hr-schedule-lock.sql ใน SSMS (ด้วย sa) ที่เครื่องออฟฟิศครั้งเดียว'
    ), { cause: err });
  }
  tableSeen = true;
}

/** รหัสสาขาทั้งหมดที่ต้องดู (รวมรหัสพี่น้อง) -> พารามิเตอร์ของ IN (...) */
function inClause(codes, prefix = 'lk') {
  const list = [...new Set(codes.flatMap((c) => branchGroup(c)))];
  const params = {};
  list.forEach((b, i) => { params[`${prefix}${i}`] = { type: sql.NVarChar(50), value: b }; });
  return { list, clause: list.map((_, i) => `@${prefix}${i}`).join(', '), params };
}

const toLockRow = (r) => ({
  branch: str(r.branch).toLowerCase(),
  lockedUntil: ymd(r.locked_until),
  note: str(r.note),
  lockedBy: str(r.locked_by),
  lockedAt: stamp(r.locked_at),
});

/** ล็อกที่ใช้กับสาขานี้จริง = วันที่ไกลสุดในกลุ่มรหัสพี่น้อง ('' = ไม่ได้ล็อก) */
function effectiveLock(rows, branch) {
  const group = branchGroup(branch);
  let best = null;
  for (const r of rows) {
    if (!group.includes(r.branch)) continue;
    if (!best || r.lockedUntil > best.lockedUntil) best = r;
  }
  return best;
}

/**
 * กันการเขียนวันที่ถูกล็อก — เรียกใน transaction เดียวกับคำสั่งเขียน
 * (HOLDLOCK กันจังหวะที่ออฟฟิศกดล็อกพร้อมกับที่สาขากดบันทึก: ใครได้ก่อนคนนั้นชนะ ไม่มีหลุดกลาง)
 *
 * @param run      ตัวยิง query ของ transaction ที่กำลังเขียน
 * @param session  user ที่ล็อกอิน — สิทธิ์ all ข้ามล็อกได้เสมอ
 * @param items    [{ branch, workDate }] ทุกแถวที่จะเขียน
 * โยน error { locked: true } ถ้ามีแถวไหนอยู่ในช่วงที่ล็อก (ทั้งชุดไม่ถูกเขียน)
 */
export async function assertNotLocked(run, session, items) {
  if (session?.isAll) return;
  const rows = (items || []).filter((it) => str(it.branch) && isDateStr(it.workDate));
  if (rows.length === 0) return;
  if (!(await lockTableExists())) return;

  const scope = inClause(rows.map((r) => str(r.branch)));
  const res = await run(
    `SELECT branch, locked_until, note, locked_by, locked_at
       FROM dbo.hr_schedule_lock WITH (HOLDLOCK)
      WHERE branch IN (${scope.clause})`,
    scope.params
  );
  const locks = (res.recordset || []).map(toLockRow);
  if (locks.length === 0) return;

  // รวมตามสาขา: สาขาไหนโดนล็อกวันไหนบ้าง
  const hit = new Map();
  for (const r of rows) {
    const lock = effectiveLock(locks, r.branch);
    if (!lock || r.workDate > lock.lockedUntil) continue;
    const key = str(r.branch).toLowerCase();
    const h = hit.get(key) || { branch: key, lockedUntil: lock.lockedUntil, dates: new Set() };
    h.dates.add(r.workDate);
    hit.set(key, h);
  }
  if (hit.size === 0) return;

  const details = [...hit.values()].map((h) => ({
    branch: h.branch,
    lockedUntil: h.lockedUntil,
    dates: [...h.dates].sort(),
  }));
  const first = details[0];
  const shown = first.dates.slice(0, 7).map(thaiDate).join(', ');
  const more = first.dates.length > 7 ? ` และอีก ${first.dates.length - 7} วัน` : '';
  throw Object.assign(
    new Error(
      `ตารางงานสาขา ${first.branch.toUpperCase()} ถูกออฟฟิศล็อกถึงวันที่ ${thaiDate(first.lockedUntil)} แล้ว — ` +
      `แก้วันที่ ${shown}${more} ไม่ได้ (ติดต่อออฟฟิศหากต้องแก้)`
    ),
    { locked: true, lockDetails: details }
  );
}

/* ------------------------------- actions ------------------------------- */

/**
 * ล็อกของสาขา — { branches?: ['crm', ...] }
 * user สาขาเห็นได้เฉพาะสาขาตัวเอง (รวมรหัสพี่น้อง) · สิทธิ์ all ไม่ระบุสาขา = ทุกสาขาที่มีล็อก
 * คืน [{ branch, lockedUntil, note, lockedBy, lockedAt }]
 */
async function getScheduleLocks(body, session) {
  if (!(await lockTableExists())) return [];

  let wanted = Array.isArray(body.branches) ? body.branches.flatMap(branchCodes) : branchCodes(body.branch);
  if (!session?.isAll) wanted = branchCodes(session?.branch);
  if (!session?.isAll && wanted.length === 0) return [];

  if (wanted.length === 0) {
    const rows = await queryRead(
      `SELECT branch, locked_until, note, locked_by, locked_at FROM dbo.hr_schedule_lock ORDER BY branch`
    );
    return rows.map(toLockRow);
  }
  const scope = inClause(wanted);
  const rows = await queryRead(
    `SELECT branch, locked_until, note, locked_by, locked_at
       FROM dbo.hr_schedule_lock WHERE branch IN (${scope.clause}) ORDER BY branch`,
    scope.params
  );
  return rows.map(toLockRow);
}

/** เทียบกุญแจแบบเวลาคงที่ — กันเดากุญแจทีละตัวอักษรจากเวลาที่ตอบ */
function keyMatches(given, need) {
  const a = Buffer.from(str(given));
  const b = Buffer.from(need);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ตั้ง/ปลดล็อกหลายสาขาพร้อมกัน — { branches: ['crm','sum'], lockedUntil: 'YYYY-MM-DD' | '', note? }
 * lockedUntil ว่าง = ปลดล็อกสาขาเหล่านั้น
 *
 * ใช้ได้เฉพาะ user สิทธิ์ all และถ้าตั้ง SCHEDULE_LOCK_KEY ไว้ใน .env ต้องส่ง _lockKey ให้ตรงด้วย
 * (_user มาจากเบราว์เซอร์ ปลอมเป็น all ได้ — กุญแจนี้มีเฉพาะบนเซิร์ฟเวอร์ของออฟฟิศ
 *  ตั้งไว้แล้วสาขาจะตั้ง/ปลดล็อกเองไม่ได้แม้จะแก้ localStorage)
 */
async function setScheduleLock(body, session) {
  if (!session?.isAll) {
    throw Object.assign(new Error('ตั้งล็อกตารางงานได้เฉพาะออฟฟิศ (สิทธิ์ all)'), { forbidden: true });
  }
  const need = str(process.env.SCHEDULE_LOCK_KEY);
  if (need && !keyMatches(body._lockKey, need)) {
    throw Object.assign(new Error('กุญแจล็อกตารางงานไม่ถูกต้อง (SCHEDULE_LOCK_KEY)'), { forbidden: true });
  }

  const branches = [...new Set((Array.isArray(body.branches) ? body.branches : [body.branch])
    .flatMap(branchCodes)
    .filter((b) => b && b !== 'all'))];
  if (branches.length === 0) {
    throw Object.assign(new Error('กรุณาเลือกสาขาที่จะล็อกอย่างน้อย 1 สาขา'), { badRequest: true });
  }
  const until = str(body.lockedUntil);
  if (until && !isDateStr(until)) {
    throw Object.assign(new Error('วันที่ล็อกต้องเป็นรูปแบบ YYYY-MM-DD'), { badRequest: true });
  }
  const note = str(body.note).slice(0, 255) || null;
  const actor = str(session.name) || str(session.username) || null;

  await ensureLockTables();

  const rowsJson = JSON.stringify(branches.map((b) => ({ branch: b })));
  await withTransaction(async (run) => {
    if (until) {
      await run(
        `MERGE dbo.hr_schedule_lock WITH (HOLDLOCK) AS t
           USING (SELECT branch FROM OPENJSON(@rows) WITH (branch NVARCHAR(50) '$.branch')) AS s
              ON t.branch = s.branch
         WHEN MATCHED THEN UPDATE SET
              locked_until = @until, note = @note, locked_by = @actor, locked_at = SYSDATETIME()
         WHEN NOT MATCHED THEN INSERT (branch, locked_until, note, locked_by)
              VALUES (s.branch, @until, @note, @actor);`,
        {
          rows: { type: sql.NVarChar(sql.MAX), value: rowsJson },
          until: { type: sql.Date, value: until },
          note: { type: sql.NVarChar(255), value: note },
          actor: { type: sql.NVarChar(100), value: actor },
        }
      );
    } else {
      await run(
        `DELETE t FROM dbo.hr_schedule_lock t
           JOIN OPENJSON(@rows) WITH (branch NVARCHAR(50) '$.branch') s ON t.branch = s.branch;`,
        { rows: { type: sql.NVarChar(sql.MAX), value: rowsJson } }
      );
    }
    await run(
      `INSERT INTO dbo.hr_schedule_lock_log (branch, locked_until, actor, note)
       SELECT s.branch, @until, @actor, @note
         FROM OPENJSON(@rows) WITH (branch NVARCHAR(50) '$.branch') s;`,
      {
        rows: { type: sql.NVarChar(sql.MAX), value: rowsJson },
        until: { type: sql.Date, value: until || null },
        note: { type: sql.NVarChar(255), value: note },
        actor: { type: sql.NVarChar(100), value: actor },
      }
    );
  });

  const locks = await getScheduleLocks({}, session);
  return {
    locks,
    message: until
      ? `ล็อกตารางงาน ${branches.length} สาขา ถึงวันที่ ${thaiDate(until)} แล้ว`
      : `ปลดล็อกตารางงาน ${branches.length} สาขาแล้ว`,
  };
}

export const SCHEDULE_LOCK_ACTIONS = {
  getScheduleLocks,
  setScheduleLock,
};
