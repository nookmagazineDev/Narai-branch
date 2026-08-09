# ย้ายข้อมูลหน้านับสต๊อกจาก Google Sheets ไป SQL Server

เป้าหมาย: หน้า "นับสต๊อกและขอเบิก" โหลดเร็วขึ้นและ**ไม่ช้าลงตามอายุการใช้งาน**

ตอนนี้ `getStockItems` อ่าน **ทั้งชีท 5 ใบ** แล้วกรองเป็นรายสาขาด้วย JavaScript
เพราะ Google Sheets ไม่มี index — ชีท `ข้อมูลนับสตอค` มี 25,000+ แถวและโตทุกวัน
ใช้เวลา ~20 วิต่อครั้ง ย้ายมา SQL แล้วกรองที่ฐานข้อมูลจะเหลือ ~300 แถวที่ใช้จริง

## เครื่องปลายทาง

```
203.154.185.48 : 14322     NARAI-PIZZARIA\SQLEXPRESS
                           Microsoft SQL Server 2019 Express (15.0.2000)
                           ฐานข้อมูล InventoryNarai
```

เครื่องนี้คือ `inventory.dyndns.tv` — เครื่องคลาวด์ที่เปิดตลอด IP นิ่ง
คนละเครื่องกับ office-server ที่ออฟฟิศ (`storenarai.dyndns.tv` = 183.89.248.221)

⚠️ **เครื่องนี้มีทั้ง MySQL และ SQL Server อยู่ด้วยกัน อย่าสับสน**

| | ตัวไหน | ใครใช้ |
|---|---|---|
| พอร์ต 3306 | **MySQL** ฐาน `myfbdata` | POS — `api/orderd.js`, `withdrawals.js`, `pending_orders.js`, `insert_order.js` ผ่าน `lib/mysql.js` |
| พอร์ต 14322 | **SQL Server Express** ฐาน `InventoryNarai` | ← ที่จะย้ายข้อมูลสต๊อกมาไว้ |

SQL Server Express จำกัดฐานละ 10 GB — ข้อมูลชุดนี้หลักหมื่นแถว ใช้ไม่ถึง 1% ไม่ต้องห่วง

## ลำดับการทำ

### 1. สร้างโครงฐานข้อมูล

เปิดใน SQL Server Management Studio แล้วกด **Execute (F5)** **ตามลำดับ**:

1. `001_stock_schema.sql` — ข้อมูลที่สาขากรอก (นับสต๊อก, ขอเบิก, ยอดยกมา, หมวดจัดเก็บ)
2. `002_item_schema.sql` — รายการสินค้าจากไฟล์ BOM (item, สาขาที่ใช้, ค่าเฉลี่ยต่อหัว)

ต้องรัน 001 ก่อนเสมอ เพราะ 002 ไม่ได้สร้าง database ให้
รันซ้ำได้ปลอดภัย ทุกคำสั่งเช็คก่อนว่ามีของเดิมอยู่แล้วหรือยัง

จากนั้นเลื่อนไปท้ายไฟล์ **แก้รหัสผ่านของ `narai_app` แล้วเอาคอมเมนต์ `/* */` ออก** เพื่อสร้าง
login ที่เว็บจะใช้ (อ่าน/เพิ่ม/แก้ได้ แต่ `DENY DELETE` ไว้ และแตะฐานอื่นไม่ได้)

> อย่าให้เว็บใช้บัญชี `administrator` — เว็บต่อมาจากอินเทอร์เน็ต ถ้ารหัสหลุดคือเสียทั้งเครื่อง
> และต้องเปิด **Mixed Mode Authentication** ที่เซิร์ฟเวอร์ด้วย เพราะ Vercel ใช้ Windows Auth ไม่ได้
> (คลิกขวาชื่อเซิร์ฟเวอร์ใน SSMS → Properties → Security → *SQL Server and Windows Authentication mode* → รีสตาร์ท service)

### 2. ย้ายข้อมูลเก่าเข้ามา (backfill)

ส่งออกจาก Google Sheets ทีละชีทเป็น CSV (ไฟล์ → ดาวน์โหลด → CSV)
แล้วใช้ SSMS: คลิกขวาที่ฐาน `InventoryNarai` → **Tasks → Import Flat File**

import เข้า **ตารางพักชื่อ `staging_xxx` ก่อน** (ให้ทุกคอลัมน์เป็นข้อความ) แล้วค่อยแปลงเข้าตารางจริง
เพราะข้อมูลจากชีทเป็นข้อความล้วน ถ้ายัดเข้าตารางจริงตรงๆ จะติด error เรื่องชนิดข้อมูล

**2 จุดที่พลาดบ่อยที่สุด:**

**ก. วันที่** — ชีทเก็บเป็นข้อความ `dd/MM/yyyy HH:mm:ss` ต้องแปลงด้วย `CONVERT(..., 103)`
(style 103 = dd/mm/yyyy) ถ้าปล่อยให้ SQL Server เดาเอง มันจะอ่านเป็น MM/dd/yyyy แล้ววันที่เพี้ยนทั้งชุด

**ข. รหัสสินค้า** — ต้อง normalize ให้ตรงกับโค้ดเดิมเป๊ะ `String(id).replace(/^0+/, '').toLowerCase()`
ถ้าทำไม่ตรง สินค้าจะจับคู่ไม่เจอแล้วยอดยกมาหาย ใน T-SQL คือ:

```sql
LOWER(SUBSTRING(LTRIM(RTRIM(code)), PATINDEX('%[^0]%', LTRIM(RTRIM(code)) + 'x'), 32))
```

(`+ 'x'` ไว้กันกรณีรหัสเป็น 0 ล้วน ไม่งั้น `PATINDEX` คืน 0 แล้ว `SUBSTRING` พัง)

ตัวอย่างเต็มสำหรับชีท `ข้อมูลนับสตอค`:

```sql
INSERT INTO dbo.stock_count
      (branch, product_code, code_norm, product_name, unit, qty, counter_name, counted_at)
SELECT LOWER(LTRIM(RTRIM(สาขา))),
       LTRIM(RTRIM(รหัสสินค้า)),
       LOWER(SUBSTRING(LTRIM(RTRIM(รหัสสินค้า)),
                       PATINDEX('%[^0]%', LTRIM(RTRIM(รหัสสินค้า)) + 'x'), 32)),
       ชื่อสินค้า,
       หน่วย,
       TRY_CONVERT(DECIMAL(14,3), NULLIF(LTRIM(RTRIM(จำนวนคงเหลือ)), '')),
       ชื่อพนักงานนับสต๊อก,
       CONVERT(DATETIME2(0), วันที่ลงข้อมูล, 103)
  FROM dbo.staging_stock_count;
```

ชีทอื่นใช้หลักเดียวกัน ต่างแค่ลำดับคอลัมน์:

| ไฟล์ | ชีท | ตาราง | คอลัมน์ตามลำดับ |
|---|---|---|---|
| สต๊อก | ข้อมูลนับสตอค | `stock_count` | วันที่, ผู้นับ, สาขา, รหัส, ชื่อ, หน่วย, คงเหลือ |
| สต๊อก | ข้อมูลเบิก | `stock_request` | เลขที่ใบเบิก, วันที่บันทึก, รหัส, ชื่อ, หน่วย, จำนวน, วันที่เบิก, ผู้เบิก, สาขา |
| สต๊อก | ยอดยกมา | `stock_balance` | รหัส, ชื่อ, สาขา, ยอดยกมา, วันที่อัปเดต |
| สต๊อก | หมวดจัดเก็บสาขา | `stock_storage_category` | รหัส, ชื่อ, สาขา, หมวดจัดเก็บ |
| BOM | item | `item` + `item_branch` | A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ J=สาขาที่ใช้ K=itemid L=หน่วยเบิก N=หมวดสโตร์ O=Plan |
| BOM | ค่าเฉลี่ยยอดใช้ต่อหัว | `item_avg_per_head` | สาขา, รหัส, ชื่อ, ค่าเฉลี่ยต่อหัว |

### 2.1 ชีท `item` — ต้องแตกคอลัมน์ J ออกเป็นแถว

คอลัมน์ J เก็บสาขาที่ใช้รวมกันเป็นข้อความเดียว `"CRM,HRS,XHH"` โค้ดเดิมจึงต้องอ่าน
ทั้งชีทแล้ว `split(',')` ทีละแถวทุกครั้งที่เปิดหน้า ตอนย้ายต้องแตกเป็น 1 แถว = 1 คู่ (สาขา, สินค้า)
ลง `item_branch` ไม่งั้นจะเสียประโยชน์ของ index ไปเปล่าๆ

```sql
-- ตัวสินค้าเอง
INSERT INTO dbo.item (code_norm, product_code, name, price, unit, status, is_active,
                      item_id, request_unit, store_cat, plan_only)
SELECT LOWER(SUBSTRING(LTRIM(RTRIM(A)), PATINDEX('%[^0]%', LTRIM(RTRIM(A)) + 'x'), 32)),
       LTRIM(RTRIM(A)), B,
       TRY_CONVERT(DECIMAL(14,4), NULLIF(LTRIM(RTRIM(C)), '')), D, E,
       CASE WHEN LTRIM(RTRIM(E)) = N'ปิดการใช้งาน' THEN 0 ELSE 1 END,
       TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(K)), '')),
       TRY_CONVERT(DECIMAL(14,3), NULLIF(LTRIM(RTRIM(L)), '')),
       N,
       CASE WHEN LOWER(LTRIM(RTRIM(O))) IN ('true', 'ture') THEN 1 ELSE 0 END
  FROM dbo.staging_item
 WHERE LTRIM(RTRIM(A)) <> '' OR LTRIM(RTRIM(B)) <> '';

-- แตกคอลัมน์ J: "CRM,HRS,XHH" -> 3 แถว (STRING_SPLIT มีใน SQL Server 2016 ขึ้นไป)
INSERT INTO dbo.item_branch (branch, code_norm)
SELECT DISTINCT
       LOWER(LTRIM(RTRIM(s.value))),
       LOWER(SUBSTRING(LTRIM(RTRIM(t.A)), PATINDEX('%[^0]%', LTRIM(RTRIM(t.A)) + 'x'), 32))
  FROM dbo.staging_item AS t
 CROSS APPLY STRING_SPLIT(REPLACE(t.J, ' ', ''), ',') AS s
 WHERE LTRIM(RTRIM(s.value)) <> '';
```

> `plan_only` เช็คทั้ง `true` และ `ture` เพราะในชีทมีพิมพ์ผิดปนอยู่จริง
> (โค้ดเดิมก็รับทั้งสองแบบ — ดู `apps-script.js` ฟิลด์ `planOnly`)

### 2.2 ⚠️ รหัสสาขาในชีท BOM ไม่ตรงกับที่เว็บใช้

ชีท BOM เก็บบางสาขาเป็น `SJP` แต่เว็บส่งมาเป็น `zjp` โค้ดเดิมเลยต้องมีตารางแปลง
alias กระจายอยู่หลายที่ (`itemBranchAlias` ใน `getStockItems`, `aphAliases` ใน `saveAvgPerHead`)

**ตอนย้ายให้แก้ที่ข้อมูลเลย อย่าขนความยุ่งนี้ตามมา** — แปลงให้เหลือรหัสเดียวคือ `zjp`
(รหัสที่เว็บใช้ ซึ่งจะเป็นค่าที่ `saveStock` เขียนลงตารางอื่นๆ ทั้งหมด) แล้วโค้ดใหม่จะไม่ต้องมี alias เลย

```sql
UPDATE dbo.item_branch       SET branch = N'zjp' WHERE branch IN (N'sjp', N'zip');
UPDATE dbo.item_avg_per_head SET branch = N'zjp' WHERE branch IN (N'sjp', N'zip');
```

(รันก่อนสร้าง PK ซ้ำจะติด — ถ้าเจอ error เรื่องคีย์ซ้ำ แปลว่ามีทั้ง `sjp` และ `zjp`
ของสินค้าตัวเดียวกันอยู่แล้ว ให้ลบตัวซ้ำออกก่อนแล้วค่อยแปลง)

### 3. ตั้งตัวนับเลขที่ใบเบิกให้ต่อจากของเดิม

ไม่งั้นใบเบิกใบแรกหลังย้ายจะได้เลขซ้ำกับใบเก่า
(เลขที่ใบเบิกรูปแบบ `CRM` + `yyMM` + running 3 หลัก เช่น `CRM2608001`)

```sql
INSERT INTO dbo.stock_doc_counter (branch, ym, last_no)
SELECT branch,
       SUBSTRING(doc_no, 4, 4),
       MAX(TRY_CONVERT(INT, SUBSTRING(doc_no, 8, 10)))
  FROM dbo.stock_request
 WHERE doc_no <> ''
   AND NOT EXISTS (SELECT 1 FROM dbo.stock_doc_counter c
                    WHERE c.branch = stock_request.branch
                      AND c.ym = SUBSTRING(stock_request.doc_no, 4, 4))
 GROUP BY branch, SUBSTRING(doc_no, 4, 4);
```

### 4. ตรวจว่าข้อมูลครบ

เทียบจำนวนแถวรายสาขากับในชีทก่อนเปลี่ยนโค้ด

```sql
SELECT branch AS สาขา, COUNT(*) AS แถว,
       MIN(counted_at) AS เก่าสุด, MAX(counted_at) AS ล่าสุด
  FROM dbo.stock_count GROUP BY branch ORDER BY branch;
```

### 5. เปลี่ยนโค้ด (ยังไม่ได้ทำ)

**ต้องเพิ่มไดรเวอร์ก่อน** — `lib/mysql.js` ใช้ `mysql2` ซึ่งคุยกับ SQL Server ไม่ได้เลย
ต้องเพิ่มแพ็กเกจ `mssql` และเขียน `lib/mssql.js` แยกต่างหาก (pool คนละตัวกับ MySQL ของ POS)

จากนั้นทำทีละขั้น:

1. **อ่านก่อน** — เพิ่ม `api/stock_items.js` ให้หน้านับสต๊อกอ่านจาก SQL Server
   (ใช้วิว `v_branch_item` join กับ `stock_count` / `stock_request` / `stock_balance`)
   ส่วน `saveStock` ยังเขียนลงชีทเหมือนเดิม → ได้ความเร็วทันที ถอยกลับได้ทุกเมื่อ
2. **เขียนสองที่** — `saveStock` เขียนทั้ง SQL Server และชีท
   เพราะ `api/stockcount.js` ยังอ่านชีท `ข้อมูลนับสตอค` ผ่าน gviz อยู่ (หน้ามูลค่าสต๊อก/ปิดยอด)
   ถ้าเลิกเขียนลงชีทเลย **หน้านั้นพังทันที**
3. **ตัดชีทออก** — เมื่อย้าย `api/stockcount.js` มาอ่าน SQL Server แล้ว

จุดที่ต้องแก้ให้ครบตอนย้ายฝั่ง item (ถ้าลืมข้อไหน จะเหลือของค้างครึ่งๆ):

| ที่ต้องแก้ | ตอนนี้อ่านอะไร | ย้ายไปใช้ |
|---|---|---|
| `getStockItems` (apps-script) | ชีท item A-O | `v_branch_item` |
| `getClosingItems` (apps-script) | ชีท item A-J | `v_branch_item` |
| `api/insert_order.js?units=1` | ชีท item K, L ผ่าน gviz | `item.item_id`, `item.request_unit` |
| `api/stockcount.js?avgperhead=1` | ชีทค่าเฉลี่ยต่อหัว ผ่าน gviz | `item_avg_per_head` |
| `saveAvgPerHead` (apps-script) | **เขียน**ลงชีทค่าเฉลี่ยต่อหัว | MERGE เข้า `item_avg_per_head` |

> ใครเป็นคนดูแลชีท `item`? ถ้าทีมอื่นยังแก้ผ่าน Google Sheets อยู่ ต้องมีตัว sync
> จากชีทเข้า SQL Server เป็นรอบๆ (เช่นทุกชั่วโมง) ไม่งั้นสินค้าใหม่จะไม่ขึ้นในเว็บ
> — ข้อนี้ต้องเคาะกับทีมก่อนตัดชีทออกจริง

> ⚠️ ตอนเพิ่มไฟล์ใน `api/` ระวังลิมิต Vercel — ตอนนี้มี 12 ไฟล์ = 12 Serverless Functions
> ซึ่งเป็นเพดานพอดี (ดูคอมเมนต์ที่ `lib/mysql.js:2`) อาจต้องยุบ endpoint รวมกันหรืออัปแพลน

## ตั้งค่า Vercel

ตั้งเป็นชื่อใหม่ **อย่าไปทับ `MYSQL_*` เดิม** เพราะนั่นคือ MySQL ของ POS คนละตัวกัน

| Environment Variable | ค่า |
|---|---|
| `MSSQL_HOST` | `inventory.dyndns.tv` |
| `MSSQL_PORT` | `14322` |
| `MSSQL_USER` | `narai_app` |
| `MSSQL_PASSWORD` | รหัสที่ตั้งไว้ตอนสร้าง login |
| `MSSQL_DATABASE` | `InventoryNarai` |

ฝั่ง `mssql` ต้องตั้ง `options.encrypt` ให้ตรงกับเซิร์ฟเวอร์ด้วย (SQL Server 2019 ที่ไม่ได้ติดตั้ง
ใบรับรอง มักต้องใช้ `encrypt: false` หรือ `trustServerCertificate: true`)
