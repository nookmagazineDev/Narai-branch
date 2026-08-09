// ซิงก์รายการสินค้าจาก Google Sheets (ไฟล์ BOM) เข้า SQL Server — ทางเดียว Sheets -> SQL
//
// ทำไมต้องมีตัวนี้: ชีท "item" ยังเป็นต้นทางจริง เพราะทีม QC/RD แก้ผ่านเว็บ naraipizzeria
// (qcrd-apps-script.gs มีคำสั่ง addItem / saveItem / deleteItem / updateItemUnits)
// ถ้าไม่ซิงก์ สินค้าใหม่ที่เพิ่มจากเว็บนั้นจะไม่ขึ้นในหน้านับสต๊อกเลย
//
// >>> ทางเดียวเท่านั้น ห้ามให้ฝั่ง SQL เขียนกลับ <<<
// ตารางที่สคริปต์นี้ดูแล (item, item_branch, item_avg_per_head) ถือว่าเป็น "สำเนา" ของชีท
// ถ้าไปแก้ในฐานข้อมูลตรงๆ รอบซิงก์ถัดไปจะทับหายทันที
//
// ควรรันที่เครื่อง SQL Server เอง (203.154.185.48) ผ่าน Task Scheduler
// เพราะเครื่องนั้นเปิดตลอดและต่อฐานข้อมูลได้ในเครื่อง ไม่ต้องวิ่งออกเน็ต
// ดูวิธีติดตั้งที่ install-item-sync.ps1

import sql from 'mssql';

const SHEET_ID = '1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw'; // ไฟล์ BOM
const GID_ITEM = '302875824';        // ชีท "item"
const GID_AVG = '1722427042';        // ชีท "ค่าเฉลี่ยยอดใช้ต่อหัว"

// ชีท BOM เก็บบางสาขาเป็น SJP/ZIP แต่ทั้งเว็บใช้ zjp — แปลงให้เหลือรหัสเดียวตั้งแต่ตรงนี้
// จะได้ไม่ต้องขน alias ตามไปทุกคำสั่งแบบโค้ดเดิม (itemBranchAlias, aphAliases)
const BRANCH_ALIAS = { sjp: 'zjp', zip: 'zjp' };
const canonBranch = (b) => {
  const s = String(b ?? '').trim().toLowerCase();
  return BRANCH_ALIAS[s] || s;
};

// ต้องให้ตรงกับ normalizeId ใน apps-script.js เป๊ะ: String(id).replace(/^0+/,'').toLowerCase()
// ถ้าไม่ตรง สินค้าจะจับคู่กับยอดนับ/ยอดยกมาไม่เจอ แล้วตัวเลขจะหายทั้งหน้า
const normCode = (c) => String(c ?? '').trim().replace(/^0+/, '').toLowerCase();

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const config = {
  server: process.env.MSSQL_HOST || 'localhost',
  port: Number(process.env.MSSQL_PORT) || 14322,
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  database: process.env.MSSQL_DATABASE || 'InventoryNarai',
  options: {
    // SQL Server 2019 ที่ไม่ได้ติดตั้งใบรับรอง ต่อแบบ encrypt เต็มรูปแบบไม่ได้
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  requestTimeout: 120000,
};

// อ่านชีทผ่าน gviz (วิธีเดียวกับ api/insert_order.js) — ไม่ต้องใช้ credential ของ Google
// แต่ชีทต้องแชร์แบบ "ใครมีลิงก์ก็ดูได้" ไม่งั้น Google จะตอบหน้า HTML แทน JSON
async function fetchSheetRows(gid, label) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${gid}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`อ่านชีท ${label} ไม่ได้ (HTTP ${res.status})`);
  const txt = await res.text();
  const s = txt.indexOf('{');
  const e = txt.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error(`อ่านชีท ${label} ไม่ได้ (ตรวจการแชร์ลิงก์ของชีท)`);
  const json = JSON.parse(txt.slice(s, e + 1));
  return (json.table.rows || []).map((row) => (i) => (row.c && row.c[i] ? row.c[i].v : null));
}

async function readItemSheet() {
  const rows = await fetchSheetRows(GID_ITEM, 'item');
  const items = [];
  const links = [];
  const seen = new Set();

  for (const cell of rows) {
    const rawCode = String(cell(0) ?? '').trim();
    if (!rawCode) continue;
    const code = normCode(rawCode);
    if (!code || seen.has(code)) continue; // รหัสซ้ำในชีท เอาแถวแรกเป็นหลัก
    seen.add(code);

    const status = String(cell(4) ?? '').trim();
    items.push({
      code_norm: code,
      product_code: rawCode,
      name: String(cell(1) ?? '').trim(),
      price: num(cell(2)),
      unit: String(cell(3) ?? '').trim(),
      status,
      is_active: status === 'ปิดการใช้งาน' ? 0 : 1,
      item_id: num(cell(10)),                       // K
      request_unit: num(cell(11)),                  // L หน่วยเบิก
      store_cat: String(cell(13) ?? '').trim(),     // N
      // ในชีทมีพิมพ์ผิดเป็น "ture" ปนอยู่จริง โค้ดเดิมก็รับทั้งสองแบบ
      plan_only: /^(true|ture)$/i.test(String(cell(14) ?? '').trim()) ? 1 : 0,
    });

    // J = สาขาที่ใช้ เก็บรวมเป็นข้อความเดียว "CRM,HRS,XHH" -> แตกเป็นแถวๆ
    for (const b of String(cell(9) ?? '').split(/[,\s]+/)) {
      const branch = canonBranch(b);
      if (branch) links.push({ branch, code_norm: code });
    }
  }
  return { items, links };
}

async function readAvgSheet() {
  const rows = await fetchSheetRows(GID_AVG, 'ค่าเฉลี่ยยอดใช้ต่อหัว');
  const out = [];
  const seen = new Set();
  for (const cell of rows) {
    const branch = canonBranch(cell(0));
    const code = normCode(cell(1));
    const avg = num(cell(3));
    if (!branch || !code || avg === null) continue;
    const key = `${branch}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ branch, code_norm: code, name: String(cell(2) ?? '').trim(), avg_qty: avg });
  }
  return out;
}

// เอาข้อมูลลงตารางพักก่อน แล้วค่อย MERGE เข้าตารางจริงในทีเดียว
// ทำแบบนี้เพราะยิง INSERT ทีละแถวหลายพันครั้งช้ามาก (บทเรียนเดียวกับที่ทำให้ saveStock หมดเวลารอ)
async function bulkToTemp(tx, tempName, columns, rows) {
  const table = new sql.Table(tempName);
  table.create = true;
  for (const [name, type] of columns) table.columns.add(name, type, { nullable: true });
  for (const r of rows) table.rows.add(...columns.map(([name]) => r[name] ?? null));
  await new sql.Request(tx).bulk(table);
}

async function main() {
  const started = Date.now();

  // อ่านชีทให้ครบก่อนค่อยแตะฐานข้อมูล — ถ้า Google ล่มกลางคันจะได้ไม่เหลือข้อมูลค้างครึ่งๆ
  const { items, links } = await readItemSheet();
  const avgRows = await readAvgSheet();

  // กันเคสที่ Google ตอบมาว่างเปล่า/ตอบหน้า error แล้วเราไปล้างข้อมูลดีๆ ทิ้ง
  if (items.length === 0) throw new Error('ชีท item ไม่มีข้อมูลเลย — ยกเลิกการซิงก์ (ไม่แตะฐานข้อมูล)');
  if (links.length === 0) throw new Error('ชีท item ไม่มีคอลัมน์สาขาที่ใช้เลย — ยกเลิกการซิงก์');

  const pool = await sql.connect(config);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await bulkToTemp(tx, '#src_item', [
      ['code_norm', sql.NVarChar(32)], ['product_code', sql.NVarChar(32)],
      ['name', sql.NVarChar(255)], ['price', sql.Decimal(14, 4)],
      ['unit', sql.NVarChar(32)], ['status', sql.NVarChar(60)], ['is_active', sql.Bit],
      ['item_id', sql.Int], ['request_unit', sql.Decimal(14, 3)],
      ['store_cat', sql.NVarChar(120)], ['plan_only', sql.Bit],
    ], items);

    await bulkToTemp(tx, '#src_link', [
      ['branch', sql.NVarChar(10)], ['code_norm', sql.NVarChar(32)],
    ], links);

    await bulkToTemp(tx, '#src_avg', [
      ['branch', sql.NVarChar(10)], ['code_norm', sql.NVarChar(32)],
      ['name', sql.NVarChar(255)], ['avg_qty', sql.Decimal(18, 6)],
    ], avgRows);

    const req = new sql.Request(tx);

    // สินค้าที่หายไปจากชีท (ทีม QC/RD กด deleteItem) ไม่ลบทิ้ง แค่ปิดใช้งาน
    // เพราะยอดนับ/ใบเบิกเก่ายังอ้างถึงรหัสนั้นอยู่ ลบจริงจะทำให้ประวัติอ่านไม่รู้เรื่อง
    await req.batch(`
      MERGE dbo.item AS t
      USING (SELECT DISTINCT code_norm, product_code, name, price, unit, status,
                    is_active, item_id, request_unit, store_cat, plan_only
               FROM #src_item) AS s
         ON t.code_norm = s.code_norm
      WHEN MATCHED THEN UPDATE SET
            t.product_code = s.product_code, t.name = s.name, t.price = s.price,
            t.unit = s.unit, t.status = s.status, t.is_active = s.is_active,
            t.item_id = s.item_id, t.request_unit = s.request_unit,
            t.store_cat = s.store_cat, t.plan_only = s.plan_only,
            t.updated_at = SYSDATETIME()
      WHEN NOT MATCHED BY TARGET THEN
            INSERT (code_norm, product_code, name, price, unit, status, is_active,
                    item_id, request_unit, store_cat, plan_only, updated_at)
            VALUES (s.code_norm, s.product_code, s.name, s.price, s.unit, s.status,
                    s.is_active, s.item_id, s.request_unit, s.store_cat, s.plan_only,
                    SYSDATETIME());

      UPDATE t SET t.is_active = 0, t.updated_at = SYSDATETIME()
        FROM dbo.item AS t
       WHERE t.is_active = 1
         AND NOT EXISTS (SELECT 1 FROM #src_item s WHERE s.code_norm = t.code_norm);
    `);

    // สาขาที่ใช้: ตัดออก/เพิ่มเข้าตามชีท (ตารางเล็ก เทียบตรงๆ ได้เลย)
    await req.batch(`
      DELETE t FROM dbo.item_branch AS t
       WHERE NOT EXISTS (SELECT 1 FROM #src_link s
                          WHERE s.branch = t.branch AND s.code_norm = t.code_norm);

      INSERT INTO dbo.item_branch (branch, code_norm)
      SELECT DISTINCT s.branch, s.code_norm
        FROM #src_link s
        JOIN dbo.item i ON i.code_norm = s.code_norm
       WHERE NOT EXISTS (SELECT 1 FROM dbo.item_branch t
                          WHERE t.branch = s.branch AND t.code_norm = s.code_norm);
    `);

    // ค่าเฉลี่ยต่อหัว: อัปเดต/เพิ่ม แต่ไม่ลบ (แถวที่หายจากชีทปล่อยค้างไว้ ไม่มีผลเสีย)
    await req.batch(`
      MERGE dbo.item_avg_per_head AS t
      USING (SELECT branch, code_norm, name, avg_qty FROM #src_avg) AS s
         ON t.branch = s.branch AND t.code_norm = s.code_norm
      WHEN MATCHED AND (t.avg_qty <> s.avg_qty OR t.name <> s.name) THEN
            UPDATE SET t.avg_qty = s.avg_qty, t.name = s.name, t.updated_at = SYSDATETIME()
      WHEN NOT MATCHED BY TARGET THEN
            INSERT (branch, code_norm, name, avg_qty, updated_at)
            VALUES (s.branch, s.code_norm, s.name, s.avg_qty, SYSDATETIME());
    `);

    await tx.commit();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ซิงก์สำเร็จ — สินค้า ${items.length} รายการ, ` +
                `คู่สาขา-สินค้า ${links.length}, ค่าเฉลี่ยต่อหัว ${avgRows.length} (${secs} วิ)`);
  } catch (err) {
    await tx.rollback(); // ล้มกลางคัน = ไม่เขียนอะไรเลย ข้อมูลเดิมยังอยู่ครบ
    throw err;
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] ซิงก์ไม่สำเร็จ:`, err.message);
  process.exit(1); // exit code ไม่ใช่ 0 เพื่อให้ Task Scheduler เห็นว่าพลาด
});
