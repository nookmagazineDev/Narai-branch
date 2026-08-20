# ย้ายฝั่งสต๊อกจาก Google Sheets ไป SQL Server (InventoryNarai)

ข้อมูลฝั่งสต๊อกทั้งหมดยังอยู่ใน Google Sheets ผ่าน Apps Script (`apps-script.js`)
เอกสารนี้คือขั้นแรกของการย้าย: **สร้างตารางและย้ายข้อมูลเข้า SQL Server ให้ครบก่อน**
โดยยังไม่แตะหน้าเว็บและยังไม่เปลี่ยนเส้นทางของ action ใดๆ

```
ตอนนี้     เบราว์เซอร์ ──apiCall(action สต๊อก)──→ Apps Script ──→ Google Sheets   (ตัวจริง)
ขั้นนี้                                                              └──คัดลอก──→ InventoryNarai
ขั้นถัดไป  เบราว์เซอร์ ──apiCall(action สต๊อก)──→ /api/... ──→ office-server ──→ InventoryNarai
```

ทำแบบนี้เพราะย้ายข้อมูลอย่างเดียวยังไม่กระทบใคร ถ้าข้อมูลเข้าไม่ครบหรือคอลัมน์เพี้ยน
ก็แก้แล้วรันใหม่ได้เรื่อยๆ โดยที่สาขายังทำงานบนชีทเหมือนเดิมทุกอย่าง

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|---|---|
| `docs/schema-inventory.sql` | สร้างตารางทั้ง 16 ตาราง รันครั้งเดียว |
| `scripts/migrate-inventory.mjs` | อ่านชีททั้งหมดแล้วเขียนลง InventoryNarai |
| `apps-script.js` | ตัวจริงที่ยังใช้งานอยู่ — เป็นที่มาของโครงสร้างทุกตาราง |

## ตารางที่สร้าง

| ตาราง | มาจากชีท | ชนิด |
|---|---|---|
| `inv_item` | `item` (ไฟล์ BOM) | สถานะปัจจุบัน |
| `inv_item_branch` | คอลัมน์ J ของ `item` แตกเป็นแถวๆ | สถานะปัจจุบัน |
| `inv_price` | `8.2` (ราคากลาง) | สถานะปัจจุบัน |
| `inv_stock_count` | `ข้อมูลนับสตอค` | log ต่อท้าย |
| `inv_balance` | `ยอดยกมา` | สถานะปัจจุบัน |
| `inv_request` | `ข้อมูลเบิก` | log ต่อท้าย |
| `inv_storage_category` | `หมวดจัดเก็บสาขา` | สถานะปัจจุบัน |
| `inv_month_end` | `ปิดรอบสิ้นเดือน` | log ต่อท้าย |
| `inv_sup_cost` | `ต้นทุนจากsup` | log ต่อท้าย |
| `inv_waste` | `waste` | log ต่อท้าย |
| `inv_plan_order` | `plan` | log ต่อท้าย |
| `inv_dispatch` | `จัดของ` | log ต่อท้าย |
| `inv_goods_received` | `รับของ` | log ต่อท้าย |
| `inv_order_cancel` | `ยกเลิกใบเบิก` | log ต่อท้าย |
| `inv_branch_percent` | `เปอร์เซ็นการเบิกของแต่ละสาขา` | ประวัติรายวัน |
| `inv_avg_per_head` | `ค่าเฉลี่ยยอดใช้ต่อหัว` | สถานะปัจจุบัน |

### รหัสสินค้าเก็บสองคอลัมน์ คนละหน้าที่

| คอลัมน์ | ใช้ทำอะไร | มี 0 นำหน้าไหม |
|---|---|---|
| `item_code` | แสดงผล / ทำรายงาน / ส่งออก | **มีครบ** |
| `item_code_norm` | join ระหว่างตารางเท่านั้น ห้ามเอาไปแสดง | ตัดออก |

ที่ต้องมีสองอันเพราะรหัสในชีทปนกันทั้งแบบตัวเลข `5001` และข้อความ `'05001'` —
Apps Script เองก็ normalize ก่อนจับคู่ทุกครั้ง (`normalizeId`) ถ้าไม่ทำ การ join จะพลาดแบบเงียบๆ

**แถวที่ 0 นำหน้าหายไปตั้งแต่ในชีทแล้ว จะถูกเติมกลับให้ตอนจบ** — สคริปต์ลอกรหัสตัวเต็ม
จาก `inv_item` (แท็บ `item` เก็บรหัสเป็นข้อความ จึงมี 0 ครบ) มาใส่ทุกตารางที่จับคู่ได้
ด้วย `item_code_norm` แล้วรายงานให้ดูว่าแก้ไปกี่แถวต่อตาราง

สั่งทำขั้นนี้ซ้ำเมื่อไหร่ก็ได้โดยไม่ต้องอ่านชีทใหม่

```cmd
node scripts\migrate-inventory.mjs --fix-codes --user narai_web --pass "<รหัสผ่าน>"
```

แถวที่จับคู่กับรายการสินค้าไม่ได้ (สินค้าที่ถูกลบออกจากแท็บ `item` ไปแล้ว) จะปล่อยไว้ตามเดิม
ไม่ได้เดารหัสให้ เพราะไม่มีข้อมูลพอจะรู้ว่ารหัสเต็มมี 0 กี่ตัว — ตรวจได้ด้วย SQL ท้ายเอกสาร

## ขั้นตอน

### 1. สร้างตาราง

```cmd
sqlcmd -S localhost -U narai_web -P "<รหัสผ่าน>" -i docs\schema-inventory.sql
```

ฐานข้อมูล `InventoryNarai` ต้องมีอยู่แล้ว (ถ้ายังไม่มี ไฟล์นี้สร้างให้เอง)
แล้วให้สิทธิ์ `narai_web` ตามคำสั่งท้ายไฟล์

### 2. ตรวจว่าจับคอลัมน์ถูกก่อนเสมอ

**ข้อนี้ห้ามข้าม** โครงสร้างทุกตารางถอดมาจากโค้ด `apps-script.js` ไม่ได้เปิดดูชีทจริง
ถ้าชีทไหนมีการแทรกคอลัมน์เพิ่มหลังจากนั้น ข้อมูลจะเข้าผิดช่องแบบเงียบๆ

```cmd
node scripts/migrate-inventory.mjs --list
node scripts/migrate-inventory.mjs --inspect=item
node scripts/migrate-inventory.mjs --inspect=count
```

`--inspect` พิมพ์ให้ดูสองอย่าง: แถวดิบจากชีท 3 แถวแรก กับผลที่แปลงเป็นแถวตารางแล้ว
ตรวจให้ตรงทีละชุดก่อนย้ายจริง โดยเฉพาะชุดใหญ่ (`item`, `count`, `request`)

### 3. นับแถวก่อน (ยังไม่เขียน)

```cmd
node scripts/migrate-inventory.mjs --dry-run
```

อ่านชีททุกไฟล์แล้วรายงานว่าอ่านได้กี่แถว ใช้ได้กี่แถว ยุบแถวซ้ำไปเท่าไหร่
และมีกี่ช่องที่แปลงวันที่ไม่ได้ — ยังไม่ต่อฐานข้อมูลเลยในโหมดนี้

### 4. ย้ายจริง

```cmd
node scripts/migrate-inventory.mjs --user narai_web --pass "<รหัสผ่าน>"
```

ตารางไหนมีข้อมูลอยู่แล้วจะ **ข้ามไป** ไม่เขียนทับ (กันเขียนซ้ำโดยไม่ตั้งใจ)
ถ้าต้องการล้างแล้วเขียนใหม่ให้ใส่ `--replace` — รันซ้ำได้ตลอดจนกว่าจะพอใจ

เลือกทำทีละชุดได้ด้วย `--only=item,item-branch,price`

## ข้อควรรู้

- ชีททุกไฟล์ต้องตั้งลิงก์เป็น **"ผู้ที่มีลิงก์ • ผู้อ่าน"** ก่อน (สคริปต์อ่านแบบไม่ล็อกอิน)
  มี 5 ไฟล์: สต๊อก, BOM (item), จัดของ/รับของ, ต้นทุนจากsup, ยอดขาย/เป้าหมาย
- ชุดที่รู้ `gid` จะดึงผ่าน export CSV เพราะ **ไม่สนใจตัวกรองที่เปิดค้างไว้ในชีท**
  ส่วนชุดที่รู้แค่ชื่อแท็บใช้ gviz ซึ่งโดนตัวกรองบังข้อมูลได้ (ตอนย้ายตารางงานเคยเจอ
  gviz คืนมา 496 แถวจากหมื่นกว่าแถว) **ถ้าจำนวนแถวดูน้อยผิดปกติ ให้หา gid มาใส่**
  ด้วย `--gid-<ชุด>=<เลข>` (เลข gid ดูได้ที่ท้าย URL ตอนเปิดแท็บนั้น)
- แถวซ้ำคีย์ในชุดที่มี PK จะเก็บ **แถวล่างสุด** ไว้ (ตีความว่าใหม่กว่า) แล้วรายงานให้ดูว่ายุบไปเท่าไหร่

## หลังย้ายเสร็จ ตรวจอะไรบ้าง

```sql
USE InventoryNarai;
SELECT 'inv_item' AS ตาราง, COUNT(*) AS แถว FROM dbo.inv_item
UNION ALL SELECT 'inv_stock_count', COUNT(*) FROM dbo.inv_stock_count
UNION ALL SELECT 'inv_request',     COUNT(*) FROM dbo.inv_request
UNION ALL SELECT 'inv_balance',     COUNT(*) FROM dbo.inv_balance;

-- ยอดนับล่าสุดของสาขาหนึ่ง เทียบกับที่เห็นในหน้านับสต๊อกได้เลย
SELECT TOP 20 counted_at, item_code, item_name, remaining, counter_name
  FROM dbo.inv_stock_count WHERE branch = 'crm' ORDER BY count_id DESC;

-- สินค้าที่ไม่มีสาขาไหนใช้เลย (คอลัมน์ J ว่าง) — ถ้าเยอะผิดปกติแปลว่าจับคอลัมน์ผิด
SELECT COUNT(*) FROM dbo.inv_item i
 WHERE NOT EXISTS (SELECT 1 FROM dbo.inv_item_branch b WHERE b.item_code = i.item_code);

-- รหัสในตารางลูกที่จับคู่กับรายการสินค้าไม่ได้ (ขั้นเติมรหัสแตะไม่ถึง)
SELECT TOP 20 item_code, item_code_norm, item_name, COUNT(*) AS แถว
  FROM dbo.inv_stock_count c
 WHERE NOT EXISTS (SELECT 1 FROM dbo.inv_item i WHERE i.item_code_norm = c.item_code_norm)
 GROUP BY item_code, item_code_norm, item_name ORDER BY COUNT(*) DESC;
```

## ยังไม่ได้ทำในขั้นนี้

ย้าย action ฝั่งสต๊อกมาอ่าน-เขียนที่ SQL Server (ยังวิ่งไป Apps Script ทั้งหมด)
ลำดับที่แนะนำเมื่อพร้อมทำต่อ

1. ข้อมูลหลัก — `getClosingItems`, `updateStorageCategory`, `saveBranchPercentagesBulk`, `saveAvgPerHead`
2. นับสต๊อกและขอเบิก — `getStockItems`, `saveStock` (ชิ้นใหญ่สุด ได้ประโยชน์มากสุด)
3. WASTE / รับสินค้า — `saveWaste`, `getGoodsToReceive`, `saveGoodsReceived`, `confirmReceivedItem`
4. ปิดยอดสิ้นเดือน — `getMonthEndClosing`, `saveMonthEndClosing`, `getStockTotal` (ตรรกะบัญชีเยอะสุด ทำท้ายสุด)

ทำทีละกลุ่มแล้วเพิ่มชื่อ action ลงใน `SQL_ACTIONS` (`src/services/api.js`) เว็บใช้งานได้ตลอดไม่ต้องหยุดระบบ
เส้นทางฝั่งเซิร์ฟเวอร์ใช้ทางเดียวกับตารางงาน คือผ่าน office-server (ดู `docs/hr-sql-migration.md`)
