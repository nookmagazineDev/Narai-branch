#!/usr/bin/env node
/**
 * ดึง "ยอดนับ/ใบเบิกที่ตกค้างอยู่ในชีท" เข้า SQL — เฉพาะแถวที่ยังไม่มีในฐาน
 *
 * ที่มา: หน้าเว็บเลือกปลายทาง (SQL หรือ Apps Script) จากไฟล์ JavaScript ที่เบราว์เซอร์โหลดไป
 * เครื่องที่แคชไฟล์ชุดเก่าไว้จึงบันทึกลงชีทต่อไปเงียบ ๆ ทั้งที่ระบบย้ายมา SQL แล้ว
 * (เคสจริง: สาขา CRM นับวันที่ 20/09/2026 ลงชีท ส่วน SQL ค้างอยู่ที่ 17/09)
 * ตัวบล็อกฝั่ง Apps Script กันไม่ให้เกิดใหม่แล้ว เหลือของที่ตกค้างไปแล้วต้องตามเก็บ
 *
 * ทำไมไม่ใช้ scripts/migrate-stock.mjs: ตัวนั้นย้าย 'ยอดยกมา' ด้วย MERGE ทับของเดิมเสมอ
 * ถ้ารันตอนนี้ ยอดยกมาในชีท (เก่า) จะทับยอดที่สาขาอื่นนับลง SQL ไปแล้ว — ข้อมูลดีหายแทน
 * ตัวนี้จึงเติมเฉพาะ "แถวที่ขาด" และแตะยอดยกมาเฉพาะเมื่อยอดนับที่เพิ่งเติมใหม่กว่าของเดิมจริง ๆ
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/import-sheet-counts.mjs                  # รายงานอย่างเดียว ไม่เขียนอะไร
 *   node scripts/import-sheet-counts.mjs --days=60
 *   node scripts/import-sheet-counts.mjs --branch=crm
 *   node scripts/import-sheet-counts.mjs --apply          # เขียนจริง (ยอดนับ)
 *   node scripts/import-sheet-counts.mjs --apply --requests   # เอาใบเบิกด้วย
 *
 * ตัวเลือก
 *   --days=30     ย้อนหลังกี่วัน (ค่าเริ่มต้น 30) — ของเก่ากว่านั้นย้ายไปตั้งแต่ migrate แล้ว
 *   --branch=crm  เฉพาะสาขาเดียว (ไม่ใส่ = ทุกสาขา)
 *   --apply       เขียนจริง (ไม่ใส่ = รายงานอย่างเดียว)
 *   --requests    รวมใบเบิก (ชีท 'ข้อมูลเบิก') ด้วย
 *   --url=<URL>   วิธีที่ง่ายที่สุด: เปิดแท็บที่มีข้อมูลจริงในเบราว์เซอร์ แล้วก๊อป URL ทั้งอันมาวาง
 *                 (สคริปต์แกะ id ไฟล์กับ gid ของแท็บออกมาเอง) ครอบ --file/--gid ที่ใส่มาด้วย
 *   --file=<id>   ชี้ไฟล์อื่น (ค่าเริ่มต้นคือไฟล์สต๊อกที่ Apps Script เขียนลง)
 *   --gid=<gid>   ชี้แท็บยอดนับด้วยเลข gid แทนชื่อ — เอามาจาก #gid=... ท้าย URL ตอนคลิกแท็บนั้น
 *   --tab=<ชื่อ>  ชี้แท็บยอดนับด้วยชื่อ (ค่าเริ่มต้น 'ข้อมูลนับสตอค')
 *   --reqgid= / --reqtab=   อย่างเดียวกันสำหรับแท็บใบเบิก
 *
 * ชี้เป้าด้วย gid ดีกว่าชื่อ: ถ้าชื่อแท็บไม่ตรงเป๊ะ (ช่องว่างท้ายชื่อ/สะกดต่าง) gviz อาจคืนแท็บอื่น
 * มาให้เงียบ ๆ แล้วรายงานจะดูเหมือนอ่านได้ปกติ ทั้งที่เป็นข้อมูลคนละชุด
 *
 * รันซ้ำได้ปลอดภัย — เติมเฉพาะแถวที่ยังไม่มี (เทียบด้วย สาขา+สินค้า+เวลา เหมือน unique key ของตาราง)
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
const WITH_REQUESTS = args.includes('--requests');
const DAYS = Number(argVal('days', '30')) || 30;
const ONLY_BRANCH = String(argVal('branch', '')).toLowerCase().trim();

// URL ของแท็บที่เปิดอยู่ในเบราว์เซอร์ — แกะ id ไฟล์กับ gid ออกมาให้เอง
// (ให้คนหาเลข gid เองแล้วพิมพ์ต่อท้ายพารามิเตอร์ พลาดง่ายกว่าก๊อปทั้งแถบที่อยู่มาวาง)
const TAB_URL = String(argVal('url', '')).trim();
const urlFile = TAB_URL.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
const urlGid = TAB_URL.match(/[#?&]gid=(\d+)/);

// ไฟล์สต๊อก (ชุดเดียวกับ scripts/migrate-stock.mjs) — ทับด้วย --url= หรือ --file= ได้
const STOCK_SS = (urlFile ? urlFile[1] : String(argVal('file', '1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ'))).trim();
const COUNT_TAB = String(argVal('tab', 'ข้อมูลนับสตอค'));
const COUNT_GID = (urlGid ? urlGid[1] : String(argVal('gid', ''))).trim();
const REQ_TAB = String(argVal('reqtab', 'ข้อมูลเบิก'));
const REQ_GID = String(argVal('reqgid', '')).trim();

/* ── ตัวแปลงค่า: ต้องให้ผลตรงกับ scripts/migrate-stock.mjs เป๊ะ ── */
const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const normCode = (v) => str(v).replace(/\.0+$/, '').replace(/^0+/, '').toLowerCase();
const branchCode = (v) => str(v).toLowerCase();

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

async function fetchRows(sheetName, gid) {
  // ชี้ด้วย gid ก่อนเสมอถ้ามี — ชื่อแท็บที่ไม่ตรงเป๊ะทำให้ได้แท็บอื่นมาโดยไม่มีอะไรฟ้อง
  const target = gid ? `gid=${encodeURIComponent(gid)}` : `sheet=${encodeURIComponent(sheetName)}`;
  const url = `https://docs.google.com/spreadsheets/d/${STOCK_SS}/gviz/tq?tqx=out:json&headers=0&${target}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < 0) {
    throw new Error(`อ่านชีท '${gid ? 'gid=' + gid : sheetName}' ไม่ได้ — ตรวจว่าตั้งลิงก์เป็น "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง`);
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
      return cell.v === null || cell.v === undefined ? '' : cell.v;
    })
  );
  if (rows.length === 0) return rows;
  const first = rows[0].map((c) => str(c));
  const looksLikeHeader = first.some((c) => /^(รหัส|ชื่อ|สาขา|วันที่|เลขที่|หน่วย|จำนวน|ยอด|หมวด|item|code|name|branch)/i.test(c));
  return looksLikeHeader ? rows.slice(1) : rows;
}

const line = () => console.log('─'.repeat(78));
const cutoff = (() => {
  const d = new Date();
  d.setDate(d.getDate() - DAYS);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
})();

if (!isConfigured()) {
  console.error('ยังไม่ได้ตั้งค่า HR_DB_USER / HR_DB_PASSWORD ใน office-server/.env');
  process.exit(2);
}

try {
  console.log(`เทียบชีทกับ SQL ย้อนหลัง ${DAYS} วัน (ตั้งแต่ ${cutoff.slice(0, 10)})` +
    (ONLY_BRANCH ? ` · เฉพาะสาขา ${ONLY_BRANCH}` : '') + (APPLY ? ' · โหมดเขียนจริง' : ' · รายงานอย่างเดียว'));
  line();

  /* ─────────────── ยอดนับ ─────────────── */
  // ชีท 'ข้อมูลนับสตอค': A=วันที่ B=ผู้นับ C=สาขา D=รหัส E=ชื่อ F=หน่วย G=คงเหลือ
  if (TAB_URL && !urlFile) {
    console.error('อ่าน --url= ไม่ออก — ต้องเป็นลิงก์ที่มี /spreadsheets/d/<id> อยู่ในนั้น');
    process.exit(2);
  }
  console.log(`ไฟล์ ${STOCK_SS}`);
  console.log(`แท็บยอดนับ: ${COUNT_GID ? 'gid=' + COUNT_GID : `'${COUNT_TAB}'`}`);
  const sheetRows = await fetchRows(COUNT_TAB, COUNT_GID);
  const fromSheet = [];
  const seen = new Set();
  // ภาพรวมของชีททั้งไฟล์ — ไม่สนช่วงวันและไม่สน --branch
  // เดิมรายงานบอกแค่จำนวนแถวที่ผ่านตัวกรองครบทุกชั้น ซึ่งขึ้น 0 ได้ทั้งตอนชีทไม่มีข้อมูลจริง
  // ตอนอ่านชีทไม่ได้ และตอนสาขาถูกบันทึกด้วยรหัสอื่น แล้วปิดท้ายว่า "ตรงกันแล้ว" ทั้งสามกรณี
  const sheetLatest = new Map();  // สาขา -> { at, n }
  let badDate = 0, incomplete = 0;
  for (const row of sheetRows) {
    const countedAt = toSqlDateTime(row[0]);
    const branch = branchCode(row[2]);
    const key = normCode(row[3]);
    const remaining = num(row[6]);
    if (!countedAt) { badDate++; continue; }
    if (!branch || !key || remaining === null) { incomplete++; continue; }
    const cur = sheetLatest.get(branch);
    if (!cur) sheetLatest.set(branch, { at: countedAt, n: 1 });
    else { cur.n++; if (countedAt > cur.at) cur.at = countedAt; }
    if (countedAt < cutoff) continue;
    if (ONLY_BRANCH && branch !== ONLY_BRANCH) continue;
    const dedupe = `${branch}|${key}|${countedAt}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    fromSheet.push({ countedAt, branch, key, code: str(row[3]), name: str(row[4]), unit: str(row[5]), remaining, counter: str(row[1]) });
  }

  console.log(`อ่านชีท 'ข้อมูลนับสตอค' ได้ ${sheetRows.length} แถว` +
    (badDate ? ` · วันที่อ่านไม่ออก ${badDate}` : '') +
    (incomplete ? ` · สาขา/รหัส/จำนวนไม่ครบ ${incomplete}` : ''));
  if (sheetRows.length === 0) {
    line();
    console.error('❌ อ่านชีทไม่ได้ หรือแท็บนี้ว่าง — ผลเทียบข้างล่างจึงเชื่อไม่ได้');
    console.error('   ตรวจ: ไฟล์ตั้งแชร์ "ผู้ที่มีลิงก์ • ผู้อ่าน" แล้วหรือยัง และชี้แท็บถูกตัวไหม');
    process.exit(2);
  }
  // อ่านมาได้แต่ใช้ไม่ได้สักแถว = ชี้ผิดแท็บ (คอลัมน์คนละชุด) ไม่ใช่ "ไม่มีอะไรตกค้าง"
  if (sheetLatest.size === 0) {
    line();
    console.error(`❌ อ่านมาได้ ${sheetRows.length} แถว แต่ไม่มีแถวไหนเป็นยอดนับเลย — แท็บนี้ผิดตัว`);
    console.error('   แท็บยอดนับต้องเรียงคอลัมน์ A=วันที่ B=ผู้นับ C=สาขา D=รหัส E=ชื่อ F=หน่วย G=คงเหลือ');
    console.error('   เปิดแท็บที่มีข้อมูลจริงในเบราว์เซอร์แล้วก๊อป URL ทั้งอันมาใส่ --url="<วาง URL>"');
    process.exit(2);
  }

  // วันที่นับล่าสุดของแต่ละสาขา ชีทเทียบ SQL — ตอบคำถาม "ของสาขานี้ตกค้างอยู่ในชีทไหม" ได้ในบรรทัดเดียว
  const sqlLatest = await stockDb.queryRead(
    `SELECT branch, CONVERT(NVARCHAR(19), MAX(counted_at), 120) AS at_text, COUNT(*) AS n
       FROM dbo.stock_count GROUP BY branch`
  );
  const sqlByBranch = new Map(sqlLatest.map((r) => [str(r.branch).toLowerCase(), { at: str(r.at_text), n: Number(r.n) }]));
  const allBranches = [...new Set([...sheetLatest.keys(), ...sqlByBranch.keys()])].sort();
  console.log('');
  console.log('  วันที่นับล่าสุด (ทุกสาขา ทุกช่วงเวลา — ไม่ขึ้นกับ --days/--branch)');
  console.log(`    ${'สาขา'.padEnd(8)}${'ในชีท'.padEnd(22)}${'ใน SQL'.padEnd(22)}`);
  for (const b of allBranches) {
    const sh = sheetLatest.get(b);
    const db = sqlByBranch.get(b);
    const behind = sh && (!db || db.at < sh.at);   // ชีทใหม่กว่า SQL = มีของตกค้างแน่นอน
    console.log(`    ${b.padEnd(8)}${(sh ? sh.at : '-').padEnd(22)}${(db ? db.at : '-').padEnd(22)}${behind ? '  ⚠️ ชีทใหม่กว่า' : ''}`);
  }
  console.log('');

  const inSql = await stockDb.queryRead(
    `SELECT branch, item_key, CONVERT(NVARCHAR(19), counted_at, 120) AS at_text
       FROM dbo.stock_count
      WHERE counted_at >= CONVERT(DATETIME2(0), @from, 120)`,
    { from: { type: sql.NVarChar(19), value: cutoff } }
  );
  const have = new Set(inSql.map((r) => `${str(r.branch).toLowerCase()}|${str(r.item_key)}|${str(r.at_text)}`));
  const missing = fromSheet.filter((c) => !have.has(`${c.branch}|${c.key}|${c.countedAt}`));

  console.log(`ยอดนับ: ในชีท ${fromSheet.length} แถว · มีใน SQL แล้ว ${fromSheet.length - missing.length} · ขาด ${missing.length}`);
  if (missing.length) {
    const byDay = new Map();
    for (const c of missing) {
      const k = `${c.branch}  ${c.countedAt.slice(0, 10)}`;
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
    console.log('');
    console.log('  แถวที่ขาด (สาขา / วันที่ / จำนวนรายการ)');
    for (const [k, n] of [...byDay.entries()].sort()) console.log(`    ${k}  ${n} รายการ`);
  }

  /* ─────────────── ใบเบิก (ถ้าสั่ง) ─────────────── */
  let missingReq = [];
  if (WITH_REQUESTS) {
    // ชีท 'ข้อมูลเบิก': A=เลขที่ B=เวลาบันทึก C=รหัส D=ชื่อ E=หน่วย F=จำนวน G=วันรับ H=ผู้เบิก I=สาขา
    const reqRows = await fetchRows(REQ_TAB, REQ_GID);
    const list = [];
    const seenReq = new Set();
    for (const row of reqRows) {
      const docNo = str(row[0]);
      const key = normCode(row[2]);
      const qty = num(row[5]);
      const savedAt = toSqlDateTime(row[1]);
      if (!docNo || !key || qty === null) continue;
      if (savedAt && savedAt < cutoff) continue;
      const branch = branchCode(row[8]) || docNo.slice(0, 3).toLowerCase();
      if (!branch) continue;
      if (ONLY_BRANCH && branch !== ONLY_BRANCH) continue;
      const dedupe = `${docNo}|${key}`;
      if (seenReq.has(dedupe)) continue;
      seenReq.add(dedupe);
      list.push({ docNo, branch, key, code: str(row[2]), name: str(row[3]), unit: str(row[4]), qty, savedAt, requestDate: str(row[6]), requester: str(row[7]) });
    }
    const haveReq = await stockDb.queryRead(
      `SELECT doc_no, item_key FROM dbo.stock_request
        WHERE saved_at >= CONVERT(DATETIME2(0), @from, 120)`,
      { from: { type: sql.NVarChar(19), value: cutoff } }
    );
    const reqSet = new Set(haveReq.map((r) => `${str(r.doc_no)}|${str(r.item_key)}`));
    missingReq = list.filter((r) => !reqSet.has(`${r.docNo}|${r.key}`));
    console.log('');
    console.log(`ใบเบิก: ในชีท ${list.length} แถว · ขาด ${missingReq.length}`);
  }

  if (!APPLY) {
    console.log('');
    line();
    if (missing.length === 0 && missingReq.length === 0) {
      // "ไม่มีแถวขาด" ในช่วงที่ขอ ไม่ได้แปลว่าไม่มีอะไรตกค้างเลย — ของอาจอยู่นอกช่วง --days
      const stale = [...sheetLatest.entries()].filter(([b, sh]) => {
        if (ONLY_BRANCH && b !== ONLY_BRANCH) return false;
        const db = sqlByBranch.get(b);
        return !db || db.at < sh.at;
      });
      if (stale.length) {
        console.log('⚠️ ในช่วง ' + DAYS + ' วันที่ตรวจไม่มีแถวขาด แต่สาขาข้างล่างยังมียอดในชีทที่ใหม่กว่า SQL');
        for (const [b, sh] of stale) console.log(`    ${b}  ชีทล่าสุด ${sh.at}`);
        console.log('ลองขยายช่วงด้วย --days=<จำนวนวัน> ให้ครอบวันที่นั้นแล้วรันใหม่');
      } else {
        console.log('✅ ไม่มีอะไรตกค้าง ชีทกับ SQL ตรงกันแล้ว');
      }
    } else {
      console.log('นี่เป็นการรายงานอย่างเดียว ยังไม่ได้เขียนอะไรลงฐาน');
      console.log('ถ้าตัวเลขถูกต้องแล้ว สั่งใหม่ด้วย --apply เพื่อเติมเข้า SQL');
    }
    process.exit(0);
  }

  /* ─────────────── เขียนจริง ─────────────── */
  let added = 0, balanceUpdated = 0, addedReq = 0;
  await stockDb.withTransaction(async (run) => {
    for (const c of missing) {
      const r = await run(
        `DECLARE @ins INT = 0;
         IF NOT EXISTS (SELECT 1 FROM dbo.stock_count
                         WHERE branch = @branch AND item_key = @item_key
                           AND counted_at = CONVERT(DATETIME2(0), @counted_at, 120))
         BEGIN
           INSERT INTO dbo.stock_count (counted_at, branch, item_key, item_code, item_name, unit, remaining, counter_name)
           VALUES (CONVERT(DATETIME2(0), @counted_at, 120), @branch, @item_key, @item_code, @item_name, @unit, @remaining, @counter_name);
           SET @ins = 1;
         END
         SELECT @ins AS ins;`,
        {
          counted_at: { type: sql.NVarChar(19), value: c.countedAt },
          branch: { type: sql.NVarChar(50), value: c.branch },
          item_key: { type: sql.NVarChar(50), value: c.key },
          item_code: { type: sql.NVarChar(50), value: c.code },
          item_name: { type: sql.NVarChar(255), value: c.name || null },
          unit: { type: sql.NVarChar(50), value: c.unit || null },
          remaining: { type: sql.Decimal(18, 3), value: c.remaining },
          counter_name: { type: sql.NVarChar(255), value: c.counter || null },
        }
      );
      if (Number(r.recordset?.[0]?.ins)) added++;
    }

    // ยอดยกมา = ยอดนับล่าสุดของสินค้านั้น — อัปเดตเฉพาะเมื่อแถวที่เพิ่งเติมใหม่กว่าของเดิมจริง ๆ
    // (ห้ามทับแบบไม่มีเงื่อนไข ไม่งั้นยอดที่สาขาอื่นนับลง SQL ไปแล้วจะถูกของเก่าจากชีททับ)
    const latest = new Map();
    for (const c of missing) {
      const k = `${c.branch}|${c.key}`;
      if (!latest.has(k) || latest.get(k).countedAt < c.countedAt) latest.set(k, c);
    }
    for (const c of latest.values()) {
      const r = await run(
        `DECLARE @upd INT = 0;
         MERGE dbo.stock_balance AS t
         USING (SELECT @branch AS branch, @item_key AS item_key) AS s
           ON t.branch = s.branch AND t.item_key = s.item_key
         WHEN MATCHED AND t.updated_at < CONVERT(DATETIME2(0), @updated_at, 120) THEN UPDATE SET
           item_code = @item_code, item_name = @item_name, balance = @balance,
           updated_at = CONVERT(DATETIME2(0), @updated_at, 120)
         WHEN NOT MATCHED THEN INSERT (branch, item_key, item_code, item_name, balance, updated_at)
           VALUES (@branch, @item_key, @item_code, @item_name, @balance, CONVERT(DATETIME2(0), @updated_at, 120));
         SET @upd = @@ROWCOUNT;
         SELECT @upd AS upd;`,
        {
          branch: { type: sql.NVarChar(50), value: c.branch },
          item_key: { type: sql.NVarChar(50), value: c.key },
          item_code: { type: sql.NVarChar(50), value: c.code },
          item_name: { type: sql.NVarChar(255), value: c.name || null },
          balance: { type: sql.Decimal(18, 3), value: c.remaining },
          updated_at: { type: sql.NVarChar(19), value: c.countedAt },
        }
      );
      if (Number(r.recordset?.[0]?.upd)) balanceUpdated++;
    }

    for (const q of missingReq) {
      const r = await run(
        `DECLARE @ins INT = 0;
         IF NOT EXISTS (SELECT 1 FROM dbo.stock_request WHERE doc_no = @doc_no AND item_key = @item_key)
         BEGIN
           INSERT INTO dbo.stock_request
             (doc_no, saved_at, branch, item_key, item_code, item_name, unit, qty, request_date, requester)
           VALUES (@doc_no, CONVERT(DATETIME2(0), @saved_at, 120), @branch, @item_key, @item_code,
                   @item_name, @unit, @qty, @request_date, @requester);
           SET @ins = 1;
         END
         SELECT @ins AS ins;`,
        {
          doc_no: { type: sql.NVarChar(50), value: q.docNo },
          saved_at: { type: sql.NVarChar(19), value: q.savedAt || cutoff },
          branch: { type: sql.NVarChar(50), value: q.branch },
          item_key: { type: sql.NVarChar(50), value: q.key },
          item_code: { type: sql.NVarChar(50), value: q.code },
          item_name: { type: sql.NVarChar(255), value: q.name || null },
          unit: { type: sql.NVarChar(50), value: q.unit || null },
          qty: { type: sql.Decimal(18, 3), value: q.qty },
          request_date: { type: sql.NVarChar(30), value: q.requestDate || null },
          requester: { type: sql.NVarChar(255), value: q.requester || null },
        }
      );
      if (Number(r.recordset?.[0]?.ins)) addedReq++;
    }
  });

  console.log('');
  line();
  console.log(`✅ เติมยอดนับ ${added} แถว · ปรับยอดยกมา ${balanceUpdated} รายการ` +
    (WITH_REQUESTS ? ` · เติมใบเบิก ${addedReq} แถว` : ''));
  console.log('ให้สาขาเปิดหน้านับสต๊อกใหม่ (F5) แล้วตรวจว่ายอดตรงกับที่นับไว้');
  process.exit(0);
} catch (err) {
  console.error('ทำงานไม่สำเร็จ:', describeDbError ? describeDbError(err) : err.message);
  process.exit(2);
}
