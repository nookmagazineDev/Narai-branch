#!/usr/bin/env node
/**
 * ย้ายรายจ่าย (ชีท "ต้นทุนจากsup") เข้า SQL dbo.stock_sup_cost — ข้อมูลเก่าทั้งหมดของหน้ากรอกรายจ่าย
 *
 * ชีท: สเปรดชีต 1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw แท็บ 'ต้นทุนจากsup'
 *   [0]วันที่ [1]สาขา [2]รหัส [3]ชื่อ [4]หน่วย [5]จำนวน [6]ราคา/หน่วย [7]มูลค่ารวม [8]ผู้บันทึก [9]เวลาบันทึก [10]เวลาแก้ไข
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่อง 203.154.185.48 หลังรัน update-office-server.bat แล้ว):
 *   node scripts/import-sup-cost.mjs              # รายงานอย่างเดียว ไม่เขียนอะไร
 *   node scripts/import-sup-cost.mjs --apply      # เขียนจริง
 *
 * ตัวเลือก
 *   --apply       เขียนจริง (ไม่ใส่ = รายงานอย่างเดียว)
 *   --branch=crm  เฉพาะสาขาเดียว (ไม่ใส่ = ทุกสาขา)
 *   --overwrite   แถวที่ย้ายมาจากชีทรอบก่อน (source = 'sheet') ให้แก้ตามชีทล่าสุดด้วย
 *                 ไม่แตะแถวที่สาขากรอกผ่านเว็บหลังย้าย (source = 'web') ไม่ว่ากรณีไหน
 *   --url=<URL>   ชี้แท็บอื่น: เปิดแท็บในเบราว์เซอร์แล้วก๊อป URL ทั้งอันมาวาง (แกะ id ไฟล์กับ gid ให้เอง)
 *
 * รันซ้ำได้ปลอดภัย — ค่าเริ่มต้นเติมเฉพาะ (วันที่+สาขา+สินค้า) ที่ยังไม่มีในตาราง
 * ในชีทมีแถวซ้ำของ (วันที่+สาขา+สินค้า) เดียวกันได้ เอาแถวหลังสุดเหมือนที่ Apps Script ทำ
 *
 * ลำดับตอนย้ายระบบ: update-office-server.bat (สร้างตาราง) -> update-web.bat (หน้าเว็บเขียน SQL)
 * -> สคริปต์นี้ --apply · ถ้ามีเครื่องที่ถือหน้าเว็บรุ่นเก่าบันทึกลงชีทตามมาอีก รันซ้ำก็เก็บตกให้
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

const { sql, stockDb, isConfigured, describeDbError } = await import('../hr-db.js');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY = args.includes('--apply');
const OVERWRITE = args.includes('--overwrite');
const ONLY_BRANCH = String(argVal('branch', '')).toLowerCase().trim();

const TAB_URL = String(argVal('url', '')).trim();
const urlFile = TAB_URL.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
const urlGid = TAB_URL.match(/[#?&]gid=(\d+)/);
const SUP_SS = urlFile ? urlFile[1] : '1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw';
const SUP_TAB = 'ต้นทุนจากsup';
const SUP_GID = urlGid ? urlGid[1] : '';

/* ── ตัวแปลงค่า: ต้องให้ผลตรงกับ office-server/supcost.js ── */
const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();

/** 'YYYY-MM-DD HH:mm:ss' จากวันที่ในชีท (Date(...), YYYY-MM-DD, DD/MM/YYYY [HH:mm:ss], พ.ศ.) */
function toSqlDateTime(v) {
  const s = str(v);
  if (!s) return null;
  let y, mo, d, h = 0, mi = 0, sec = 0;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    [, y, mo, d, h = 0, mi = 0, sec = 0] = m;
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    [, d, mo, y, h = 0, mi = 0, sec = 0] = m;
  }
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y > 2400) y -= 543;   // พ.ศ. -> ค.ศ.
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  return `${y}-${pad(mo)}-${pad(d)} ${pad(Number(h) || 0)}:${pad(Number(mi) || 0)}:${pad(Number(sec) || 0)}`;
}

async function fetchRows() {
  // ชี้ด้วย gid ก่อนถ้ามี — ชื่อแท็บที่ไม่ตรงเป๊ะทำให้ gviz คืนแท็บอื่นมาเงียบ ๆ
  const target = SUP_GID ? `gid=${encodeURIComponent(SUP_GID)}` : `sheet=${encodeURIComponent(SUP_TAB)}`;
  const url = `https://docs.google.com/spreadsheets/d/${SUP_SS}/gviz/tq?tqx=out:json&headers=0&${target}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) {
    throw new Error(`อ่านชีท '${SUP_TAB}' ไม่ได้ — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`);
  }
  const json = JSON.parse(text.slice(a, b + 1));
  const cols = json.table.cols || [];
  const rows = (json.table.rows || []).map((row) =>
    cols.map((_, i) => {
      const cell = row.c && row.c[i];
      if (!cell) return '';
      if (typeof cell.v === 'string') {
        const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
        if (m) {
          const [, y, mo, d, h, mi, s2] = m;
          const date = `${y}-${pad(Number(mo) + 1)}-${pad(Number(d))}`;
          return h === undefined ? date : `${date} ${pad(Number(h))}:${pad(Number(mi))}:${pad(Number(s2 || 0))}`;
        }
      }
      // เวลาบันทึกเป็นข้อความ dd/MM/yyyy HH:mm:ss แต่ gviz อาจตีความเป็นวันที่แล้วให้ค่า f มาแทน
      if ((cell.v === null || cell.v === undefined) && cell.f) return cell.f;
      return cell.v === null || cell.v === undefined ? '' : cell.v;
    })
  );
  if (rows.length === 0) return rows;
  const first = rows[0].map((c) => str(c));
  const looksLikeHeader = first.some((c) => /^(วันที่|สาขา|รหัส|ชื่อ|หน่วย|จำนวน)/.test(c));
  return looksLikeHeader ? rows.slice(1) : rows;
}

const line = () => console.log('─'.repeat(78));

if (!isConfigured()) {
  console.error('❌ ไม่พบ HR_DB_USER / HR_DB_PASSWORD ใน office-server\\.env');
  process.exit(1);
}

console.log(APPLY ? '▶ โหมดเขียนจริง (--apply)' : '▶ โหมดรายงาน (ยังไม่เขียนอะไร — ใส่ --apply เพื่อเขียนจริง)');
if (OVERWRITE) console.log('  --overwrite: แถวที่ย้ายจากชีทรอบก่อนจะถูกแก้ตามชีทล่าสุด (ไม่แตะแถวที่กรอกผ่านเว็บ)');
if (ONLY_BRANCH) console.log(`  เฉพาะสาขา ${ONLY_BRANCH}`);
line();

let sheetRows;
try {
  sheetRows = await fetchRows();
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
console.log(`อ่านชีทได้ ${sheetRows.length.toLocaleString()} แถว`);

// แถวหลังสุดของ (วันที่+สาขา+สินค้า) ชนะ — ตรงกับที่ Apps Script แก้ทับ/อ่านกลับ
const byKey = new Map();
let bad = 0, dup = 0;
for (const r of sheetRows) {
  const dt = toSqlDateTime(r[0]);
  const branch = str(r[1]).toLowerCase();
  const code = str(r[2]).replace(/\.0+$/, '');
  const key = normCode(code);
  const qty = num(r[5]);
  if (!dt || !branch || !key || qty === null || qty < 0) { bad++; continue; }
  if (ONLY_BRANCH && branch !== ONLY_BRANCH) continue;
  const date = dt.slice(0, 10);
  const unitPrice = num(r[6]) ?? 0;
  const amountCell = num(r[7]);
  const k = `${date}|${branch}|${key}`;
  if (byKey.has(k)) dup++;
  byKey.set(k, {
    date, branch, key, code,
    name: str(r[3]) || null,
    unit: str(r[4]) || null,
    qty,
    unitPrice,
    amount: amountCell ?? Math.round(qty * unitPrice * 100) / 100,
    recorder: str(r[8]) || null,
    savedAt: toSqlDateTime(r[9]) || `${date} 00:00:00`,
    updatedAt: toSqlDateTime(r[10]),
  });
}
const rows = [...byKey.values()];
console.log(`ใช้ได้ ${rows.length.toLocaleString()} รายการ (ซ้ำในชีท ${dup} แถว เอาแถวหลังสุด · ข้อมูลไม่ครบ/อ่านไม่ได้ ${bad} แถว)`);

let pool;
try {
  pool = await stockDb.getPool();
} catch (err) {
  console.error(`❌ ต่อฐานข้อมูลไม่ได้: ${describeDbError(err)}`);
  process.exit(1);
}

const exists = await pool.request().query(`SELECT OBJECT_ID(N'dbo.stock_sup_cost', N'U') AS id`);
if (!exists.recordset[0].id) {
  console.error('❌ ยังไม่มีตาราง dbo.stock_sup_cost — รัน update-office-server.bat ก่อน (สร้างตารางให้จาก sql/supcost-001-table.sql)');
  process.exit(1);
}

// ของที่มีในตารางแล้ว: คีย์ -> source
const have = new Map();
const existing = await pool.request().query(
  `SELECT CONVERT(NVARCHAR(10), cost_date, 23) AS d, branch, item_key, source FROM dbo.stock_sup_cost`
);
for (const e of existing.recordset) have.set(`${e.d}|${e.branch}|${e.item_key}`, e.source);

const toInsert = [], toUpdate = [];
let keepWeb = 0, keepSheet = 0;
for (const r of rows) {
  const src = have.get(`${r.date}|${r.branch}|${r.key}`);
  if (!src) toInsert.push(r);
  else if (src === 'sheet' && OVERWRITE) toUpdate.push(r);
  else if (src === 'web') keepWeb++;
  else keepSheet++;
}

// สรุปรายสาขา
const perBranch = {};
for (const r of toInsert) {
  const b = perBranch[r.branch] || (perBranch[r.branch] = { n: 0, amount: 0, min: r.date, max: r.date });
  b.n++; b.amount += r.amount;
  if (r.date < b.min) b.min = r.date;
  if (r.date > b.max) b.max = r.date;
}
line();
console.log(`เพิ่มใหม่ ${toInsert.length.toLocaleString()} รายการ` +
  (OVERWRITE ? ` · แก้ตามชีท ${toUpdate.length.toLocaleString()} รายการ` : '') +
  ` · มีอยู่แล้ว (ย้ายรอบก่อน) ${keepSheet.toLocaleString()} · กรอกผ่านเว็บแล้ว ไม่แตะ ${keepWeb.toLocaleString()}`);
for (const [b, v] of Object.entries(perBranch).sort()) {
  console.log(`  ${b.padEnd(6)} ${String(v.n).padStart(6)} รายการ  ฿${v.amount.toFixed(2).padStart(14)}  ${v.min} ถึง ${v.max}`);
}
line();

if (!APPLY) {
  console.log('ยังไม่ได้เขียนอะไร — ตรวจตัวเลขด้านบนแล้วรันซ้ำพร้อม --apply');
  await pool.close();
  process.exit(0);
}

const bindRow = (req, r) => req
  .input('d', sql.NVarChar(10), r.date)
  .input('branch', sql.NVarChar(50), r.branch)
  .input('item_key', sql.NVarChar(50), r.key)
  .input('item_code', sql.NVarChar(50), r.code)
  .input('item_name', sql.NVarChar(255), r.name)
  .input('unit', sql.NVarChar(50), r.unit)
  .input('qty', sql.Decimal(18, 3), r.qty)
  .input('unit_price', sql.Decimal(18, 4), r.unitPrice)
  .input('amount', sql.Decimal(18, 2), r.amount)
  .input('recorder', sql.NVarChar(255), r.recorder)
  .input('saved_at', sql.NVarChar(19), r.savedAt)
  .input('updated_at', sql.NVarChar(19), r.updatedAt);

// ทีละก้อน ก้อนละ transaction — พังกลางทางก้อนนั้นย้อนทั้งก้อน รันซ้ำก็เติมต่อจากที่ขาด
const CHUNK = 500;
let inserted = 0, updated = 0;
try {
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const r of toInsert.slice(i, i + CHUNK)) {
        const res = await bindRow(new sql.Request(tx), r).query(
          `IF NOT EXISTS (SELECT 1 FROM dbo.stock_sup_cost
                           WHERE cost_date = CONVERT(DATE, @d, 120) AND branch = @branch AND item_key = @item_key)
             INSERT INTO dbo.stock_sup_cost
               (cost_date, branch, item_key, item_code, item_name, unit, qty, unit_price, amount,
                recorder, saved_at, updated_at, source)
             VALUES (CONVERT(DATE, @d, 120), @branch, @item_key, @item_code, @item_name, @unit, @qty, @unit_price, @amount,
                     @recorder, CONVERT(DATETIME2(0), @saved_at, 120), CONVERT(DATETIME2(0), @updated_at, 120), N'sheet');`
        );
        inserted += res.rowsAffected.reduce((s, n) => s + n, 0);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
    console.log(`  เพิ่มแล้ว ${Math.min(i + CHUNK, toInsert.length).toLocaleString()} / ${toInsert.length.toLocaleString()}`);
  }
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const r of toUpdate.slice(i, i + CHUNK)) {
        const res = await bindRow(new sql.Request(tx), r).query(
          `UPDATE dbo.stock_sup_cost
              SET item_code = @item_code, item_name = @item_name, unit = @unit, qty = @qty,
                  unit_price = @unit_price, amount = @amount, recorder = @recorder,
                  saved_at = CONVERT(DATETIME2(0), @saved_at, 120), updated_at = CONVERT(DATETIME2(0), @updated_at, 120)
            WHERE cost_date = CONVERT(DATE, @d, 120) AND branch = @branch AND item_key = @item_key
              AND source = N'sheet';`
        );
        updated += res.rowsAffected.reduce((s, n) => s + n, 0);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }
} catch (err) {
  console.error(`❌ เขียนไม่สำเร็จ: ${describeDbError(err)} — ก้อนที่พังถูกย้อนแล้ว รันซ้ำได้เลย`);
  await pool.close();
  process.exit(1);
}

line();
console.log(`✅ เพิ่ม ${inserted.toLocaleString()} รายการ` + (OVERWRITE ? ` · แก้ ${updated.toLocaleString()} รายการ` : ''));
await pool.close();
