#!/usr/bin/env node
/**
 * ย้ายข้อมูลฝั่งสต๊อกจาก Google Sheets เข้า SQL Server (ฐานข้อมูล InventoryNarai)
 *
 * อ่านชีทอย่างเดียว ไม่ได้แก้อะไรที่ต้นทางเลย ชีทยังเป็นตัวจริงอยู่จนกว่าจะย้าย action ตามมา
 * ทำหน้าที่แค่ "เอาของเข้าฐานข้อมูลให้ครบและตรวจสอบได้ก่อน"
 *
 * วิธีใช้ (รันจากโฟลเดอร์รีโป บนเครื่องที่ต่อ SQL Server ได้)
 *   1) สร้างตารางก่อน:
 *        sqlcmd -S localhost -U narai_web -P "<รหัสผ่าน>" -i docs\schema-inventory.sql
 *   2) ตรวจว่าจับคอลัมน์ถูกไหม (ไม่แตะฐานข้อมูล):
 *        node scripts/migrate-inventory.mjs --inspect=item
 *   3) นับแถวก่อนย้ายจริง (ไม่เขียนอะไร):
 *        node scripts/migrate-inventory.mjs --dry-run
 *   4) ย้ายจริง:
 *        node scripts/migrate-inventory.mjs --user narai_web --pass "<รหัสผ่าน>"
 *
 * ตัวเลือก
 *   --dry-run          อ่านชีทและนับแถวอย่างเดียว ไม่ต่อฐานข้อมูล ไม่เขียนอะไร
 *   --inspect=<key>    พิมพ์แถวดิบ 3 แถวแรกกับผลที่แปลงได้ ไว้ตรวจว่าจับคอลัมน์ตรงไหม
 *   --only=item,count  ย้ายเฉพาะบางชุด (ดูรหัสชุดได้จาก --list)
 *   --list             แสดงรายชื่อชุดข้อมูลทั้งหมดแล้วจบ
 *   --replace          ตารางไหนมีข้อมูลอยู่แล้วให้ล้างทิ้งก่อนเขียนใหม่
 *                      (ไม่ใส่ = ข้ามตารางนั้นไป กันเขียนซ้ำโดยไม่ตั้งใจ)
 *   --host / --port / --db / --user / --pass   ปลายทาง (ค่าเริ่มต้น localhost:1433/InventoryNarai)
 *   --gid-<key>=123    ระบุ gid ของแท็บเอง เมื่อชื่อแท็บไม่ตรงหรือชีทมีตัวกรองเปิดค้างไว้
 *
 * ข้อควรรู้
 * - ชีททุกไฟล์ต้องตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" ก่อน (อ่านแบบไม่ล็อกอิน)
 *   ถ้าไม่เปิดจะได้ HTML หน้า login กลับมาแทนข้อมูล สคริปต์จะแจ้งให้เอง
 * - ชุดไหนที่รู้ gid จะดึงผ่าน export CSV เพราะ "ไม่สนใจตัวกรองที่เปิดค้างไว้ในชีท"
 *   ส่วนชุดที่รู้แค่ชื่อแท็บต้องใช้ gviz ซึ่งโดนตัวกรองบังข้อมูลได้ (เคยเจอมาแล้วตอนย้ายตารางงาน
 *   gviz คืนมา 496 แถวจากหมื่นกว่าแถว) ถ้าจำนวนแถวดูน้อยผิดปกติให้หา gid มาใส่ด้วย --gid-<key>=
 * - รหัสสินค้าในชีทปนกันทั้งตัวเลขและข้อความ (5001 กับ '05001') ทุกตารางจึงมี item_code_norm
 *   ที่ตัด 0 นำหน้าแล้ว ใช้ join แทน — กติกาเดียวกับ normalizeId ใน apps-script.js
 * - ชุดที่มีคีย์ (รายการสินค้า/ยอดยกมา/หมวดจัดเก็บ/ค่าเฉลี่ยต่อหัว/ราคากลาง) ถ้าชีทมีแถวซ้ำคีย์เดียวกัน
 *   จะเก็บ "แถวล่างสุด" ไว้ (ตีความว่าใหม่กว่า) แล้วรายงานให้ดูว่ายุบไปกี่แถว
 */

import process from 'node:process';
import sql from 'mssql';

/* ------------------------------ อ่านตัวเลือก ------------------------------ */

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const val = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
};

const DRY_RUN = has('dry-run');
const REPLACE = has('replace');
const LIST = has('list');
const INSPECT = val('inspect', '');

const DB = {
  host: val('host', process.env.INV_DB_HOST || 'localhost'),
  port: Number(val('port', process.env.INV_DB_PORT || 1433)) || 1433,
  database: val('db', process.env.INV_DB_NAME || 'InventoryNarai'),
  user: val('user', process.env.INV_DB_USER || process.env.HR_DB_USER || ''),
  password: val('pass', process.env.INV_DB_PASSWORD || process.env.HR_DB_PASSWORD || ''),
};

/* --------------------------- ไอดีสเปรดชีตต้นทาง ---------------------------
   ยกมาจาก apps-script.js ตรงๆ (ตัวเลขบรรทัดอ้างอิงในคอมเมนต์ของแต่ละชุดด้านล่าง) */
const SS_STOCK = '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ'; // ไฟล์สต๊อก
const SS_ITEM = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw';  // ไฟล์ BOM (แท็บ item)
const SS_STORE = '1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI'; // ไฟล์จัดของ/รับของ
const SS_SUP = '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';   // ไฟล์ต้นทุนจาก supplier
const SS_SALES = '1kxVqX_hp5B0YTNSPj7mhyFl1OLbnhN-dIWm9ywzHA60'; // ไฟล์ยอดขาย/เป้าหมาย

/* ------------------------------ ตัวช่วยแปลงค่า ------------------------------ */

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const pad = (n) => String(n).padStart(2, '0');

/** ตัด 0 นำหน้าออก + ตัวพิมพ์เล็ก — กติกาเดียวกับ normalizeId() ใน apps-script.js */
const normId = (v) => str(v).replace(/^0+/, '').toLowerCase();

/** รหัสสินค้าที่เก็บดิบ — ตัด .0 ท้ายที่ติดมาจากการอ่านเป็นตัวเลข */
const codeText = (v) => str(v).replace(/\.0+$/, '');

const num = (v) => {
  const s = str(v).replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** จำนวนแถวที่แปลงวันที่ไม่ได้ นับไว้รายงานท้ายชุด */
let badDates = 0;

/**
 * รับได้ทั้ง 'dd/MM/yyyy HH:mm(:ss)', 'yyyy-MM-dd HH:mm(:ss)' และ ISO
 * คืนเป็นข้อความ 'YYYY-MM-DD HH:mm:ss' (ไม่แปลง timezone — ชีทเก็บเวลาไทยอยู่แล้ว)
 */
function toDateTime(v) {
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])} ${pad(+(m[4] || 0))}:${pad(+(m[5] || 0))}:${pad(+(m[6] || 0))}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])} ${pad(+(m[4] || 0))}:${pad(+(m[5] || 0))}:${pad(+(m[6] || 0))}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  badDates++;
  return null;
}

/** เอาเฉพาะวันที่ 'YYYY-MM-DD' */
function toDate(v) {
  const dt = toDateTime(v);
  return dt ? dt.slice(0, 10) : null;
}

const boolTrue = (v) => /^(true|ture|1|yes|y)$/i.test(str(v)); // 'ture' คือคำที่พิมพ์ผิดไว้ในชีทจริง

/* ------------------------------- อ่านชีท ------------------------------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
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

async function fetchCsv(spreadsheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  if (/^\s*</.test(text)) {
    throw new Error(`ดึง CSV ไม่ได้ (gid=${gid}) — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`);
  }
  return parseCsv(text);
}

async function fetchGviz(spreadsheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&headers=0&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) {
    throw new Error(`อ่านชีท "${sheetName}" ไม่ได้ — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`);
  }
  const json = JSON.parse(text.slice(start, end + 1));
  const cols = json.table.cols || [];
  return (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      if (!cell) return '';
      if (typeof cell.v === 'string') {
        // gviz ส่งวันที่มาเป็นข้อความ "Date(2026,5,21,14,30,0)" (เดือนเริ่มที่ 0)
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
        if (m) {
          const [, y, mo, d, h, mi, s] = m;
          const date = `${y}-${pad(+mo + 1)}-${pad(+d)}`;
          return h === undefined ? date : `${date} ${pad(+h)}:${pad(+mi)}:${pad(+(s || 0))}`;
        }
      }
      if (cell.v === null || cell.v === undefined) return '';
      return cell.v;
    })
  );
}

/** ดึงแถวของชุดนั้น — รู้ gid ใช้ CSV (ไม่โดนตัวกรองบัง) ไม่รู้ก็ใช้ gviz ตามชื่อแท็บ */
async function fetchRows(src) {
  const gid = val(`gid-${src.key}`, src.gid);
  const rows = gid !== undefined && gid !== null && gid !== ''
    ? await fetchCsv(src.ss, gid)
    : await fetchGviz(src.ss, src.sheet);
  return rows.slice(src.headerRows === undefined ? 1 : src.headerRows); // ตัดหัวตารางออก
}

/* ------------------------------ ชุดข้อมูล ------------------------------
   คอลัมน์ทุกชุดถอดมาจาก apps-script.js โดยตรง (เลขในวงเล็บคือ index ของคอลัมน์ในชีท) */

const T = {
  code: sql.NVarChar(50),
  name: sql.NVarChar(255),
  short: sql.NVarChar(50),
  person: sql.NVarChar(150),
  cat: sql.NVarChar(100),
  qty: sql.Decimal(18, 3),
  money: sql.Decimal(18, 4),
  dt: sql.DateTime2(0),
  date: sql.Date,
  int: sql.Int,
  bit: sql.Bit,
  note: sql.NVarChar(500),
  url: sql.NVarChar(1000),
  branches: sql.NVarChar(500),
  pct: sql.Decimal(9, 4),
};

const SOURCES = [
  {
    key: 'item',
    label: 'รายการสินค้า (แท็บ item)',
    table: 'inv_item',
    ss: SS_ITEM, sheet: 'item',
    unique: ['item_code'],
    cols: {
      item_code: T.code, item_code_norm: T.code, item_name: T.name, price: T.money,
      unit: T.short, status: T.short, branches: T.branches, pos_item_id: T.code,
      order_unit: T.short, store_cat: T.cat, plan_only: T.bit,
    },
    // A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ J(9)=สาขาที่ใช้ K(10)=itemid L(11)=หน่วยเบิก N(13)=หมวดสโตร์ O(14)=Plan
    map: (r) => (!str(r[0]) && !str(r[1]) ? null : {
      item_code: codeText(r[0]), item_code_norm: normId(r[0]), item_name: str(r[1]), price: num(r[2]),
      unit: str(r[3]), status: str(r[4]), branches: str(r[9]), pos_item_id: str(r[10]),
      order_unit: str(r[11]), store_cat: str(r[13]), plan_only: boolTrue(r[14]) ? 1 : 0,
    }),
  },
  {
    key: 'item-branch',
    label: 'สาขาที่ใช้สินค้าแต่ละตัว (แตกจากคอลัมน์ J ของแท็บ item)',
    table: 'inv_item_branch',
    ss: SS_ITEM, sheet: 'item',
    unique: ['branch', 'item_code'],
    cols: { item_code: T.code, branch: T.short },
    // แถวเดียวในชีทกลายเป็นหลายแถวในตาราง จึงคืนเป็นอาร์เรย์
    expand: (r) => {
      const code = codeText(r[0]);
      if (!code) return [];
      return String(r[9] == null ? '' : r[9])
        .split(/[,\s]+/).map((b) => b.trim().toLowerCase()).filter(Boolean)
        .map((branch) => ({ item_code: code, branch }));
    },
  },
  {
    key: 'price',
    label: 'ราคากลาง (แท็บ 8.2)',
    table: 'inv_price',
    ss: SS_STOCK, sheet: '8.2',
    unique: ['item_code'],
    cols: { item_code: T.code, item_code_norm: T.code, item_name: T.name, unit_price: T.money },
    // [0]รหัส [1]ชื่อ [2]ราคา
    map: (r) => (!str(r[0]) ? null : {
      item_code: codeText(r[0]), item_code_norm: normId(r[0]), item_name: str(r[1]), unit_price: num(r[2]),
    }),
  },
  {
    key: 'count',
    label: 'ข้อมูลนับสตอค',
    table: 'inv_stock_count',
    ss: SS_STOCK, sheet: 'ข้อมูลนับสตอค', gid: '923363118',
    cols: {
      counted_at: T.dt, counter_name: T.person, branch: T.short, item_code: T.code,
      item_code_norm: T.code, item_name: T.name, unit: T.short, remaining: T.qty,
    },
    // วันที่ลงข้อมูล | ชื่อพนักงานนับสต๊อก | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | จำนวนคงเหลือ
    map: (r) => (!str(r[2]) && !str(r[3]) ? null : {
      counted_at: toDateTime(r[0]), counter_name: str(r[1]), branch: str(r[2]).toLowerCase(),
      item_code: codeText(r[3]), item_code_norm: normId(r[3]), item_name: str(r[4]),
      unit: str(r[5]), remaining: num(r[6]),
    }),
  },
  {
    key: 'balance',
    label: 'ยอดยกมา',
    table: 'inv_balance',
    ss: SS_STOCK, sheet: 'ยอดยกมา',
    unique: ['branch', 'item_code_norm'],
    cols: { branch: T.short, item_code_norm: T.code, item_code: T.code, item_name: T.name, balance: T.qty, updated_at: T.dt },
    // รหัสสินค้า | ชื่อสินค้า | สาขา | ยอดยกมา | วันที่อัปเดต
    map: (r) => (!str(r[0]) || !str(r[2]) ? null : {
      branch: str(r[2]).toLowerCase(), item_code_norm: normId(r[0]), item_code: codeText(r[0]),
      item_name: str(r[1]), balance: num(r[3]), updated_at: toDateTime(r[4]),
    }),
  },
  {
    key: 'request',
    label: 'ข้อมูลเบิก',
    table: 'inv_request',
    ss: SS_STOCK, sheet: 'ข้อมูลเบิก',
    cols: {
      req_no: T.code, saved_at: T.dt, item_code: T.code, item_code_norm: T.code, item_name: T.name,
      unit: T.short, qty: T.qty, request_date: T.date, requester: T.person, branch: T.short,
    },
    // เลขที่ใบเบิก | วันที่เวลาบันทึก | รหัส | ชื่อ | หน่วย | จำนวน | วันที่เบิก | ชื่อผู้เบิก | สาขา
    map: (r) => {
      // สาขาบางแถวว่าง ต้องถอดจากคำนำหน้าเลขที่ใบเบิก (CRM-2605-0001 -> crm) เหมือนที่ Apps Script ทำ
      let branch = str(r[8]).toLowerCase();
      if (!branch && str(r[0])) branch = str(r[0]).slice(0, 3).toLowerCase();
      if (!str(r[2]) && !branch) return null;
      return {
        req_no: str(r[0]), saved_at: toDateTime(r[1]), item_code: codeText(r[2]), item_code_norm: normId(r[2]),
        item_name: str(r[3]), unit: str(r[4]), qty: num(r[5]), request_date: toDate(r[6]),
        requester: str(r[7]), branch,
      };
    },
  },
  {
    key: 'storage-cat',
    label: 'หมวดจัดเก็บสาขา',
    table: 'inv_storage_category',
    ss: SS_STOCK, sheet: 'หมวดจัดเก็บสาขา',
    unique: ['branch', 'item_code_norm'],
    cols: { branch: T.short, item_code_norm: T.code, item_code: T.code, item_name: T.name, category: T.cat },
    // รหัสสินค้า | ชื่อสินค้า | สาขา | หมวดจัดเก็บ
    map: (r) => (!str(r[0]) || !str(r[2]) ? null : {
      branch: str(r[2]).toLowerCase(), item_code_norm: normId(r[0]), item_code: codeText(r[0]),
      item_name: str(r[1]), category: str(r[3]),
    }),
  },
  {
    key: 'month-end',
    label: 'ปิดรอบสิ้นเดือน',
    table: 'inv_month_end',
    ss: SS_STOCK, sheet: 'ปิดรอบสิ้นเดือน',
    cols: {
      closing_date: T.date, branch: T.short, item_code: T.code, item_code_norm: T.code, item_name: T.name,
      unit: T.short, qty: T.qty, unit_value: T.money, total_value: T.money, recorder: T.person, saved_at: T.dt,
    },
    // วันที่ปิดยอด | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | ยอดคงเหลือสิ้นเดือน | มูลค่า/หน่วย | มูลค่ารวม | ผู้บันทึก | เวลาบันทึก
    map: (r) => (!str(r[1]) && !str(r[2]) ? null : {
      closing_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), item_code: codeText(r[2]),
      item_code_norm: normId(r[2]), item_name: str(r[3]), unit: str(r[4]), qty: num(r[5]),
      unit_value: num(r[6]), total_value: num(r[7]), recorder: str(r[8]), saved_at: toDateTime(r[9]),
    }),
  },
  {
    key: 'sup-cost',
    label: 'ต้นทุนจาก supplier',
    table: 'inv_sup_cost',
    ss: SS_SUP, sheet: 'ต้นทุนจากsup',
    cols: {
      cost_date: T.date, branch: T.short, item_code: T.code, item_code_norm: T.code, item_name: T.name,
      unit: T.short, qty: T.qty, unit_price: T.money, amount: T.money, recorder: T.person, saved_at: T.dt,
    },
    // วันที่ | สาขา | รหัส | ชื่อรายการ | หน่วย | จำนวน | ราคา/หน่วย | มูลค่ารวม | ผู้บันทึก | เวลาบันทึก
    map: (r) => (!str(r[1]) && !str(r[2]) ? null : {
      cost_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), item_code: codeText(r[2]),
      item_code_norm: normId(r[2]), item_name: str(r[3]), unit: str(r[4]), qty: num(r[5]),
      unit_price: num(r[6]), amount: num(r[7]), recorder: str(r[8]), saved_at: toDateTime(r[9]),
    }),
  },
  {
    key: 'waste',
    label: 'ของเสีย (WASTE)',
    table: 'inv_waste',
    ss: SS_STOCK, sheet: 'waste', gid: '1493705916',
    cols: {
      waste_date: T.date, branch: T.short, item_code: T.code, item_code_norm: T.code,
      item_name: T.name, unit: T.short, qty: T.qty, recorder: T.person, keyed_at: T.dt,
    },
    // วันที่ของเสีย | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | จำนวนที่เสีย | ผู้บันทึก | เวลาที่คีย์
    map: (r) => (!str(r[1]) && !str(r[2]) ? null : {
      waste_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), item_code: codeText(r[2]),
      item_code_norm: normId(r[2]), item_name: str(r[3]), unit: str(r[4]), qty: num(r[5]),
      recorder: str(r[6]), keyed_at: toDateTime(r[7]),
    }),
  },
  {
    key: 'plan-order',
    label: 'ใบสั่งแพลน/สั่งเพิ่มเติม (แท็บ plan)',
    table: 'inv_plan_order',
    ss: SS_STOCK, sheet: 'plan', gid: '571271047',
    cols: {
      order_date: T.date, saved_time: T.short, branch: T.short, outlet_id: T.code, order_no: T.code,
      seq: T.int, deliver_date: T.date, pos_item_id: T.code, item_code: T.code, item_code_norm: T.code,
      item_name: T.name, qty: T.qty, unit: T.short, unit_price: T.money, amount: T.money,
      order_type: T.short, recorder: T.person,
    },
    // วันที่สั่ง | เวลาบันทึก | สาขา | รหัสสาขา | เลขที่ใบสั่ง | ลำดับ | วันที่รับ | itemId |
    // รหัสสินค้า | ชื่อสินค้า | จำนวน | หน่วย | ราคา/หน่วย | มูลค่ารวม | ประเภท | ผู้บันทึก
    map: (r) => (!str(r[4]) && !str(r[8]) ? null : {
      order_date: toDate(r[0]), saved_time: str(r[1]), branch: str(r[2]).toLowerCase(), outlet_id: str(r[3]),
      order_no: str(r[4]), seq: num(r[5]), deliver_date: toDate(r[6]), pos_item_id: str(r[7]),
      item_code: codeText(r[8]), item_code_norm: normId(r[8]), item_name: str(r[9]), qty: num(r[10]),
      unit: str(r[11]), unit_price: num(r[12]), amount: num(r[13]), order_type: str(r[14]), recorder: str(r[15]),
    }),
  },
  {
    key: 'dispatch',
    label: 'จัดของ (ฝั่งโกดัง)',
    table: 'inv_dispatch',
    ss: SS_STORE, sheet: 'จัดของ', gid: '0',
    cols: {
      dispatch_date: T.date, branch: T.short, item_code: T.code, item_code_norm: T.code, item_name: T.name,
      qty_requested: T.qty, qty_sent: T.qty, order_no: T.code, store_status: T.short, saved_at: T.dt,
    },
    // A=วันที่ B=สาขา C=รหัส D=ชื่อ E=จำนวนเบิก F=จำนวนส่ง G=เลขที่ใบเบิก H=สถานะฝั่งstore I=เวลาบันทึก
    map: (r) => (!str(r[6]) ? null : {
      dispatch_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), item_code: codeText(r[2]),
      item_code_norm: normId(r[2]), item_name: str(r[3]), qty_requested: num(r[4]), qty_sent: num(r[5]),
      order_no: str(r[6]), store_status: str(r[7]), saved_at: toDateTime(r[8]),
    }),
  },
  {
    key: 'received',
    label: 'รับของ (สาขายืนยันรับ)',
    table: 'inv_goods_received',
    ss: SS_STORE, sheet: 'รับของ', gid: '1358423318',
    cols: {
      received_date: T.date, branch: T.short, order_no: T.code, item_code: T.code, item_code_norm: T.code,
      item_name: T.name, qty_requested: T.qty, qty_sent: T.qty, qty_received: T.qty, status: T.short,
      note: T.note, image_url: T.url, recorder: T.person, saved_at: T.dt,
    },
    // วันที่รับ | สาขา | เลขที่ใบเบิก | รหัส | ชื่อ | จำนวนเบิก | จำนวนส่ง | จำนวนที่รับจริง | สถานะ | หมายเหตุ | รูปภาพ | ผู้บันทึก | เวลาบันทึก
    map: (r) => (!str(r[2]) && !str(r[3]) ? null : {
      received_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), order_no: str(r[2]),
      item_code: codeText(r[3]), item_code_norm: normId(r[3]), item_name: str(r[4]),
      qty_requested: num(r[5]), qty_sent: num(r[6]), qty_received: num(r[7]), status: str(r[8]),
      note: str(r[9]).slice(0, 500), image_url: str(r[10]).slice(0, 1000), recorder: str(r[11]), saved_at: toDateTime(r[12]),
    }),
  },
  {
    key: 'order-cancel',
    label: 'ยกเลิกใบเบิก',
    table: 'inv_order_cancel',
    ss: SS_STORE, sheet: 'ยกเลิกใบเบิก', gid: '1431574396',
    cols: {
      order_date: T.date, branch: T.short, order_no: T.code, deliver_date: T.date,
      item_count: T.int, recorder: T.person, cancelled_at: T.dt,
    },
    // วันที่สั่ง | สาขา | เลขที่ใบเบิก | วันที่รับ | จำนวนรายการ | ผู้บันทึก | เวลาที่ยกเลิก
    map: (r) => (!str(r[2]) ? null : {
      order_date: toDate(r[0]), branch: str(r[1]).toLowerCase(), order_no: str(r[2]),
      deliver_date: toDate(r[3]), item_count: num(r[4]), recorder: str(r[5]), cancelled_at: toDateTime(r[6]),
    }),
  },
  {
    key: 'branch-percent',
    label: 'เปอร์เซ็นการเบิกของแต่ละสาขา',
    table: 'inv_branch_percent',
    ss: SS_SALES, sheet: 'เปอร์เซ็นการเบิกของแต่ละสาขา',
    cols: { effective_date: T.date, branch: T.short, percent_value: T.pct, qty_259: T.qty, qty_359: T.qty },
    // วันที่ | ชื่อสาขา | เปอร์เซ็น | จำนวน259 | จำนวน359
    map: (r) => (!str(r[1]) ? null : {
      effective_date: toDate(r[0]), branch: str(r[1]).toLowerCase(),
      percent_value: num(r[2]), qty_259: num(r[3]), qty_359: num(r[4]),
    }),
  },
  {
    key: 'avg-per-head',
    label: 'ค่าเฉลี่ยยอดใช้ต่อหัว',
    table: 'inv_avg_per_head',
    ss: SS_SALES, sheet: 'ค่าเฉลี่ยยอดใช้ต่อหัว',
    unique: ['branch', 'item_code_norm'],
    cols: { branch: T.short, item_code_norm: T.code, item_code: T.code, item_name: T.name, avg_value: T.money },
    // สาขา | รหัส | ชื่อ | ค่าเฉลี่ย
    map: (r) => (!str(r[0]) || !str(r[1]) ? null : {
      branch: str(r[0]).toLowerCase(), item_code_norm: normId(r[1]), item_code: codeText(r[1]),
      item_name: str(r[2]), avg_value: num(r[3]),
    }),
  },
];

const only = val('only', '');
const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const selected = SOURCES.filter((s) => !wanted || wanted.has(s.key));

/* --------------------------- แปลงแถวชีท -> แถวตาราง --------------------------- */

function buildRows(src, raw) {
  const out = [];
  for (const r of raw) {
    if (src.expand) out.push(...src.expand(r));
    else {
      const row = src.map(r);
      if (row) out.push(row);
    }
  }
  if (!src.unique) return { rows: out, dropped: 0 };

  // ชีทมีแถวซ้ำคีย์เดียวกันได้ (แก้ทีหลังแล้วต่อท้ายแทนที่จะแก้แถวเดิม) เก็บแถวล่างสุดไว้
  const byKey = new Map();
  for (const row of out) byKey.set(src.unique.map((k) => row[k]).join('|'), row);
  return { rows: [...byKey.values()], dropped: out.length - byKey.size };
}

/* ------------------------------ เขียนลงฐานข้อมูล ------------------------------ */

const MAX_PARAMS = 2000; // ลิมิตจริงของ SQL Server คือ 2,100 ตัวต่อคำสั่ง เผื่อไว้หน่อย

async function insertRows(pool, src, rows) {
  const names = Object.keys(src.cols);
  const perBatch = Math.max(1, Math.floor(MAX_PARAMS / names.length));
  let done = 0;

  for (let i = 0; i < rows.length; i += perBatch) {
    const chunk = rows.slice(i, i + perBatch);
    const request = pool.request();
    const tuples = [];
    chunk.forEach((row, n) => {
      const params = names.map((c) => {
        const p = `${c}_${n}`;
        request.input(p, src.cols[c], row[c] === undefined || row[c] === '' ? null : row[c]);
        return `@${p}`;
      });
      tuples.push(`(${params.join(', ')})`);
    });
    await request.query(
      `INSERT INTO dbo.${src.table} (${names.join(', ')}) VALUES ${tuples.join(', ')}`
    );
    done += chunk.length;
    process.stdout.write(`\r  เขียนแล้ว ${done}/${rows.length} แถว   `);
  }
  return done;
}

/* --------------------------------- main --------------------------------- */

async function main() {
  if (LIST) {
    console.log('ชุดข้อมูลทั้งหมด (ใช้กับ --only= และ --inspect=)\n');
    for (const s of SOURCES) console.log(`  ${s.key.padEnd(15)} -> dbo.${s.table.padEnd(22)} ${s.label}`);
    return;
  }

  if (INSPECT) {
    const src = SOURCES.find((s) => s.key === INSPECT);
    if (!src) {
      console.error(`ไม่รู้จักชุด "${INSPECT}" — ดูรายชื่อได้ด้วย --list`);
      process.exitCode = 1;
      return;
    }
    console.log(`ชุด ${src.key} — ${src.label}\n`);
    const raw = await fetchRows(src);
    console.log(`อ่านได้ ${raw.length} แถว (ไม่นับหัวตาราง)\n`);
    console.log('แถวดิบ 3 แถวแรก:');
    raw.slice(0, 3).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r.slice(0, 16))}`));
    const { rows, dropped } = buildRows(src, raw);
    console.log(`\nแปลงเป็นแถวตารางได้ ${rows.length} แถว${dropped ? ` (ยุบแถวซ้ำคีย์ ${dropped} แถว)` : ''}`);
    rows.slice(0, 3).forEach((r, i) => console.log(`  [${i}] ${JSON.stringify(r)}`));
    if (badDates) console.log(`\nแปลงวันที่ไม่ได้ ${badDates} ช่อง (เก็บเป็นค่าว่าง)`);
    return;
  }

  console.log(`ปลายทาง SQL Server : ${DB.host}:${DB.port}/${DB.database} (user ${DB.user || '(ไม่ได้ใส่)'})`);
  console.log('');
  if (DRY_RUN) console.log('โหมด --dry-run: อ่านชีทและนับแถวเท่านั้น ไม่ต่อฐานข้อมูล ไม่เขียนอะไร\n');
  if (wanted) console.log(`ย้ายเฉพาะ: ${selected.map((s) => s.key).join(', ') || '(ไม่ตรงกับชุดไหนเลย)'}\n`);

  if (selected.length === 0) {
    console.error('--only ไม่ตรงกับชุดไหนเลย — ดูรายชื่อได้ด้วย --list');
    process.exitCode = 1;
    return;
  }
  if (!DRY_RUN && (!DB.user || !DB.password)) {
    console.error('ต้องใส่ --user และ --pass (หรือตั้ง INV_DB_USER / INV_DB_PASSWORD)');
    process.exitCode = 1;
    return;
  }

  let pool = null;
  try {
    if (!DRY_RUN) {
      pool = await new sql.ConnectionPool({
        server: DB.host, port: DB.port, database: DB.database, user: DB.user, password: DB.password,
        connectionTimeout: 15000,
        requestTimeout: 180000, // ชีทนับสต๊อกมีสองหมื่นกว่าแถว ให้เวลามากกว่าฝั่งเว็บ
        pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
        options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
      }).connect();
      console.log('ต่อ SQL Server ได้แล้ว\n');
    }

    const summary = [];
    for (const src of selected) {
      badDates = 0;
      process.stdout.write(`${src.key.padEnd(15)} ${src.label}\n`);

      let raw;
      try {
        raw = await fetchRows(src);
      } catch (err) {
        console.log(`  อ่านชีทไม่ได้: ${err.message}\n`);
        summary.push({ key: src.key, read: 0, written: 0, note: 'อ่านชีทไม่ได้' });
        continue;
      }

      const { rows, dropped } = buildRows(src, raw);
      let note = `อ่าน ${raw.length} แถว -> ใช้ได้ ${rows.length} แถว`;
      if (dropped) note += ` (ยุบแถวซ้ำคีย์ ${dropped})`;
      if (badDates) note += ` (แปลงวันที่ไม่ได้ ${badDates} ช่อง)`;
      console.log(`  ${note}`);

      if (DRY_RUN) {
        summary.push({ key: src.key, read: raw.length, written: 0, note: 'dry-run' });
        console.log('');
        continue;
      }
      if (rows.length === 0) {
        summary.push({ key: src.key, read: raw.length, written: 0, note: 'ไม่มีข้อมูล' });
        console.log('');
        continue;
      }

      const existing = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${src.table}`);
      const already = Number(existing.recordset[0]?.n || 0);
      if (already > 0 && !REPLACE) {
        console.log(`  ข้าม: dbo.${src.table} มีข้อมูลอยู่แล้ว ${already} แถว (ใส่ --replace ถ้าต้องการล้างแล้วเขียนใหม่)\n`);
        summary.push({ key: src.key, read: raw.length, written: 0, note: `ข้าม (มีอยู่แล้ว ${already})` });
        continue;
      }
      if (already > 0) {
        await pool.request().query(`DELETE FROM dbo.${src.table}`);
        console.log(`  ล้างของเดิม ${already} แถวแล้ว`);
      }

      const written = await insertRows(pool, src, rows);
      process.stdout.write(`\r  เขียนลง dbo.${src.table} ${written} แถว           \n\n`);
      summary.push({ key: src.key, read: raw.length, written, note: '' });
    }

    console.log('สรุป');
    for (const s of summary) {
      console.log(`  ${s.key.padEnd(15)} อ่าน ${String(s.read).padStart(6)} | เขียน ${String(s.written).padStart(6)} ${s.note}`);
    }
    console.log('\nเสร็จแล้ว');
  } catch (err) {
    console.error(`\nล้มเหลว: ${err.message}`);
    if (err.code) console.error(`(รหัส ${err.code})`);
    if (process.env.DEBUG) console.error(err);
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
