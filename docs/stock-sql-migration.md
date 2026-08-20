# ย้ายหน้านับสต๊อกจาก Google Sheets ไป SQL Server

เอกสารนี้เป็นภาคต่อของ [hr-sql-migration.md](hr-sql-migration.md) ซึ่งย้ายส่วนตารางงานไปแล้ว
เส้นทาง ตัวส่งต่อ และกติกาเรื่อง user/สาขา ใช้ของเดิมทั้งหมด ไม่ได้ทำใหม่

**ฐานข้อมูล:** ตารางสต๊อกอยู่ที่ `InventoryNarai` ส่วนตารางงานอยู่ที่ `narai_hr` —
คนละฐานข้อมูลแต่อยู่บนอินสแตนซ์เดียวกัน (`NARAI-PIZZARIA\SQLEXPRESS`) ใช้ host และ login ชุดเดียวกัน
office-server จึงต่อสอง pool จากค่าตั้งชุดเดียว ไม่ได้ query ข้ามฐานข้อมูลด้วยชื่อเต็ม
(`InventoryNarai.dbo.xxx`) เพราะถ้าวันหนึ่งแยกไปคนละเครื่อง คำสั่งแบบนั้นจะพังทั้งหมด
เปลี่ยนชื่อฐานข้อมูลได้ที่ `STOCK_DB_NAME` ใน `.env` ของ office-server

```
เบราว์เซอร์ -> /api/schedule (Vercel, เป็นแค่ตัวส่งต่อ) -> office-server :8787/schedule -> SQL Server
```

## สถานะตอนนี้

| เฟส | สิ่งที่ทำ | สถานะ |
|---|---|---|
| 1 | ตาราง + ย้ายข้อมูลเก่า | **เสร็จแล้ว** — ย้ายขึ้นเครื่องจริงแล้ว (การนับ 70,785 แถว) |
| 2 | อ่านจาก SQL (`getStockItems`, `getStockTotal`) | **เขียนเสร็จ** รอเปิดใช้พร้อมเฟส 3 |
| 3 | บันทึกลง SQL (เลิกเขียนชีท) | **เขียนเสร็จ** — `saveStock`, `updateStorageCategory`, `saveAvgPerHead`, `saveBranchPercentagesBulk` |
| 4 | ย้ายตัวอ่านที่เหลือมาที่ SQL | **กำลังทำ** — การ์ดมูลค่าสต๊อก, ปิดรอบสิ้นเดือน, ของเสีย |

**ตัดสินใจแล้วว่าไม่ mirror กลับชีท** — ชีท "ข้อมูลเบิก" ในไฟล์สต๊อกเป็นแค่สมุดบันทึกซ้ำ
ไม่มีใครอ่านนอกจาก Apps Script เอง ส่วนใบเบิก/ใบสั่ง/ใบรับที่หน้าเว็บแสดงดึงจาก MySQL ของ POS
(`api/withdrawals.js`, `api/pending_orders.js`, `api/orderd.js`, `api/insert_order.js`) ไม่ได้อ่านชีท

**ยังห้ามเปิด `SQL_ACTIONS` จนกว่าเฟส 4 จะเสร็จ** — ทั้งชุดต้องสลับพร้อมกันเพราะผูกกันหมด
(อ่านยอดนับจาก SQL ต้องคู่กับบันทึกลง SQL) และการ์ดมูลค่าสต๊อกบน Dashboard ยังอ่านชีทอยู่
ถ้าเลิกเขียนชีทก่อนย้ายตัวนั้น การ์ดจะค้างนิ่งทันทีโดยไม่มีอะไรฟ้อง

## ไฟล์ที่เกี่ยวข้อง

| ไฟล์ | หน้าที่ |
|---|---|
| `docs/schema-stock.sql` | ตารางทั้งหมดของฝั่งสต๊อก (ฐานข้อมูล `InventoryNarai`) |
| `scripts/migrate-stock.mjs` | ย้ายข้อมูลเก่าจากชีทเข้า SQL (มีโหมด `--inspect` / `--dry-run`) |
| `office-server/stock.js` | ตรรกะอ่านของ `getStockItems` / `getStockTotal` |
| `office-server/hr-db.js` | ตัวเชื่อมฐานข้อมูล (แยกออกจาก `schedule.js` เพื่อให้สองไฟล์ใช้ร่วมกัน) |
| `office-server/hr-session.js` | user ที่ล็อกอิน + การจำกัดสาขา (ใช้ร่วมกันเช่นกัน) |
| `office-server/scripts/test-stock.mjs` | เทียบผลจาก SQL กับผลจาก Apps Script ทีละรายการ |

## ขั้นตอนติดตั้ง (เฟส 1)

รันบนเครื่องที่ออฟฟิศ (เครื่องเดียวกับที่รัน office-server) เพราะเป็นเครื่องที่ต่อ SQL Server ได้

**ต้องรันจากโฟลเดอร์รีโป** (โฟลเดอร์ที่มี `package.json`, `docs\`, `scripts\` อยู่ข้างใน)
ไม่ใช่ `C:\hr-migrate` ที่เคยใช้ตอนย้ายข้อมูล HR — โฟลเดอร์นั้นมีแค่ `node_modules` ทำให้
`npm install` ขึ้นว่า "up to date" แต่หาไฟล์สคริปต์กับสคีมาไม่เจอ

```powershell
# หาว่ารีโปอยู่ที่ไหนบนเครื่องนี้
Get-ChildItem C:\, D:\ -Filter migrate-stock.mjs -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 3 FullName

cd D:\naraiสาขา\Narai-branch    # เปลี่ยนตามที่หาเจอ
git pull origin main
```

```powershell
# 0) ลง package ที่สคริปต์ใช้ (ครั้งเดียว ที่โฟลเดอร์รีโป)
#    ถ้าข้ามขั้นนี้จะขึ้น Error: Cannot find module 'mssql' ตอนเขียนจริง
npm install

# 1) สร้างตาราง (ครั้งเดียว) — ฐานข้อมูล InventoryNarai
sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i docs\schema-stock.sql

# 2) ตั้งค่าการต่อฐานข้อมูลของ session นี้
$env:HR_DB_HOST = 'localhost'
$env:HR_DB_INSTANCE = 'SQLEXPRESS'   # ใส่เมื่อ SQL Server เป็น named instance
$env:HR_DB_USE_BROWSER = '1'         # คู่กับ HR_DB_INSTANCE ถ้าอินสแตนซ์ไม่ได้ตรึงพอร์ต 1433
$env:HR_DB_USER = '<user>'
$env:HR_DB_PASSWORD = '<รหัสผ่าน>'

# 3) ตรวจก่อนว่าอ่านชีทได้และคอลัมน์ตรงกับที่โค้ดคาดไว้ (ยังไม่แตะฐานข้อมูล)
node scripts/migrate-stock.mjs --inspect

# 4) ลองแบบไม่เขียนจริง — ดูจำนวนแถวของแต่ละชุด
node scripts/migrate-stock.mjs --dry-run

# 5) ย้ายจริง (เขียนลง InventoryNarai)
node scripts/migrate-stock.mjs

# 6) ชีทที่มีตัวกรองเปิดค้าง ต้องดึงผ่าน CSV ไม่งั้นได้ข้อมูลไม่ครบ
#    ชีท 'ข้อมูลนับสตอค' เป็นตัวอย่างจริง: gviz ให้มา 6,112 แถว แต่ของจริง 70,785 แถว
node scripts/migrate-stock.mjs --csv --gid-counts=923363118 --only=counts
```

หมายเหตุเรื่องการต่อฐานข้อมูล

- `HR_DB_HOST` ต้องตั้งเป็น `localhost` เมื่อรันบนเครื่องที่ออฟฟิศ — `lib/mssql.js` ตั้งค่าเริ่มต้น
  เป็น `inventory.dyndns.tv` ไว้สำหรับฝั่ง Vercel ซึ่งจากในออฟฟิศเองไม่ต้องวิ่งอ้อมออกไปข้างนอก
- อินสแตนซ์ `NARAI-PIZZARIA\SQLEXPRESS` ตรึง TCP 1433 ไว้อยู่แล้ว ถ้ายังเป็นแบบนั้นก็ไม่ต้องตั้ง
  `HR_DB_INSTANCE`/`HR_DB_USE_BROWSER` เลย
- login ที่ใช้ต้องมีสิทธิ์ใน `InventoryNarai` ด้วย ไม่ใช่แค่ `narai_hr` — ส่วนให้สิทธิ์อยู่ท้ายไฟล์
  `docs/schema-stock.sql` (ถ้าลืม จะต่อติดแต่ query ไม่ผ่าน ขึ้นว่า *is not able to access the database*)
- ปลายทางเป็น `InventoryNarai` โดยอัตโนมัติ เปลี่ยนได้ด้วย `--db=` หรือ env `STOCK_DB_NAME`

**ถ้าจำนวนแถวจาก `--inspect` ดูน้อยผิดปกติ** ให้รันใหม่ด้วย `--csv` พร้อมระบุ gid ของแท็บ
เพราะ gviz ส่งกลับมาเฉพาะแถวที่ผ่าน "ตัวกรอง" ที่เปิดค้างไว้ในชีท ซึ่งเคยทำให้ตอนย้ายตารางงาน
เห็นข้อมูลแค่ 496 แถวจากหมื่นกว่าแถว — export CSV ไม่สนใจตัวกรอง

```bash
node scripts/migrate-stock.mjs --csv --gid-counts=923363118 --only=counts
```

สคริปต์รันซ้ำได้ ไม่เกิดข้อมูลซ้ำ: ชุดทะเบียน (`items` / `balance` / `category`) เขียนทับของเดิม
ส่วนชุดประวัติ (`counts` / `requests`) ข้ามแถวที่มีอยู่แล้ว

## ตรวจว่าอ่านจาก SQL ได้ผลตรงกับของเดิมไหม (เฟส 2)

```bash
cd office-server
node scripts/test-stock.mjs --branch=crm
```

สคริปต์จะยิง `getStockItems` ทั้งสองทาง (SQL กับ Apps Script) แล้วเทียบทีละรายการ —
ยอดนับล่าสุด วันที่นับ ยอดยกมา ใบเบิกล่าสุด หมวดจัดเก็บ และจำนวนแถวประวัติ
ถ้าต่างกันจะพิมพ์ออกมาว่าสินค้าตัวไหนต่างช่องไหน

ที่ต่างกันได้ตามปกติคือรายการที่ **บันทึกเข้าชีทหลังจากย้ายข้อมูลรอบล่าสุด** — รันสคริปต์ย้ายซ้ำแล้วเทียบใหม่
ถ้ายังต่างอยู่แปลว่าตรรกะไม่ตรงกันจริง ต้องแก้ก่อนไปต่อ

## สิ่งที่ต้องระวังตอนทำเฟส 3-4

**ชีทเหล่านี้ไม่ได้มีแค่หน้านับสต๊อกที่ใช้** — ตัวที่อ่านชีทตรงๆ ผ่าน gviz โดยไม่ผ่าน Apps Script

| ตัวอ่าน | ชีทที่อ่าน | ใช้ทำอะไร |
|---|---|---|
| `api/stockcount.js` | ข้อมูลนับสตอค, ปิดรอบสิ้นเดือน, 8.2, ค่าเฉลี่ยยอดใช้ต่อหัว, เปอร์เซ็นการเบิก | การ์ดมูลค่าสต๊อก + `ProfitSummary` บนหน้า Dashboard |
| `src/services/dashboardApi.js` | ข้อมูลนับสตอค | ยอดคงเหลือล่าสุดบน Dashboard |
| `src/pages/MonthEndClosing.jsx` | ผ่าน `getClosingItems` | หน้าปิดยอดสิ้นเดือน |

ถ้าเฟส 3 ย้ายการบันทึกไป SQL แล้วเลิกเขียนชีท การ์ดมูลค่าสต๊อกจะค้างนิ่งทันทีโดยไม่มีอะไรฟ้อง
จึงต้อง **เขียนสองที่** (SQL เป็นหลัก แล้ว mirror กลับชีท) จนกว่าเฟส 4 จะย้ายตัวอ่านพวกนี้มาที่ SQL ครบ
เป็นเคสเดียวกับตอนเปิด `getScheduleEmployees` เร็วเกินไปจนหน้านับสต๊อกดรอปดาวน์ว่างทั้งหน้า

**ชีทใบสั่ง/ใบเบิกที่รอส่ง** (`1bxohT8wK4ySAJgqGHEg9JHp0KJJKG7SVUEhJksBgBSI`) ผูกกับ POS
ต้องยืนยันก่อนว่ามีระบบอื่นนอกรีโปนี้อ่านอยู่หรือเปล่า ถึงจะย้าย `savePlanOrderLog` /
`getPendingOrderStatus` / `cancelPendingOrder` ได้

## action ที่เหลือของหน้านับสต๊อก

| action | ทำอะไร | เฟส |
|---|---|---|
| `getStockItems` | รายการสินค้า + ยอดนับ + ใบเบิกล่าสุดของสาขา | 2 (ทำแล้ว) |
| `getStockTotal` | ยอดคงเหลือรวมทุกสาขา | 2 (ทำแล้ว) |
| `saveStock` | บันทึกการนับ + ใบเบิก + อัปเดตยอดยกมา | 3 (เขียนเสร็จ) |
| `updateStorageCategory` | ตั้งหมวดจัดเก็บของสาขา | 3 (เขียนเสร็จ) |
| `saveAvgPerHead` / `getAvgPerHead` | ค่าเฉลี่ยยอดใช้ต่อหัว (สูตรเบิก) | 3 (เขียนเสร็จ) |
| `saveBranchPercentagesBulk` / `getBranchPercent` | เปอร์เซ็นต์การเบิกของแต่ละสาขา | 3 (เขียนเสร็จ) |
| `savePlanOrderLog` / `getPendingOrderStatus` / `cancelPendingOrder` | ใบสั่งของเข้า POS | 3 (รอยืนยันเรื่องชีท POS) |
| `getBranches` | รายชื่อสาขา | ย้ายพร้อมกลุ่มหน้าอื่นที่ใช้ร่วมกัน (ดู hr-sql-migration.md) |

## เปิดใช้จริงอย่างไร

เมื่อเฟส 3 เสร็จและ `test-stock.mjs` ผ่านแล้ว เพิ่มชื่อ action ลง `SQL_ACTIONS` ใน
`src/services/api.js` ทีละตัว หน้าเว็บไม่ต้องแก้อะไรเลย — `/api/schedule` รู้จัก action ของสต๊อก
ไว้แล้ว (อยู่ในลิสต์ `READ_ONLY` สำหรับตัวที่อ่านอย่างเดียว)


## เลขที่ใบเบิก

`saveStock` ออกเลขเองใน SQL ด้วยรูปแบบเดิมทุกตัวอักษร — 3 ตัวแรกของรหัสสาขา + ปี 2 หลัก +
เดือน + ลำดับ 3 หลัก (เช่น `CRM2608001`) ลำดับเดินจาก `MAX()` ของเดือนนั้นในตาราง `stock_request`
โดยอ่านด้วย `UPDLOCK, HOLDLOCK` ในทรานแซกชันเดียวกับตอนเขียน กันสองคนกดพร้อมกันแล้วได้เลขซ้ำ
(ของเดิม Apps Script ใช้ `LockService` ทำหน้าที่นี้)

เลขนี้เป็นคนละตัวกับเลขที่ใบสั่งของฝั่ง POS (`Ord_No`) ซึ่ง `api/insert_order.js` เดินเลขจาก
`myfbdata<สาขา>.config` เหมือนเดิม ไม่เกี่ยวข้องกัน
