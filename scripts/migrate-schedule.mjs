#!/usr/bin/env node
/**
 * ย้ายข้อมูลตารางงานจาก Google Sheets เข้า MS SQL Server (narai_hr)
 *
 * ย้ายให้ 2 อย่าง: พนักงาน (พร้อมสร้างรายชื่อสาขาให้อัตโนมัติ) และตารางงานย้อนหลัง
 * ชีทเป้าขาย (Details) กับยอดขายรายวัน เลิกใช้แล้วจึงไม่ย้าย
 * -> เป้าขาย/ค่าแรงสูงสุด/ยอดขายของวัน จะเป็น 0 จนกว่าจะกรอกลง dbo.hr_branch เอง
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
 *   --only=timesheet  ย้ายเฉพาะบางส่วน: employees | timesheet (คั่นด้วย ,)
 *   --dry-run         อ่านชีทและสรุปผลอย่างเดียว ไม่เขียนลงฐานข้อมูล
 *   --inspect         พิมพ์แถวแรกๆ ของชีทออกมาดิบๆ ไว้ดูว่าคอลัมน์ไหนคืออะไร (ไม่แตะฐานข้อมูล)
 *   --keys            วิเคราะห์ว่าคอลัมน์ไหนใช้เป็นรหัสประจำตัวได้ และเชื่อมสองชีทด้วยชื่อได้กี่ %
 *   --find=1234,5678  ค้นว่าค่านั้นอยู่คอลัมน์ไหนของชีทพนักงาน
 *   --sheet=ชื่อแท็บ   เลือกแท็บของชีทพนักงาน (ค่าเริ่มต้น = แท็บแรก)
 *   --gid=238875059   เลือกแท็บด้วย gid (เลขท้าย URL ตอนเปิดแท็บนั้น) แม่นกว่าชื่อแท็บ
 *   --emp-id=<ID>     ชี้ไปชีทพนักงานไฟล์อื่น (วาง URL ทั้งเส้นก็ได้)
 *   --log-gid=<gid>   gid ของแท็บลงตารางงาน (จำเป็นเมื่อใช้ --csv)
 *   --csv             ดึงผ่าน export CSV แทน gviz — ต้องใส่เสมอถ้าชีทมีตัวกรองเปิดค้างไว้
 *   --header-row=3    สั่งเองว่าแถวไหนคือหัวตารางพนักงาน (ค่าเริ่มต้น = ให้สคริปต์หาเอง)
 *
 * ข้อควรรู้
 * - อ่านชีทผ่าน gviz แบบไม่ต้องล็อกอิน ชีททั้ง 2 ไฟล์จึงต้องตั้งลิงก์เป็น
 *   "ผู้ที่มีลิงก์ • ผู้อ่าน" ก่อน ไม่งั้นจะได้ HTML หน้า login แทนข้อมูล (สคริปต์จะแจ้งให้)
 * - ชีทพนักงานจับคอลัมน์จาก "ชื่อหัวตาราง" ไม่ใช่ตำแหน่ง (ไฟล์เปลี่ยนมาแล้วครั้งหนึ่ง)
 *   dry-run จะพิมพ์ให้ดูว่าจับคอลัมน์ไหนได้บ้าง ตรวจให้ตรงก่อนย้ายจริงเสมอ
 * - ชีทตารางงานเป็น log ต่อท้าย วันเดียวกันของคนเดียวกันมีได้หลายแถว
 *   สคริปต์จึงหยิบ "แถวล่าสุด" ตาม Timestamp เหมือนที่ Apps Script ทำตอนอ่าน
 *   และแถวที่หมายเหตุเป็น 'ล้างข้อมูล' = ถือว่าถูกลบ ไม่ย้ายเข้า SQL
 * - รันซ้ำได้ ใช้ MERGE ทับของเดิม ไม่เกิดข้อมูลซ้ำ
 * - ระวังตัวกรองในชีท: gviz ส่งกลับมาเฉพาะแถวที่ผ่านตัวกรองที่เปิดค้างไว้
 *   ชีทลงตารางงานมีตัวกรองอยู่จริง (เห็นจาก --inspect ได้ 496 แถวจากหมื่นกว่าแถว)
 *   ตอนย้ายจริงจึงต้องใส่ --csv เสมอ เพราะ export CSV ไม่สนใจตัวกรอง
 */

import process from 'node:process';

/* โหลด driver ฐานข้อมูลแบบ lazy
   โหมด --inspect และ --dry-run แค่อ่านชีทอย่างเดียว ไม่ได้แตะฐานข้อมูล
   จึงไม่ควรบังคับให้ npm install ก่อน (เครื่องที่รันสคริปต์นี้บางเครื่องลง package ไม่ได้)
   ตัวแปรพวกนี้จะมีค่าก็ต่อเมื่อเรียก loadDb() แล้วเท่านั้น */
let sql;
let getPool;
let closePool;
let withTransaction;
let describeDbError = (err) => err?.message || String(err);

async function loadDb() {
  if (sql) return;
  const m = await import('../lib/mssql.js');
  sql = m.sql;
  getPool = m.getPool;
  closePool = m.closePool;
  withTransaction = m.withTransaction;
  describeDbError = m.describeDbError;
}

/* ---- ไอดีชีทต้นทาง ----
   ชีทพนักงานย้ายไฟล์มาแล้ว ไม่ใช่ไฟล์เดียวกับที่ Apps Script เดิมชี้ไว้
   ส่วนชีท Details (เป้าขาย) และ "ยอดขายสาขา" เลิกใช้แล้ว จึงไม่ย้าย */
const DEFAULT_SOURCE_ID = '1Abot2hKLUO6_z8NRW6c9A0m0ggra3ZE7Yq10kcUPr7Y'; // พนักงาน (แท็บแรก)
const DESTINATION_SPREADSHEET_ID = '1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U'; // ลงตารางงาน
const LOG_SHEET_NAME = 'ลงตารางงาน';

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const INSPECT = args.includes('--inspect');
const MONTHS = Math.max(1, Number(argVal('months', '6')) || 6);
const ONLY = String(argVal('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const wants = (part) => ONLY.length === 0 || ONLY.includes(part);
// แท็บของชีทพนักงาน (เว้นว่าง = แท็บแรก) และแถวหัวตาราง (0 = ให้หาเอง)
const EMP_SHEET = argVal('sheet', '');
// gid = เลขท้าย URL ตอนเปิดแท็บนั้น (แม่นกว่าชื่อแท็บ ไม่ต้องพิมพ์ภาษาไทยให้ตรงเป๊ะ)
const EMP_GID = argVal('gid', '');
// gid ของแท็บ "ลงตารางงาน" — จำเป็นตอนใช้ --csv เพราะ export CSV ระบุแท็บด้วยชื่อไม่ได้
const LOG_GID = argVal('log-gid', '');
const USE_CSV = args.includes('--csv');
const HEADER_ROW = Number(argVal('header-row', '0')) || 0;
const FIND = argVal('find', ''); // ค้นค่าในชีทพนักงาน คั่นหลายค่าด้วย ,
const KEYS = args.includes('--keys'); // วิเคราะห์ว่าคอลัมน์ไหนใช้เป็นรหัสประจำตัวได้
// ชี้ไปชีทพนักงานไฟล์อื่นได้ ใส่ได้ทั้ง ID ล้วนหรือวาง URL มาทั้งเส้น
const SOURCE_SPREADSHEET_ID = (() => {
  const raw = argVal('emp-id', DEFAULT_SOURCE_ID);
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
})();

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

/**
 * ดึงชีทหนึ่งแผ่นผ่าน gviz — คืนทุกแถวดิบ รวมแถวหัวตาราง
 *
 * ใช้ headers=0 บังคับให้ gviz ส่งทุกแถวมาเป็นข้อมูล ไม่ต้องเดาว่าแถวไหนเป็นหัว
 * เพราะชีทพนักงานมีหัวตารางแบบรวมกลุ่มสองชั้น (ข้อมูลพื้นฐาน / ค่าจ้าง / ประวัติ)
 * ถ้าปล่อยให้ gviz เดา มันจะหยิบชั้นบน (หัวกลุ่ม) มาเป็นชื่อคอลัมน์ แล้วจับคอลัมน์ผิดทั้งแถบ
 * เราหาแถวหัวจริงเองด้วย pickHeaderRow() แทน
 */
async function fetchRows(spreadsheetId, sheetName, gid) {
  // ระบุแท็บได้ 2 แบบ: gid (เลขท้าย URL ตอนเปิดแท็บนั้น) หรือชื่อแท็บ
  // gid แม่นกว่าเพราะไม่ต้องพิมพ์ชื่อภาษาไทยให้ตรงเป๊ะ
  const target = gid ? `&gid=${encodeURIComponent(gid)}` : sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&headers=0${target}`;
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
      // gviz ส่งวันที่/เวลามาเป็นข้อความ "Date(2026,5,21,14,30,0)" (เดือนเริ่มที่ 0)
      if (typeof cell.v === 'string') {
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
        if (m) {
          const [, y, mo, d, h, mi, s] = m;
          // ช่องที่เก็บ "เวลาล้วน" Google ใส่วันที่เป็น 30/12/1899 มาให้ (epoch ของสเปรดชีต)
          // ถ้าแปลงเป็นวันที่ตามปกติ เวลาเข้า-ออกจะหายหมดทั้งชีท
          if (Number(y) <= 1900) return `${pad(Number(h || 0))}:${pad(Number(mi || 0))}`;
          const date = `${y}-${pad(Number(mo) + 1)}-${pad(Number(d))}`;
          // Timestamp ต้องเก็บเวลาไว้ด้วย ไม่งั้นแยกไม่ออกว่าการบันทึกครั้งไหนใหม่กว่ากันในวันเดียวกัน
          return h === undefined ? date : `${date} ${pad(Number(h))}:${pad(Number(mi))}:${pad(Number(s || 0))}`;
        }
      }
      if (cell.v === null || cell.v === undefined) return '';
      return cell.v;
    })
  );
}

/**
 * แยกข้อความ CSV เป็นตาราง (รองรับค่าที่มีเครื่องหมายคำพูด ลูกน้ำ และขึ้นบรรทัดใหม่ข้างใน)
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // "" = เครื่องหมายคำพูดจริงหนึ่งตัว
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * ดึงชีทผ่านช่องทาง export CSV แทน gviz
 *
 * ทำไมต้องมีสองทาง: gviz ส่งกลับมาเฉพาะแถวที่ผ่าน "ตัวกรอง" ที่เปิดค้างไว้ในชีท
 * ชีทลงตารางงานมีตัวกรองเปิดอยู่จริง ทำให้ gviz เห็นแค่ไม่กี่ร้อยแถวจากหมื่นกว่าแถว
 * ถ้าย้ายตามนั้นข้อมูลจะหายเกือบหมดโดยไม่มีอะไรฟ้อง — export CSV ไม่สนใจตัวกรอง
 * ข้อแลกเปลี่ยนคือได้ค่าตามรูปแบบที่ "แสดงผล" อยู่ จึงต้องพึ่ง toDateKey/timeText ที่ยืดหยุ่นอยู่แล้ว
 */
async function fetchRowsCsv(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (/^\s*</.test(text)) {
    throw new Error(
      `ดึง CSV ไม่ได้ (${spreadsheetId}${gid ? ` gid=${gid}` : ''}) — ` +
        'ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง'
    );
  }
  return parseCsv(text);
}

/** เลือกช่องทางดึงข้อมูลตามตัวเลือก --csv */
async function fetchSheetRows(spreadsheetId, sheetName, gid) {
  return USE_CSV ? fetchRowsCsv(spreadsheetId, gid) : fetchRows(spreadsheetId, sheetName, gid);
}

/**
 * หาว่าแถวไหนคือ "หัวตารางจริง" — ให้คะแนนตามจำนวนคอลัมน์ที่ตรงกับที่เราต้องการ
 * ชีทที่มีหัวรวมกลุ่มสองชั้น แถวบนจะได้คะแนนน้อย (ตรงแค่ 1-2 คำ) แถวหัวจริงจะได้คะแนนสูงสุด
 */
function pickHeaderRow(rows, defs, maxScan = 15) {
  let best = { row: -1, score: 0 };
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map(str);
    let score = 0;
    for (const def of defs) {
      // def.match เป็นลิสต์ของ pattern (เรียงตามลำดับความสำคัญ) — ตรงตัวไหนก็นับว่าเจอ
      if (cells.some((c) => c && def.match.some((p) => p.test(c)) && !(def.avoid && def.avoid.test(c)))) score++;
    }
    if (score > best.score) best = { row: i, score };
  }
  return best;
}

/**
 * ตรวจว่าคอลัมน์ที่จับได้มีข้อมูลจริงไหม
 * ชีทนี้มีหัวคอลัมน์ที่ตั้งไว้แต่ไม่เคยกรอก (เช่น "เรทรายวัน") ถ้าเชื่อหัวอย่างเดียว
 * จะได้คอลัมน์ว่างมาแทนคอลัมน์ที่มีข้อมูลจริง แล้วค่าแรงกลายเป็น 0 ทั้งระบบเงียบๆ
 */
function verifyColumns(map, rows, defs, sampleSize = 80) {
  const sample = rows.slice(0, sampleSize);
  const filledCount = (idx) => sample.filter((r) => str(r[idx]) !== '').length;
  const notes = [];
  for (const def of defs) {
    const idx = map[def.key];
    if (idx === def.fallback || filledCount(idx) > 0) continue;
    const fbFilled = filledCount(def.fallback);
    if (fbFilled > 0) {
      notes.push(
        `  ${def.key.padEnd(11)} : ${colName(idx)} ว่างทั้งคอลัมน์ -> เปลี่ยนไปใช้ ${colName(def.fallback)} (มีข้อมูล ${fbFilled}/${sample.length} แถว)`
      );
      map[def.key] = def.fallback;
    }
  }
  return notes;
}

/**
 * โหมด --find: หาว่าค่าที่ระบุอยู่คอลัมน์ไหนของชีท ใช้ยืนยันว่ารหัสพนักงานคือคอลัมน์อะไร
 * ลองแบบตรงตัวก่อน ถ้าไม่เจอค่อยหาแบบมีคำนั้นอยู่ข้างใน (ค้นด้วยชื่อคนได้โดยไม่ต้องรู้รหัส)
 */
function findValue(rows, needle) {
  const target = str(needle).toLowerCase();
  const scan = (test) => {
    const hits = new Map(); // คอลัมน์ -> จำนวนครั้งที่เจอ
    const rowsFound = [];
    for (let i = 0; i < rows.length; i++) {
      let hitInRow = false;
      for (let j = 0; j < rows[i].length; j++) {
        if (test(str(rows[i][j]).toLowerCase())) {
          hits.set(j, (hits.get(j) || 0) + 1);
          hitInRow = true;
        }
      }
      if (hitInRow) rowsFound.push(i);
    }
    return { hits, rowsFound };
  };

  const exact = scan((v) => v === target);
  if (exact.hits.size > 0) return { ...exact, mode: 'ตรงตัว' };
  return { ...scan((v) => v !== '' && v.includes(target)), mode: 'มีคำนี้อยู่ข้างใน' };
}

/**
 * ตัดคำนำหน้าและช่องว่างซ้ำออก เพื่อเทียบชื่อข้ามสองชีท
 * ชีทลงตารางงานเขียน "นาย นัตพล  ศรีบุญเรือง" (เว้นวรรคสองครั้ง)
 * ชีทพนักงานเขียน "นาย THIHA ZAW" — ต้องล้างให้เหลือรูปเดียวกันก่อนเทียบ
 */
function normName(v) {
  return str(v)
    .replace(/^(นาย|นาง\s*สาว|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** โหมด --inspect: พิมพ์แถวแรกๆ ของชีทออกมาดิบๆ พร้อมชื่อคอลัมน์ ไว้ดูโครงสร้างจริง */
function dumpRows(rows, count = 6) {
  for (let i = 0; i < Math.min(rows.length, count); i++) {
    const cells = rows[i]
      .map((v, idx) => (str(v) === '' ? null : `${colName(idx)}="${str(v)}"`))
      .filter(Boolean);
    console.log(`  แถว ${i + 1}: ${cells.length ? cells.join(' | ') : '(ว่างทั้งแถว)'}`);
  }
  console.log(`  ...รวมทั้งหมด ${rows.length} แถว`);
}

/** ชื่อคอลัมน์แบบ A, B, ... Z, AA ไว้แสดงตอนรายงานว่าจับคอลัมน์ไหนได้ */
function colName(i) {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

/**
 * จับคอลัมน์จาก "ชื่อหัวตาราง" แทนการนับตำแหน่งตายตัว
 * ชีทพนักงานถูกเปลี่ยนไฟล์มาแล้วครั้งหนึ่ง การนับตำแหน่งจึงเชื่อไม่ได้อีก
 * ถ้าหาหัวคอลัมน์ไม่เจอ ค่อยถอยไปใช้ตำแหน่งเดิมของ Apps Script (fallback)
 */
function mapColumns(headers, defs) {
  const used = new Set();
  const map = {};
  const report = [];
  for (const def of defs) {
    let found = -1;
    // match เป็นลิสต์เรียงตามลำดับความสำคัญ — ลองแบบเจาะจงก่อน ค่อยลงมาแบบกว้าง
    // (เช่นคอลัมน์รหัส ต้องเลือก "รหัสพนักงาน" ก่อน "รหัส POS" ซึ่งเป็นคนละรหัสกัน)
    for (const pattern of def.match) {
      for (let i = 0; i < headers.length; i++) {
        if (used.has(i) || !headers[i]) continue;
        if (pattern.test(headers[i]) && !(def.avoid && def.avoid.test(headers[i]))) {
          found = i;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found >= 0) {
      used.add(found);
      map[def.key] = found;
      report.push(`  ${def.key.padEnd(11)} <- ${colName(found)} "${headers[found]}"`);
    } else {
      map[def.key] = def.fallback;
      report.push(`  ${def.key.padEnd(11)} <- ${colName(def.fallback)} (ไม่พบหัวคอลัมน์ ใช้ตำแหน่งเดิม)`);
    }
  }
  return { map, report };
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

/* ชีทพนักงานเปลี่ยนไฟล์มาแล้วครั้งหนึ่ง ตำแหน่งคอลัมน์จึงเชื่อไม่ได้
   จับจากชื่อหัวตารางก่อน ไม่เจอค่อยถอยไปใช้ตำแหน่งเดิมของ Apps Script */
const EMP_COLUMNS = [
  // รหัสตัวนี้ต้องเป็นรหัสเดียวกับคอลัมน์ D ("รหัส HR") ของชีทลงตารางงาน
  // ชีทมี "รหัส POS" กับ "รหัสทางเงินเดือน" ปนอยู่ ซึ่งเป็นคนละรหัสกัน จึงกันไว้ใน avoid
  { key: 'hrCode',     match: [/รหัส\s*hr/i, /รหัส.*พนักงาน/, /^รหัส$/, /^hr.?code$/i],
    avoid: /สาขา|บัตร|ผ่าน|pos|ประชาชน|เงินเดือน|ภาษี|โลก้า/i, fallback: 2 },
  { key: 'branch',     match: [/^สาขา$/, /^สังกัด$/, /สาขา|สังกัด/],  fallback: 4 },
  { key: 'name',       match: [/ชื่อ.*สกุล/, /ชื่อ/],                 avoid: /สาขา|เล่น|ผู้|บัญชี/, fallback: 3 },
  { key: 'empType',    match: [/^ประเภท$/, /ประเภท/],                 avoid: /ภาษี|ยื่น/, fallback: 5 },
  // หัวคอลัมน์สถานะในชีทนี้ชื่อ "การทำงาน" — ห้าม match กว้างๆ ว่า /ทำงาน/
  // เพราะมีหัวกลุ่มชื่อ "ทำงาน" (สถิติการมาทำงาน) อยู่อีกฝั่งของชีท
  { key: 'status',     match: [/^การทำงาน$/, /^สถานะ$/, /สถานะ/],     avoid: /สมรส/, fallback: 6 },
  { key: 'position',   match: [/ตำแหน่ง/],                            fallback: 8 },
  { key: 'dailyWage',  match: [/ค่าแรง.*วัน/, /ค่าจ้าง.*วัน/, /เรทรายวัน/, /ค่าแรง/, /ค่าจ้าง/],
    avoid: /เดือน|รวม|ล่วงเวลา/, fallback: 9 },
  { key: 'resignDate', match: [/ลาออก/, /วันที่ออก/, /วันสุดท้าย/],   fallback: 14 },
];

async function migrateEmployees() {
  console.log('\n[1/2] พนักงาน');
  const all = await fetchSheetRows(SOURCE_SPREADSHEET_ID, EMP_SHEET, EMP_GID);

  // หาแถวหัวตารางจริง (ชีทนี้มีหัวรวมกลุ่มสองชั้น แถวแรกเป็นชื่อกลุ่ม ไม่ใช่ชื่อคอลัมน์)
  const picked = HEADER_ROW > 0 ? { row: HEADER_ROW - 1, score: -1 } : pickHeaderRow(all, EMP_COLUMNS);
  if (picked.row < 0) {
    console.log('  หาแถวหัวตารางไม่เจอเลย — ลองดูโครงสร้างชีทด้วย --inspect');
    dumpRows(all);
    throw new Error('อ่านชีทพนักงานไม่ได้: หาแถวหัวตารางไม่เจอ');
  }

  const headers = all[picked.row].map(str);
  const rows = all.slice(picked.row + 1);
  console.log(`  ใช้แถวที่ ${picked.row + 1} เป็นหัวตาราง${picked.score >= 0 ? ` (ตรงกับที่ต้องการ ${picked.score}/${EMP_COLUMNS.length} คอลัมน์)` : ' (สั่งมาเองด้วย --header-row)'}`);
  console.log('  หัวคอลัมน์:', headers.filter(Boolean).join(' | ') || '(ไม่มี)');

  const { map, report } = mapColumns(headers, EMP_COLUMNS);
  const notes = verifyColumns(map, rows, EMP_COLUMNS);
  console.log('  จับคอลัมน์ได้ดังนี้ — ตรวจให้ตรงก่อนย้ายจริง');
  report.forEach((line) => console.log(line));
  if (notes.length) {
    console.log('  ปรับให้อัตโนมัติเพราะคอลัมน์ที่จับได้ไม่มีข้อมูล:');
    notes.forEach((line) => console.log(line));
  }

  const byCode = new Map();
  for (const r of rows) {
    const hrCode = str(r[map.hrCode]);
    const name = str(r[map.name]);
    if (!hrCode || !name) continue;
    byCode.set(hrCode, {
      hrCode,
      name,
      branch: str(r[map.branch]),
      empType: str(r[map.empType]),
      status: str(r[map.status]) || 'ทำงาน',
      position: str(r[map.position]),
      dailyWage: num(r[map.dailyWage]),
      resignDate: toDateKey(r[map.resignDate]),
    });
  }
  const data = [...byCode.values()];
  if (data.length === 0) {
    console.log('  อ่านได้ 0 คน — คอลัมน์ที่จับได้อาจไม่ตรง หรือชี้ผิดแท็บ');
    console.log('  ข้อมูล 6 แถวแรกของชีท (ไว้ตรวจว่าคอลัมน์ไหนคืออะไร):');
    dumpRows(all);
  } else {
    console.log(`  ตัวอย่างคนแรกที่อ่านได้: ${JSON.stringify(data[0])}`);
  }
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

  // รายชื่อสาขามาจากพนักงานล้วนๆ (ชีท Details เลิกใช้แล้ว)
  // เป้าขาย/ค่าแรงสูงสุดจึงเป็น 0 ไปก่อน ต้องกรอกเองด้วย UPDATE dbo.hr_branch
  const branches = [...new Set(data.map((d) => d.branch).filter(Boolean))].sort();
  console.log(`  พบสาขา ${branches.length} สาขา: ${branches.join(', ') || '(ไม่มี)'}`);
  await runBatch('สาขา', branches.map((b) => ({ branch: b })), (row) => ({
    text: `IF NOT EXISTS (SELECT 1 FROM dbo.hr_branch WHERE branch = @branch)
             INSERT INTO dbo.hr_branch (branch, branch_name) VALUES (@branch, @branch);`,
    params: { branch: { type: sql.NVarChar(50), value: row.branch } },
  }));
}

// ชีท "ลงตารางงาน" — คอลัมน์ A..V ตามที่ Apps Script เดิมเขียนไว้
//  A Timestamp | B วันที่ลงงาน | C สาขา | D รหัส HR | E ชื่อ | F ตำแหน่ง | G เข้า | H ออก
//  I เบรค | J OT | K ค่าแรง | L สถานะ | M ลา(รับค่าแรง) | N ประเภท | O หยุด(ไม่รับค่าแรง)
//  P ชั่วโมงสะสม | Q ลารายชั่วโมง | R หมายเหตุ | S ช่วงเบรค | T จุดปฏิบัติงาน | U ผู้อนุมัติ OT | V ใช้ชั่วโมงสะสม
// ชีทนี้ Apps Script เป็นคนเขียนเองทั้งหมด ลำดับคอลัมน์จึงคงที่ ใช้ตำแหน่งตรงๆ ได้
async function migrateTimesheet() {
  console.log(`\n[2/2] ตารางงาน (ย้อนหลัง ${MONTHS} เดือน ตั้งแต่ ${fmtDate(cutoff)})`);
  const all = await fetchSheetRows(DESTINATION_SPREADSHEET_ID, LOG_SHEET_NAME, LOG_GID);

  // ชีทนี้ Apps Script เขียนเอง หัวตารางเป็นแถวเดียวและขึ้นต้นด้วย Timestamp เสมอ
  const hasHeader = all.length > 0 && /timestamp|วันที่ลงงาน/i.test(str(all[0][0]) + str(all[0][1]));
  const rows = hasHeader ? all.slice(1) : all;
  console.log(`  หัวตาราง: ${hasHeader ? all[0].map(str).filter(Boolean).join(' | ') : '(ไม่มีแถวหัว อ่านทุกแถวเป็นข้อมูล)'}`);

  // ชีทเป็น log ต่อท้าย — เก็บเฉพาะแถวล่าสุดของแต่ละ (วันที่, สาขา, รหัส) เหมือนที่ Apps Script อ่าน
  const latest = new Map();
  let skippedOld = 0;
  let cleared = 0;

  for (const r of rows) {
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

  console.log(`  อ่านจากชีท ${rows.length} แถว | เก่ากว่ากำหนด ${skippedOld} | ถูกล้างไปแล้ว ${cleared}`);
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
  // โหมดวิเคราะห์รหัส: รหัสในชีทลงตารางงานไม่มีในชีทพนักงานเลย (คนละชุดกัน)
  // โหมดนี้ตอบสองคำถาม — คอลัมน์ไหนใช้เป็นรหัสประจำตัวได้ และเชื่อมสองชีทด้วยชื่อได้กี่ %
  if (KEYS) {
    const all = await fetchSheetRows(SOURCE_SPREADSHEET_ID, EMP_SHEET, EMP_GID);
    const picked = pickHeaderRow(all, EMP_COLUMNS);
    const headers = all[picked.row].map(str);
    const rows = all.slice(picked.row + 1);
    const { map } = mapColumns(headers, EMP_COLUMNS);
    verifyColumns(map, rows, EMP_COLUMNS);

    const staff = rows.filter((r) => str(r[map.name]) !== '');
    const working = staff.filter((r) => str(r[map.status]) === 'ทำงาน');
    console.log(`[ชีทพนักงาน] มีชื่อ ${staff.length} คน | สถานะ "ทำงาน" ${working.length} คน`);

    // 1) คอลัมน์ไหนกรอกครบและไม่ซ้ำ = ใช้เป็นรหัสประจำตัวได้
    console.log('\n— คอลัมน์ที่ใช้เป็นรหัสประจำตัวได้ (กรอกครบ + ไม่ซ้ำกันเลย) —');
    const width = Math.max(...staff.map((r) => r.length));
    let found = 0;
    for (let c = 0; c < width; c++) {
      const vals = staff.map((r) => str(r[c])).filter(Boolean);
      const uniq = new Set(vals).size;
      const filledPct = Math.round((vals.length / staff.length) * 100);
      if (filledPct < 90 || uniq !== vals.length) continue;
      if (vals.some((v) => v.length > 24 || /\s/.test(v))) continue; // ตัดคอลัมน์ที่เป็นข้อความยาว
      found++;
      console.log(`  ${colName(c).padEnd(3)} "${(headers[c] || '(ไม่มีหัวตาราง)').slice(0, 24)}" — กรอก ${filledPct}% ไม่ซ้ำ ${uniq} ค่า | ตัวอย่าง: ${vals.slice(0, 3).join(', ')}`);
    }
    if (!found) console.log('  ไม่มีคอลัมน์ไหนที่กรอกครบและไม่ซ้ำเลย');

    // 2) เชื่อมด้วยชื่อ+สาขาได้กี่ % — ถ้าสูงพอ ใช้ชื่อเป็นสะพานตอนย้ายได้
    const empByName = new Map();
    for (const r of staff) {
      empByName.set(`${str(r[map.branch]).toLowerCase()}|${normName(r[map.name])}`, r);
    }
    const ts = await fetchSheetRows(DESTINATION_SPREADSHEET_ID, LOG_SHEET_NAME, LOG_GID);
    const tsRows = /timestamp|วันที่ลงงาน/i.test(str(ts[0]?.[0]) + str(ts[0]?.[1])) ? ts.slice(1) : ts;
    const people = new Map(); // สาขา|ชื่อ -> รหัสในชีทตารางงาน
    for (const r of tsRows) {
      const branch = str(r[2]);
      const name = str(r[4]);
      if (!branch || !name) continue;
      people.set(`${branch.toLowerCase()}|${normName(name)}`, str(r[3]));
    }
    const matched = [...people.keys()].filter((k) => empByName.has(k));
    const missing = [...people.keys()].filter((k) => !empByName.has(k));
    console.log(`\n— เชื่อมสองชีทด้วย "สาขา + ชื่อ" —`);
    console.log(`  ชีทลงตารางงานมีพนักงาน ${people.size} คน (จาก ${tsRows.length} แถว)`);
    console.log(`  จับคู่กับชีทพนักงานได้ ${matched.length} คน (${Math.round((matched.length / people.size) * 100)}%)`);
    if (missing.length) {
      console.log(`  จับคู่ไม่ได้ ${missing.length} คน เช่น:`);
      missing.slice(0, 10).forEach((k) => console.log(`    ${k.split('|')[0].toUpperCase()} : ${k.split('|')[1]}`));
    }
    return;
  }

  // โหมดหาค่า: บอกว่าค่าที่ระบุอยู่คอลัมน์ไหนของชีทพนักงาน
  // ใช้ยืนยันว่า "รหัส HR" ในชีทลงตารางงาน ตรงกับคอลัมน์ไหนของชีทพนักงานกันแน่
  if (FIND) {
    const needles = FIND.split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await fetchSheetRows(SOURCE_SPREADSHEET_ID, EMP_SHEET, EMP_GID);
    console.log(`[หาค่าในชีทพนักงาน] ${rows.length} แถว`);
    for (const needle of needles) {
      const { hits, rowsFound, mode } = findValue(rows, needle);
      if (hits.size === 0) {
        console.log(`\n  "${needle}" : ไม่พบในชีทพนักงานเลย`);
        continue;
      }
      const where = [...hits.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([col, n]) => `${colName(col)} (${n} ครั้ง)`)
        .join(', ');
      console.log(`\n  "${needle}" : เจอแบบ${mode} ที่คอลัมน์ ${where}`);
      console.log(`  แสดง ${Math.min(rowsFound.length, 3)} จาก ${rowsFound.length} แถวที่เจอ:`);
      dumpRows(rowsFound.slice(0, 3).map((i) => rows[i]), 3);
    }
    return;
  }

  // โหมดส่องชีท: พิมพ์แถวแรกๆ ออกมาดิบๆ ไว้ดูว่าคอลัมน์ไหนคืออะไร
  // ไม่แตะฐานข้อมูลเลย จึงไม่ต้องมีรหัสผ่านและไม่ต้อง npm install ก่อน
  if (INSPECT) {
    const via = USE_CSV ? 'export CSV' : 'gviz';
    console.log(`ดึงข้อมูลผ่าน: ${via}`);
    console.log(`\n[ส่องชีทพนักงาน] ${SOURCE_SPREADSHEET_ID}${EMP_GID ? ` gid=${EMP_GID}` : EMP_SHEET ? ` แท็บ "${EMP_SHEET}"` : ' (แท็บแรก)'}`);
    dumpRows(await fetchSheetRows(SOURCE_SPREADSHEET_ID, EMP_SHEET, EMP_GID), 8);
    console.log(`\n[ส่องชีทลงตารางงาน] ${LOG_GID ? `gid=${LOG_GID}` : `แท็บ "${LOG_SHEET_NAME}"`}`);
    dumpRows(await fetchSheetRows(DESTINATION_SPREADSHEET_ID, LOG_SHEET_NAME, LOG_GID), 3);

    // เทียบจำนวนแถวสองช่องทาง — ถ้า CSV ได้มากกว่ามาก แปลว่าชีทมีตัวกรองเปิดค้างอยู่
    // แล้ว gviz เห็นแค่แถวที่ผ่านตัวกรอง ถ้าย้ายตามนั้นข้อมูลจะหายโดยไม่มีอะไรฟ้อง
    if (LOG_GID) {
      console.log('\n[เทียบจำนวนแถวของแท็บลงตารางงาน]');
      const counts = {};
      for (const [name, fn] of [['gviz', () => fetchRows(DESTINATION_SPREADSHEET_ID, LOG_SHEET_NAME, LOG_GID)], ['export CSV', () => fetchRowsCsv(DESTINATION_SPREADSHEET_ID, LOG_GID)]]) {
        try {
          counts[name] = (await fn()).length;
          console.log(`  ${name.padEnd(11)} : ${counts[name]} แถว`);
        } catch (err) {
          console.log(`  ${name.padEnd(11)} : ดึงไม่ได้ (${err.message})`);
        }
      }
      if (counts.gviz && counts['export CSV'] && counts['export CSV'] > counts.gviz * 1.2) {
        console.log(`  => ชีทมีตัวกรองเปิดค้างอยู่ gviz เห็นไม่ครบ ให้ใส่ --csv ตอนย้ายจริงเสมอ`);
      }
    } else {
      console.log('\n(ใส่ --log-gid=<เลข gid ของแท็บลงตารางงาน> เพื่อเทียบจำนวนแถวสองช่องทาง)');
    }

    console.log('\nดูโครงสร้างเสร็จแล้ว (ไม่ได้แตะฐานข้อมูล)');
    return;
  }

  console.log(`ย้ายข้อมูลตารางงาน -> ${process.env.HR_DB_HOST || '203.154.185.48'}/${process.env.HR_DB_NAME || 'narai_hr'}`);
  if (DRY_RUN) console.log('โหมด dry-run: อ่านชีทและสรุปผลเท่านั้น ไม่เขียนลงฐานข้อมูล');

  // ต่อฐานข้อมูลให้พังตั้งแต่ต้นถ้าต่อไม่ได้ จะได้ไม่เสียเวลาอ่านชีท
  if (!DRY_RUN) {
    if (!process.env.HR_DB_USER || !process.env.HR_DB_PASSWORD) {
      throw new Error('ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD');
    }
    await loadDb();
    await getPool();
  }

  // พนักงานต้องมาก่อนตารางงานเสมอ (รายชื่อสาขาถูกสร้างจากพนักงาน)
  if (wants('employees')) await migrateEmployees();
  if (wants('timesheet')) await migrateTimesheet();

  console.log('\nเสร็จเรียบร้อย');
}

main()
  .then(() => closePool?.())
  .catch(async (err) => {
    console.error('\nย้ายข้อมูลไม่สำเร็จ:', describeDbError(err));
    if (process.env.DEBUG) console.error(err);
    await closePool?.();
    process.exitCode = 1;
  });
