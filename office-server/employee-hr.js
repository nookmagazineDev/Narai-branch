// พนักงาน: เพิ่มพนักงาน / แจ้งลาออก / เลข LOGA / รูป / ข้อมูลส่วนตัว / ประวัติพนักงานเข้า-ออก
//
// ย้ายจาก Google Sheet (Apps Script) มาที่ SQL ทั้งหมด — SQL เป็นตัวหลักของรายชื่อพนักงานแล้ว
//   รายชื่อ          narai_hr.dbo.hr_employee         (ตารางเดิม หน้าลงตารางงาน/เงินเดือนอ่านอยู่แล้ว)
//   ข้อมูลส่วนตัว     InventoryNarai.dbo.hr_employee_profile   (เดิมชีท DATA คอลัมน์ M/Q/S/BP/BQ)
//   ประวัติเข้า-ออก   InventoryNarai.dbo.hr_employee_movement  (เดิมชีท "พนักงานเข้า" / "พนักงานออก")
//   ไฟล์แนบ/รูป      โฟลเดอร์บนเครื่องออฟฟิศ (EMPLOYEE_FILE_DIR) — เดิมอยู่บน Google Drive
//
// สิทธิ์
//   สาขา   เพิ่มพนักงาน/แจ้งลาออก/แก้ LOGA/อัปรูป ได้เฉพาะพนักงานของสาขาตัวเอง
//          ข้อมูลส่วนตัวเขียนได้ตอนเพิ่มพนักงานเท่านั้น อ่านกลับไม่ได้
//   ออฟฟิศ (ผู้ใช้สิทธิ์ all — เว็บ office naraipizzeria ส่งมาด้วยสิทธิ์นี้)
//          ทำได้ทุกอย่าง + อ่าน/แก้ข้อมูลส่วนตัว + ดูประวัติเข้า-ออก + นำเข้าข้อมูลเดิมจากชีท
//
// ลำดับการเขียนตอนเพิ่มพนักงาน: hr_employee ก่อน (คนละฐานกับอีกสองตาราง จึงอยู่ใน transaction
// เดียวกันไม่ได้) ถ้าตารางข้อมูลส่วนตัว/ประวัติเขียนไม่ผ่าน พนักงานยังอยู่ในรายชื่อและแจ้งผู้ใช้ตรง ๆ

import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, hrDb, stockDb } from './hr-db.js';
import { branchFor, branchCodes, branchListValue, primaryBranch, sameBranch } from './hr-session.js';

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const forbidden = (msg) => Object.assign(new Error(msg), { forbidden: true });
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(str(v));
const who = (session, fallback) => str(session?.name) || str(session?.username) || str(fallback) || null;

/** SQL Server error 208 = ยังไม่มีตาราง (ยังไม่ได้รัน update-office-server.bat) */
const tableMissing = (e) => e?.number === 208 || /Invalid object name/i.test(e?.message || '');
const MISSING_MSG = 'ยังไม่ได้สร้างตารางพนักงานชุดใหม่ — ให้รัน update-office-server.bat บนเครื่องออฟฟิศก่อน';

function requireOffice(session) {
  if (!session?.isAll) throw forbidden('ทำรายการนี้ได้ที่ออฟฟิศเท่านั้น');
}

const BKK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });
const BKK_YYMM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit' });
const dateOut = (v) => (!v ? '' : v instanceof Date ? BKK_DATE.format(v) : str(v).slice(0, 10));

/** 'YYYY-MM-DD' ที่เป็นวันจริง ปี ค.ศ. -> ข้อความเดิม · อื่น ๆ -> null */
function ymdOrNull(v) {
  const s = str(v);
  if (!isYmd(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2200 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** อายุงานแบบที่ชีท "พนักงานออก" เคยเขียน — '1 ปี 4 เดือน 3 วัน' */
export function durationThai(startYmd, endYmd) {
  if (!isYmd(startYmd) || !isYmd(endYmd) || startYmd > endYmd) return '';
  const [sy, sm, sd] = startYmd.split('-').map(Number);
  const [ey, em, ed] = endYmd.split('-').map(Number);
  // นับเดือนเต็มก่อน แล้วเอาวันที่เหลือจาก "วันครบเดือน" ถึงวันลาออก
  // (วันครบเดือนตัดให้อยู่ในเดือนนั้น เช่น 31 ม.ค. + 1 เดือน = 28/29 ก.พ.) — ไม่ได้ค่าติดลบเวลาเดือนสั้น
  const anchorOf = (n) => {
    const y = sy + Math.floor((sm - 1 + n) / 12);
    const m = ((sm - 1 + n) % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Date.UTC(y, m - 1, Math.min(sd, last));
  };
  const end = Date.UTC(ey, em - 1, ed);
  let months = (ey - sy) * 12 + (em - sm);
  while (months > 0 && anchorOf(months) > end) months -= 1;
  const days = Math.round((end - anchorOf(months)) / 86400000);
  const years = Math.floor(months / 12);
  const out = [];
  if (years) out.push(`${years} ปี`);
  if (months % 12) out.push(`${months % 12} เดือน`);
  if (days || out.length === 0) out.push(`${days} วัน`);
  return out.join(' ');
}

/* ===================== ไฟล์บนเครื่องออฟฟิศ =====================
   ค่าเริ่มต้นคือ office-server/uploads (อยู่ใน .gitignore — git pull ไม่แตะ)
   ตั้ง EMPLOYEE_FILE_DIR ใน .env ได้ถ้าอยากเก็บไว้ไดรฟ์อื่น ⚠️ ต้องสำรองโฟลเดอร์นี้เอง

   ชื่อไฟล์มีตัวสุ่มต่อท้ายเสมอ — ลิงก์เดาไม่ได้แม้รู้รหัสพนักงาน
   ในฐานข้อมูลเก็บเป็น 'file:<โฟลเดอร์ย่อย>/<ชื่อไฟล์>' หน้าเว็บแต่ละฝั่งแปลงเป็นลิงก์ของตัวเอง */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fileRoot = () => resolve(process.env.EMPLOYEE_FILE_DIR || join(SERVER_DIR, 'uploads'));
const FILE_KINDS = ['photos', 'attachments'];
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const safeName = (v) => str(v).normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(-80) || 'file';
const rand = () => randomBytes(6).toString('hex');

function decodeDataUri(v) {
  const s = str(v);
  const b64 = s.includes(',') ? s.slice(s.indexOf(',') + 1) : s;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('ไฟล์ว่างเปล่า');
  if (buf.length > MAX_FILE_BYTES) throw badRequest('ไฟล์ใหญ่เกิน 8 MB');
  return buf;
}

async function saveFile(kind, name, buf) {
  const dir = join(fileRoot(), kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), buf);
  return `file:${kind}/${name}`;
}

/** GET /employee-files?path=photos/xxx.jpg — ผูกใน server.js (API_TOKEN ตรวจไว้แล้วที่ middleware) */
export function employeeFileHandler(req, res) {
  const rel = str(req.query.path).replace(/\\/g, '/');
  const [kind, ...rest] = rel.split('/');
  if (!FILE_KINDS.includes(kind) || rest.length === 0 || rest.some((p) => !p || p === '..' || p === '.')) {
    return res.status(400).json({ status: 'error', message: 'path ไม่ถูกต้อง' });
  }
  const root = fileRoot();
  const full = resolve(root, rel);
  if (!full.startsWith(root + sep) || !existsSync(full)) {
    return res.status(404).json({ status: 'error', message: 'ไม่พบไฟล์' });
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.sendFile(full);
}

/* ===================== รหัส HR ถัดไป =====================
   รูปแบบเดิมของ Apps Script: YYMM + เลขวิ่ง 3 หลัก (2611001) เลือกเลขแรกที่ยังว่างของเดือนนี้ */
async function nextHrCode() {
  const prefix = BKK_YYMM.format(new Date()).replace(/\D/g, '');   // '26/11' -> '2611'
  const rows = await hrDb.queryRead(
    `SELECT hr_code FROM dbo.hr_employee WHERE hr_code LIKE @p + '%'`,
    { p: { type: sql.NVarChar(10), value: prefix } }
  );
  const taken = new Set(rows.map((r) => str(r.hr_code)));
  for (let n = 1; n < 1000; n += 1) {
    const code = `${prefix}${String(n).padStart(3, '0')}`;
    if (!taken.has(code)) return code;
  }
  throw badRequest(`รหัส HR ของเดือนนี้ (${prefix}xxx) เต็มแล้ว`);
}

async function getNextHrCode() {
  return { hrCode: await nextHrCode() };
}

let branchesColumn = null;
function hasBranchesColumn() {
  if (branchesColumn === null) {
    branchesColumn = hrDb.queryRead(`SELECT COL_LENGTH(N'dbo.hr_employee', N'branches') AS len`)
      .then((rows) => rows[0]?.len != null)
      .catch(() => { branchesColumn = null; return false; });
  }
  return branchesColumn;
}

/** แถวพนักงานหนึ่งคน + ตรวจว่าคนเรียกมีสิทธิ์กับสาขาของคนนั้น */
async function loadEmployee(hrCode, session) {
  const code = str(hrCode);
  if (!code) throw badRequest('ไม่ระบุรหัสพนักงาน');
  const withList = await hasBranchesColumn();
  const rows = await hrDb.queryRead(
    `SELECT hr_code, full_name, branch, emp_type, position, status, start_date, loga, photo_url
            ${withList ? ', branches' : ''}
       FROM dbo.hr_employee WHERE hr_code = @c`,
    { c: { type: sql.NVarChar(30), value: code } }
  );
  const r = rows[0];
  if (!r) throw badRequest(`ไม่พบพนักงานรหัส ${code}`);
  const empBranches = str(r.branches) || str(r.branch);
  if (session && !session.isAll && !sameBranch(empBranches, session.branch)) {
    throw forbidden(`พนักงานรหัส ${code} ไม่ได้อยู่สาขาของคุณ`);
  }
  return r;
}

const NAT_LABEL = { thai: 'ไทย', foreigner: 'ต่างชาติ', foreign: 'ต่างชาติ' };

/* ===================== เพิ่มพนักงาน =====================
   body เดียวกับที่หน้า "เพิ่มพนักงาน" เคยส่งให้ Apps Script:
   { hrCode, fullName, department, type, position, idCard, address, birthday, phone, lineId, loga,
     nationality, documents[], documentExpiry{}, startDate, files[{ name, mimeType, base64 }], recorder } */
async function addEmployee(body, session) {
  const fullName = str(body.fullName).replace(/\s+/g, ' ');
  if (!fullName) throw badRequest('กรอกชื่อ - นามสกุล');
  const startDate = ymdOrNull(body.startDate);
  if (!startDate) throw badRequest('ระบุวันที่เริ่มงานให้ถูกต้อง');

  // สาขาปกติเพิ่มได้เฉพาะสาขาตัวเอง (ช่อง "สังกัด" ในฟอร์มเป็นข้อความอิสระ จึงไม่เชื่อค่านั้น)
  // ผู้ใช้สิทธิ์ all ต้องกรอกรหัสสาขาในช่องนั้น
  const branch = session?.isAll
    ? primaryBranch(body.department)
    : str(branchFor(session, session?.branch)).toLowerCase();
  if (!branch || branch === 'all') throw badRequest('ระบุรหัสสาขาในช่อง "สังกัด" (เช่น SUM)');
  const branchesValue = session?.isAll ? branchListValue(body.department) : `,${branch},`;

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > 10) throw badRequest('แนบไฟล์ได้ไม่เกิน 10 ไฟล์');
  const decoded = files.map((f) => ({ name: safeName(f?.name), buf: decodeDataUri(f?.base64) }));

  // รหัสที่ฟอร์มขอไว้ใช้ได้ถ้ายังว่าง ไม่งั้นออกเลขใหม่ (กันสองเครื่องกดพร้อมกันได้เลขเดียวกัน)
  const withList = await hasBranchesColumn();
  let hrCode = /^\d{7}$/.test(str(body.hrCode)) ? str(body.hrCode) : '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!hrCode) hrCode = await nextHrCode();
    try {
      await hrDb.queryRead(
        `INSERT INTO dbo.hr_employee
           (hr_code, full_name, branch, emp_type, position, daily_wage, status, start_date, loga${withList ? ', branches' : ''})
         VALUES (@hr_code, @full_name, @branch, @emp_type, @position, 0, N'ทำงาน', @start_date, @loga${withList ? ', @branches' : ''})`,
        {
          hr_code: { type: sql.NVarChar(30), value: hrCode },
          full_name: { type: sql.NVarChar(150), value: fullName.slice(0, 150) },
          branch: { type: sql.NVarChar(50), value: branch },
          emp_type: { type: sql.NVarChar(20), value: str(body.type).slice(0, 20) || null },
          position: { type: sql.NVarChar(100), value: str(body.position).slice(0, 100) || null },
          start_date: { type: sql.Date, value: startDate },
          loga: { type: sql.NVarChar(50), value: str(body.loga).slice(0, 50) || null },
          ...(withList ? { branches: { type: sql.NVarChar(200), value: branchesValue } } : {}),
        }
      );
      break;
    } catch (e) {
      // 2627 = รหัสซ้ำ (มีคนเพิ่งใช้เลขนี้) ออกเลขใหม่แล้วลองอีกรอบ
      if (e?.number === 2627 && attempt < 2) { hrCode = ''; continue; }
      throw e;
    }
  }

  const docList = (Array.isArray(body.documents) ? body.documents : []).map((d) => {
    const exp = str(body.documentExpiry?.[d]);
    if (!exp) return str(d);
    return d === 'สมุดบัญชีธนาคาร' ? `${d} (บัญชี: ${exp})` : `${d} (หมดอายุ: ${exp})`;
  }).filter(Boolean).join(', ');
  const nationality = NAT_LABEL[str(body.nationality).toLowerCase()] || str(body.nationality) || null;
  const recorder = who(session, body.recorder);

  let warning = '';
  try {
    const attachments = [];
    for (const f of decoded) {
      const path = await saveFile('attachments', `${hrCode}-${rand()}-${f.name}`, f.buf);
      attachments.push({ name: f.name, path });
    }
    await stockDb.withTransaction(async (run) => {
      await run(
        `DELETE FROM dbo.hr_employee_profile WHERE hr_code = @hr_code;
         INSERT INTO dbo.hr_employee_profile
           (hr_code, id_card, address, birthday, phone, line_id, nationality, documents, attachments, updated_by)
         VALUES (@hr_code, @id_card, @address, @birthday, @phone, @line_id, @nationality, @documents, @attachments, @by)`,
        {
          hr_code: { type: sql.NVarChar(30), value: hrCode },
          id_card: { type: sql.NVarChar(30), value: str(body.idCard).slice(0, 30) || null },
          address: { type: sql.NVarChar(500), value: str(body.address).slice(0, 500) || null },
          birthday: { type: sql.Date, value: ymdOrNull(body.birthday) },
          phone: { type: sql.NVarChar(50), value: str(body.phone).slice(0, 50) || null },
          line_id: { type: sql.NVarChar(100), value: str(body.lineId).slice(0, 100) || null },
          nationality: { type: sql.NVarChar(30), value: nationality },
          documents: { type: sql.NVarChar(1000), value: docList.slice(0, 1000) || null },
          attachments: { type: sql.NVarChar(sql.MAX), value: attachments.length ? JSON.stringify(attachments) : null },
          by: { type: sql.NVarChar(255), value: recorder },
        }
      );
      await run(
        `INSERT INTO dbo.hr_employee_movement
           (kind, hr_code, full_name, branch, emp_type, position, nationality, start_date, recorded_by, source)
         VALUES (N'in', @hr_code, @full_name, @branch, @emp_type, @position, @nationality, @start_date, @by, N'web')`,
        {
          hr_code: { type: sql.NVarChar(30), value: hrCode },
          full_name: { type: sql.NVarChar(150), value: fullName.slice(0, 150) },
          branch: { type: sql.NVarChar(50), value: branch },
          emp_type: { type: sql.NVarChar(30), value: str(body.type).slice(0, 30) || null },
          position: { type: sql.NVarChar(100), value: str(body.position).slice(0, 100) || null },
          nationality: { type: sql.NVarChar(30), value: nationality },
          start_date: { type: sql.Date, value: startDate },
          by: { type: sql.NVarChar(255), value: recorder },
        }
      );
    });
  } catch (e) {
    console.error(`addEmployee ${hrCode}: บันทึกข้อมูลส่วนตัว/ประวัติไม่สำเร็จ:`, e?.message || e);
    warning = tableMissing(e)
      ? ` · แต่ยังบันทึกข้อมูลส่วนตัวไม่ได้ (${MISSING_MSG})`
      : ` · แต่บันทึกข้อมูลส่วนตัว/ไฟล์แนบไม่สำเร็จ: ${e?.message || e} — แจ้งออฟฟิศให้กรอกเพิ่ม`;
  }

  return { message: `เพิ่มพนักงานสำเร็จ (รหัส HR: ${hrCode})${warning}`, hrCode, warning: warning || undefined };
}

/* ===================== แจ้งลาออก ===================== */
async function resignEmployee(body, session) {
  const resignDate = ymdOrNull(body.resignDate);
  if (!resignDate) throw badRequest('กรุณาระบุวันที่ลาออก');
  const reason = str(body.reason);
  if (!reason) throw badRequest('กรุณาระบุสาเหตุการลาออก');
  const emp = await loadEmployee(body.hrCode, session);
  if (str(emp.status) === 'ลาออก') throw badRequest(`${str(emp.full_name)} มีสถานะลาออกอยู่แล้ว`);

  await hrDb.queryRead(
    `UPDATE dbo.hr_employee SET status = N'ลาออก', resign_date = @d, updated_at = SYSDATETIME() WHERE hr_code = @c`,
    { c: { type: sql.NVarChar(30), value: str(emp.hr_code) }, d: { type: sql.Date, value: resignDate } }
  );

  const startDate = dateOut(emp.start_date);
  let warning = '';
  try {
    await stockDb.queryRead(
      `INSERT INTO dbo.hr_employee_movement
         (kind, hr_code, full_name, branch, emp_type, position, start_date, resign_date, reason, duration_text, recorded_by, source)
       VALUES (N'out', @hr_code, @full_name, @branch, @emp_type, @position, @start_date, @resign_date, @reason, @duration, @by, N'web')`,
      {
        hr_code: { type: sql.NVarChar(30), value: str(emp.hr_code) },
        full_name: { type: sql.NVarChar(150), value: str(emp.full_name) },
        branch: { type: sql.NVarChar(50), value: str(emp.branch) },
        emp_type: { type: sql.NVarChar(30), value: str(emp.emp_type) || null },
        position: { type: sql.NVarChar(100), value: str(emp.position) || null },
        start_date: { type: sql.Date, value: startDate || null },
        resign_date: { type: sql.Date, value: resignDate },
        reason: { type: sql.NVarChar(500), value: reason.slice(0, 500) },
        duration: { type: sql.NVarChar(100), value: durationThai(startDate, resignDate) || null },
        by: { type: sql.NVarChar(255), value: who(session, body.recorder) },
      }
    );
  } catch (e) {
    console.error(`resignEmployee ${emp.hr_code}: บันทึกประวัติไม่สำเร็จ:`, e?.message || e);
    warning = tableMissing(e) ? ` · แต่ยังบันทึกประวัติไม่ได้ (${MISSING_MSG})` : ` · แต่บันทึกประวัติลาออกไม่สำเร็จ: ${e?.message || e}`;
  }
  return { message: `แจ้งลาออกสำเร็จ${warning}`, hrCode: str(emp.hr_code) };
}

/* ===================== เลข LOGA ===================== */
async function updateEmployeeLoga(body, session) {
  const emp = await loadEmployee(body.hrCode, session);
  await hrDb.queryRead(
    `UPDATE dbo.hr_employee SET loga = @loga, updated_at = SYSDATETIME() WHERE hr_code = @c`,
    { c: { type: sql.NVarChar(30), value: str(emp.hr_code) }, loga: { type: sql.NVarChar(50), value: str(body.loga).slice(0, 50) || null } }
  );
  return { message: 'บันทึกเลขที่ LOGA เรียบร้อย' };
}

/* ===================== รูปพนักงาน =====================
   ไฟล์เดียวต่อคน — อัปใหม่ลบรูปเก่าของคนนั้นทิ้ง */
async function uploadEmployeePhoto(body, session) {
  const emp = await loadEmployee(body.hrCode, session);
  const mime = str(body.mimeType).toLowerCase();
  if (mime && !mime.startsWith('image/')) throw badRequest('กรุณาเลือกไฟล์รูปภาพ');
  const ext = (str(body.ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg').slice(0, 5);
  const buf = decodeDataUri(body.base64);
  const code = str(emp.hr_code);

  const dir = join(fileRoot(), 'photos');
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(dir)) {
    if (f.startsWith(`${code}-`)) await unlink(join(dir, f)).catch(() => {});
  }
  const path = await saveFile('photos', `${code}-${rand()}.${ext}`, buf);
  await hrDb.queryRead(
    `UPDATE dbo.hr_employee SET photo_url = @u, updated_at = SYSDATETIME() WHERE hr_code = @c`,
    { c: { type: sql.NVarChar(30), value: code }, u: { type: sql.NVarChar(500), value: path } }
  );
  return { message: 'อัปโหลดรูปสำเร็จ', url: path };
}

/* ===================== ข้อมูลส่วนตัว (ออฟฟิศเท่านั้น) ===================== */
const toProfile = (r) => ({
  hrCode: str(r.hr_code),
  idCard: str(r.id_card),
  address: str(r.address),
  birthday: dateOut(r.birthday),
  phone: str(r.phone),
  lineId: str(r.line_id),
  nationality: str(r.nationality),
  documents: str(r.documents),
  attachments: (() => { try { return JSON.parse(r.attachments || '[]'); } catch { return []; } })(),
  updatedBy: str(r.updated_by),
  updatedAt: str(r.updated_text),
});

async function getEmployeeProfiles(body, session) {
  requireOffice(session);
  try {
    const rows = await stockDb.queryRead(
      `SELECT hr_code, id_card, address, birthday, phone, line_id, nationality, documents, attachments, updated_by,
              CONVERT(varchar(16), updated_at, 120) AS updated_text
         FROM dbo.hr_employee_profile`
    );
    return { ready: true, data: rows.map(toProfile) };
  } catch (e) {
    if (tableMissing(e)) return { ready: false, data: [] };
    throw e;
  }
}

/** { hrCode, phone, address, idCard, birthday, lineId } — ส่งมาครบทุกช่อง ช่องว่าง = ล้าง */
async function saveEmployeeProfile(body, session) {
  requireOffice(session);
  const emp = await loadEmployee(body.hrCode, session);
  const birthday = str(body.birthday);
  if (birthday && !ymdOrNull(birthday)) throw badRequest('วันเกิดไม่ถูกต้อง');
  const params = {
    hr_code: { type: sql.NVarChar(30), value: str(emp.hr_code) },
    id_card: { type: sql.NVarChar(30), value: str(body.idCard).slice(0, 30) || null },
    address: { type: sql.NVarChar(500), value: str(body.address).slice(0, 500) || null },
    birthday: { type: sql.Date, value: ymdOrNull(birthday) },
    phone: { type: sql.NVarChar(50), value: str(body.phone).slice(0, 50) || null },
    line_id: { type: sql.NVarChar(100), value: str(body.lineId).slice(0, 100) || null },
    by: { type: sql.NVarChar(255), value: who(session) },
  };
  try {
    await stockDb.queryRead(
      `MERGE dbo.hr_employee_profile WITH (HOLDLOCK) AS t
         USING (SELECT @hr_code AS hr_code) AS s ON t.hr_code = s.hr_code
       WHEN MATCHED THEN UPDATE SET id_card = @id_card, address = @address, birthday = @birthday,
            phone = @phone, line_id = @line_id, updated_by = @by, updated_at = SYSDATETIME()
       WHEN NOT MATCHED THEN INSERT (hr_code, id_card, address, birthday, phone, line_id, updated_by)
            VALUES (@hr_code, @id_card, @address, @birthday, @phone, @line_id, @by);`,
      params
    );
    const rows = await stockDb.queryRead(
      `SELECT hr_code, id_card, address, birthday, phone, line_id, nationality, documents, attachments, updated_by,
              CONVERT(varchar(16), updated_at, 120) AS updated_text
         FROM dbo.hr_employee_profile WHERE hr_code = @hr_code`,
      { hr_code: params.hr_code }
    );
    return { message: 'บันทึกข้อมูลส่วนตัวแล้ว', profile: rows[0] ? toProfile(rows[0]) : null };
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
}

/* ===================== ประวัติพนักงานเข้า-ออก (ออฟฟิศ ดูอย่างเดียว) =====================
   { start, end, branch? } — ช่วงวันที่ของ "วันที่บันทึก" (ตรงกับชีทเดิมที่เรียงตาม Timestamp) */
async function getEmployeeMovements(body, session) {
  requireOffice(session);
  const start = ymdOrNull(body.start);
  const end = ymdOrNull(body.end);
  if (!start || !end || start > end) throw badRequest('ระบุช่วงวันที่ให้ถูกต้อง');
  const branch = branchCodes(body.branch)[0] || '';
  try {
    const rows = await stockDb.queryRead(
      `SELECT movement_id, kind, hr_code, full_name, branch, emp_type, position, nationality, reason, duration_text,
              recorded_by, source,
              CONVERT(varchar(10), start_date, 23)  AS start_text,
              CONVERT(varchar(10), resign_date, 23) AS resign_text,
              CONVERT(varchar(16), recorded_at, 120) AS recorded_text
         FROM dbo.hr_employee_movement
        WHERE recorded_at >= @start AND recorded_at < DATEADD(day, 1, CAST(@end AS DATE))
          ${branch ? 'AND LOWER(branch) = @branch' : ''}
        ORDER BY recorded_at DESC, movement_id DESC`,
      {
        start: { type: sql.Date, value: start },
        end: { type: sql.Date, value: end },
        ...(branch ? { branch: { type: sql.NVarChar(50), value: branch } } : {}),
      }
    );
    return {
      ready: true,
      data: rows.map((r) => ({
        id: Number(r.movement_id),
        kind: str(r.kind) === 'out' ? 'out' : 'in',
        hrCode: str(r.hr_code),
        fullName: str(r.full_name),
        branch: str(r.branch),
        empType: str(r.emp_type),
        position: str(r.position),
        nationality: str(r.nationality),
        startDate: str(r.start_text),
        resignDate: str(r.resign_text),
        reason: str(r.reason),
        duration: str(r.duration_text),
        recordedBy: str(r.recorded_by),
        recordedAt: str(r.recorded_text),
        source: str(r.source),
      })),
    };
  } catch (e) {
    if (tableMissing(e)) return { ready: false, data: [] };
    throw e;
  }
}

/* ===================== นำเข้าข้อมูลเดิมจากสเปรดชีตพนักงาน (ออฟฟิศ) =====================
   หน้าเว็บออฟฟิศอ่านไฟล์ .xlsx ที่ดาวน์โหลดจาก Google Sheet แล้วส่งมาเป็นชุด (ไม่เกิน 500 แถวต่อครั้ง)
     { kind: 'employees', rows: [{ hrCode, fullName, branch, type, status, startDate, position, dailyWage,
                                   loga, idCard, address, birthday, phone, lineId, nationality }] }
       -> hr_employee (เพิ่ม/อัปเดต ช่องว่างไม่ทับของเดิม) + hr_employee_profile
     { kind: 'movements', reset: true|false, rows: [{ kind:'in'|'out', hrCode, fullName, branch, empType, position,
                                   nationality, startDate, resignDate, reason, duration, recordedBy, recordedAt }] }
       -> hr_employee_movement (source = import) · reset = ลบชุด import เดิมก่อน (ส่งมากับชุดแรก)
   นำเข้าซ้ำได้ ไม่เกิดข้อมูลซ้ำ */
async function importEmployeeSheet(body, session) {
  requireOffice(session);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 500) throw badRequest('ส่งได้ไม่เกิน 500 แถวต่อครั้ง');
  const kind = str(body.kind);
  try {
    if (kind === 'employees') return await importEmployees(rows);
    if (kind === 'movements') return await importMovements(rows, body.reset === true);
  } catch (e) {
    if (tableMissing(e)) throw badRequest(MISSING_MSG);
    throw e;
  }
  throw badRequest(`ไม่รู้จักชนิดข้อมูล "${kind}"`);
}

async function importEmployees(input) {
  const rows = input
    .map((r) => ({
      hrCode: str(r.hrCode),
      name: str(r.fullName).replace(/\s+/g, ' ').slice(0, 150),
      branch: primaryBranch(r.branch),
      branches: branchListValue(r.branch),
      empType: str(r.type).slice(0, 20),
      position: str(r.position).slice(0, 100),
      dailyWage: num(r.dailyWage),
      status: str(r.status) === 'ลาออก' ? 'ลาออก' : 'ทำงาน',
      startDate: ymdOrNull(r.startDate),
      loga: str(r.loga).slice(0, 50),
      idCard: str(r.idCard).slice(0, 30),
      address: str(r.address).slice(0, 500),
      birthday: ymdOrNull(r.birthday),
      phone: str(r.phone).slice(0, 50),
      lineId: str(r.lineId).slice(0, 100),
      nationality: str(r.nationality).slice(0, 30),
    }))
    .filter((r) => r.hrCode && r.name && r.branch);
  if (rows.length === 0) return { employees: 0, profiles: 0 };

  const withList = await hasBranchesColumn();
  const json = { type: sql.NVarChar(sql.MAX), value: JSON.stringify(rows) };
  await hrDb.withTransaction((run) => run(
    `MERGE dbo.hr_employee WITH (HOLDLOCK) AS t
       USING (SELECT * FROM OPENJSON(@rows) WITH (
               hr_code NVARCHAR(30) '$.hrCode', full_name NVARCHAR(150) '$.name', branch NVARCHAR(50) '$.branch',
               branches NVARCHAR(200) '$.branches', emp_type NVARCHAR(20) '$.empType', position NVARCHAR(100) '$.position',
               daily_wage DECIMAL(12,2) '$.dailyWage', status NVARCHAR(20) '$.status', start_date DATE '$.startDate',
               loga NVARCHAR(50) '$.loga')) AS s
          ON t.hr_code = s.hr_code
     WHEN MATCHED THEN UPDATE SET
          full_name  = s.full_name,
          branch     = s.branch,
          ${withList ? `branches = COALESCE(NULLIF(s.branches, N''), t.branches),` : ''}
          emp_type   = COALESCE(NULLIF(s.emp_type, N''), t.emp_type),
          position   = COALESCE(NULLIF(s.position, N''), t.position),
          daily_wage = CASE WHEN s.daily_wage > 0 THEN s.daily_wage ELSE t.daily_wage END,
          start_date = COALESCE(s.start_date, t.start_date),
          loga       = COALESCE(NULLIF(s.loga, N''), t.loga),
          status     = s.status,
          updated_at = SYSDATETIME()
     WHEN NOT MATCHED THEN INSERT
          (hr_code, full_name, branch, emp_type, position, daily_wage, status, start_date, loga${withList ? ', branches' : ''})
          VALUES (s.hr_code, s.full_name, s.branch, NULLIF(s.emp_type, N''), NULLIF(s.position, N''), s.daily_wage,
                  s.status, s.start_date, NULLIF(s.loga, N'')${withList ? `, NULLIF(s.branches, N'')` : ''});`,
    { rows: json }
  ));

  // ข้อมูลส่วนตัว: ช่องที่ชีทว่างไม่ล้างของที่ออฟฟิศกรอกไว้แล้ว
  await stockDb.withTransaction((run) => run(
    `MERGE dbo.hr_employee_profile WITH (HOLDLOCK) AS t
       USING (SELECT * FROM OPENJSON(@rows) WITH (
               hr_code NVARCHAR(30) '$.hrCode', id_card NVARCHAR(30) '$.idCard', address NVARCHAR(500) '$.address',
               birthday DATE '$.birthday', phone NVARCHAR(50) '$.phone', line_id NVARCHAR(100) '$.lineId',
               nationality NVARCHAR(30) '$.nationality')) AS s
          ON t.hr_code = s.hr_code
     WHEN MATCHED THEN UPDATE SET
          id_card     = COALESCE(NULLIF(s.id_card, N''), t.id_card),
          address     = COALESCE(NULLIF(s.address, N''), t.address),
          birthday    = COALESCE(s.birthday, t.birthday),
          phone       = COALESCE(NULLIF(s.phone, N''), t.phone),
          line_id     = COALESCE(NULLIF(s.line_id, N''), t.line_id),
          nationality = COALESCE(NULLIF(s.nationality, N''), t.nationality),
          updated_at  = SYSDATETIME()
     WHEN NOT MATCHED AND (s.id_card <> N'' OR s.address <> N'' OR s.birthday IS NOT NULL OR s.phone <> N''
                           OR s.line_id <> N'' OR s.nationality <> N'') THEN INSERT
          (hr_code, id_card, address, birthday, phone, line_id, nationality, updated_by)
          VALUES (s.hr_code, NULLIF(s.id_card, N''), NULLIF(s.address, N''), s.birthday, NULLIF(s.phone, N''),
                  NULLIF(s.line_id, N''), NULLIF(s.nationality, N''), N'นำเข้าจากชีท');`,
    { rows: json }
  ));
  return { employees: rows.length };
}

async function importMovements(input, reset) {
  const rows = input
    .map((r) => ({
      kind: str(r.kind) === 'out' ? 'out' : 'in',
      hrCode: str(r.hrCode).slice(0, 30),
      name: str(r.fullName).slice(0, 150),
      branch: primaryBranch(r.branch).slice(0, 50),
      empType: str(r.empType).slice(0, 30),
      position: str(r.position).slice(0, 100),
      nationality: str(r.nationality).slice(0, 30),
      startDate: ymdOrNull(r.startDate),
      resignDate: ymdOrNull(r.resignDate),
      reason: str(r.reason).slice(0, 500),
      duration: str(r.duration).slice(0, 100),
      recordedBy: str(r.recordedBy).slice(0, 255),
      // 'YYYY-MM-DD HH:mm:ss' เวลาไทย — ไม่มีให้ใช้วันเริ่มงาน/วันลาออกแทน จะได้ยังเรียงช่วงวันที่ได้
      recordedAt: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(str(r.recordedAt))
        ? str(r.recordedAt)
        : (ymdOrNull(r.resignDate) || ymdOrNull(r.startDate) || null),
    }))
    .filter((r) => (r.hrCode || r.name) && r.recordedAt);

  await stockDb.withTransaction(async (run) => {
    if (reset) await run(`DELETE FROM dbo.hr_employee_movement WHERE source = N'import'`);
    if (rows.length === 0) return;
    await run(
      `INSERT INTO dbo.hr_employee_movement
         (kind, hr_code, full_name, branch, emp_type, position, nationality, start_date, resign_date, reason,
          duration_text, recorded_by, recorded_at, source)
       SELECT kind, NULLIF(hr_code, N''), NULLIF(full_name, N''), NULLIF(branch, N''), NULLIF(emp_type, N''),
              NULLIF(position, N''), NULLIF(nationality, N''), start_date, resign_date, NULLIF(reason, N''),
              NULLIF(duration, N''), NULLIF(recorded_by, N''), CAST(recorded_at AS DATETIME2(0)), N'import'
         FROM OPENJSON(@rows) WITH (
              kind NVARCHAR(3) '$.kind', hr_code NVARCHAR(30) '$.hrCode', full_name NVARCHAR(150) '$.name',
              branch NVARCHAR(50) '$.branch', emp_type NVARCHAR(30) '$.empType', position NVARCHAR(100) '$.position',
              nationality NVARCHAR(30) '$.nationality', start_date DATE '$.startDate', resign_date DATE '$.resignDate',
              reason NVARCHAR(500) '$.reason', duration NVARCHAR(100) '$.duration', recorded_by NVARCHAR(255) '$.recordedBy',
              recorded_at NVARCHAR(19) '$.recordedAt')`,
      { rows: { type: sql.NVarChar(sql.MAX), value: JSON.stringify(rows) } }
    );
  });
  return { movements: rows.length, skipped: input.length - rows.length };
}

export const EMPLOYEE_HR_ACTIONS = {
  getNextHrCode,
  addEmployee,
  resignEmployee,
  updateEmployeeLoga,
  uploadEmployeePhoto,
  getEmployeeProfiles,
  saveEmployeeProfile,
  getEmployeeMovements,
  importEmployeeSheet,
};
