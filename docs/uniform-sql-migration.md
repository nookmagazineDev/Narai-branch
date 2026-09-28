# ตั้ง SQL ของกล่องยูนิฟอร์ม (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)

ทำครั้งเดียวก่อนเปิดใช้ปุ่มรูปเสื้อ หลังจากนี้ไม่ต้องทำอะไรอีก

**สรุปสั้นที่สุด** — บนเครื่องที่ออฟฟิศ (เครื่องที่รัน service `NaraiUsageAPI`)
โฟลเดอร์รากตามที่ติดตั้งไว้จริงคือ `D:\Narai-branch-main` (แตกจาก ZIP จึงลงท้าย `-main`)
ถ้าของเครื่องคุณชื่ออื่น ให้เปลี่ยน path ในทุกคำสั่งตามนั้น:

```powershell
cd D:\Narai-branch-main\office-server        # โฟลเดอร์ที่ service ใช้อยู่
git pull origin main                    # เอาสคริปต์ตัวใหม่มาก่อน
node scripts/setup-uniform-db.mjs
```

ขึ้น **“พร้อมใช้งานครบทุกข้อ ✅”** = จบ เปิดหน้ารายชื่อพนักงานกดปุ่มรูปเสื้อได้เลย
(ไม่ต้อง `Restart-Service` เพราะไม่ได้แก้โค้ดของ service)

---

## 1. ต้องสร้างอะไรบ้าง

**ตารางเดียว** ชื่อ `dbo.UniformBranch` บนฐานข้อมูล **`InventoryNarai`** ที่มีอยู่แล้ว
(1 แถว = 1 ไอเทมที่จ่ายให้พนักงาน 1 คน 1 ครั้ง — กดบันทึกทีเดียว 3 ไอเทม = 3 แถว)

**ไม่ต้องสร้างฐานข้อมูลใหม่ และไม่ต้องสร้าง login ใหม่** — ใช้ฐานเดียวกับหน้านับสต๊อก เพราะ:

| กล่องยูนิฟอร์มทำอะไร | ลงที่ไหน |
|---|---|
| ช่องค้นหาไอเทม (รหัส `800000*`) | อ่าน `dbo.stock_item` — ทะเบียนสินค้าเดิม ไม่มีตารางของตัวเอง |
| “บันทึกข้อมูล” (จ่ายให้พนักงาน) | **`dbo.UniformBranch`** ← ตารางใหม่ที่ต้องสร้าง |
| “เบิกเข้าสาขา” | `dbo.stock_request` — ใบเบิกชุดเดียวกับหน้านับสต๊อก (ทีมโกดังจึงเห็นในที่เดียว) |

เส้นทางข้อมูล: เบราว์เซอร์ → `/api/schedule` (Vercel ส่งต่อ) → `:8787/schedule` → SQL Server (`localhost`)

### โครงตาราง

| คอลัมน์ | ชนิด | เก็บอะไร |
|---|---|---|
| `uniform_id` | `INT IDENTITY` | คีย์หลัก (ใช้ตอนกดลบรายการ) |
| `branch` | `NVARCHAR(50)` | รหัสสาขา ตัวพิมพ์เล็กเสมอ (`crm`, `hrs`, `zjp`) |
| `hr_code` | `NVARCHAR(50)` | รหัส HR ของพนักงาน |
| `emp_name` | `NVARCHAR(255)` | ชื่อพนักงาน **ณ วันที่บันทึก** |
| `item_key` | `NVARCHAR(50)` | รหัสไอเทมที่ normalize แล้ว (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) |
| `item_code` / `item_name` | `NVARCHAR` | รหัส/ชื่อไอเทมตามที่แสดง ณ วันที่บันทึก |
| `unit` | `NVARCHAR(50)` | หน่วย (ตัว / ผืน / ใบ) |
| `size` | `NVARCHAR(20)` | ไซซ์ S / M / L / XL / 2XL / 3XL หรือว่าง |
| `qty` | `DECIMAL(18,2)` | จำนวนที่จ่าย |
| `note` | `NVARCHAR(500)` | หมายเหตุ |
| `issued_at` | `DATETIME2(0)` | วันที่จ่ายของ (กรอกย้อนหลังได้) |
| `saved_at` / `saved_by` | `DATETIME2(0)` / `NVARCHAR(255)` | เวลาที่กดบันทึก + คนที่กด |

`emp_name` / `item_name` เก็บซ้ำลงในแถวทั้งที่ join เอาได้ — ตั้งใจให้เป็นแบบนี้ เพราะชื่อพนักงาน
กับชื่อสินค้าเปลี่ยนได้ทีหลัง แต่ประวัติที่จ่ายไปแล้วต้องไม่เปลี่ยนตาม
ไฟล์สคีมาเต็ม (พร้อมเหตุผลของทุกการตัดสินใจ): [`docs/schema-uniform.sql`](schema-uniform.sql)

---

## 2. ต้องมีอะไรอยู่ก่อน

| ข้อ | ตรวจยังไง ถ้าไม่แน่ใจ |
|---|---|
| SQL Server + ฐาน `InventoryNarai` และตาราง `stock_item`, `stock_request` | สคริปต์ในข้อ 3 บอกให้เองว่าขาดข้อไหน |
| ตั้ง `HR_DB_USER` / `HR_DB_PASSWORD` ใน `office-server\.env` แล้ว | หน้านับสต๊อกใช้งานได้อยู่ = ตั้งแล้ว |
| มีไอเทมรหัส `800000*` ในทะเบียนสินค้า | ดูข้อ 7 |
| **โค้ด office-server ใหม่พอที่จะมี `uniform.js`** (ไม่มี = กดปุ่มแล้วขึ้นว่าไม่รู้จัก action) | `Test-Path D:\Narai-branch-main\office-server\uniform.js` |

ข้อสุดท้ายได้ `False` → อัปเดตโค้ดก่อน แล้ว `Restart-Service NaraiUsageAPI`:

```powershell
cd D:\Narai-branch-main
git pull origin main                 # โฟลเดอร์เป็น git repo อยู่แล้ว
Restart-Service NaraiUsageAPI
```

ขึ้นว่า `not a git repository` (ได้โค้ดมาจาก ZIP) → เชื่อมเข้ากับ git ครั้งเดียวก่อน
สคริปต์นี้ดึง main มาทับไฟล์โค้ด + `npm install` + รีสตาร์ท service ให้เอง และไม่แตะ `.env`:

```powershell
cd D:\Narai-branch-main\office-server
powershell -ExecutionPolicy Bypass -File .\scripts\link-to-git.ps1 -Root D:\Narai-branch-main
```

ถ้าเป็นเครื่องใหม่ที่ยังไม่มีฐานข้อมูลอะไรเลย ให้รันตามลำดับนี้ก่อน:
`docs/schema-hr.sql` (ฐาน `narai_hr`) → `docs/schema-stock.sql` (ฐาน `InventoryNarai`) → แล้วค่อยมาข้อ 3
รายละเอียดอยู่ใน [`docs/hr-sql-migration.md`](hr-sql-migration.md) และ [`docs/stock-sql-migration.md`](stock-sql-migration.md)

---

## 3. สร้างตาราง — เลือกทางใดทางหนึ่ง

### ทาง ก) สคริปต์ (แนะนำ — ไม่ต้องมี sqlcmd ไม่ต้องเปิด SSMS)

```powershell
cd D:\Narai-branch-main\office-server
node scripts/setup-uniform-db.mjs
```

ขึ้น `Cannot find module ...\scripts\setup-uniform-db.mjs` = โค้ดในเครื่องยังไม่มีสคริปต์ตัวนี้
(ยังไม่ได้อัปเดตโค้ด — ดูข้อ 2) ไม่อยากอัปเดตโค้ดตอนนี้ก็ใช้ **ทาง ง)** ได้เลย ได้ตารางเหมือนกัน

สคริปต์อ่านค่าเชื่อมต่อจาก `.env` ตัวเดียวกับที่ service ใช้ สร้างตารางจาก `docs/schema-uniform.sql`
แล้วไล่ตรวจให้ครบ 8 ข้อ ผลที่ได้จะเป็นแบบนี้:

```
ตั้งฐานข้อมูลกล่องยูนิฟอร์ม (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)
────────────────────────────────────────────────────────────────────────
1) ต่อฐานข้อมูลได้           ✅
   เครื่อง: NARAI-PIZZARIA\SQLEXPRESS   ฐานข้อมูล: InventoryNarai   login: narai_web
2) ตาราง dbo.UniformBranch   ยังไม่มี — กำลังสร้างจาก ..\docs\schema-uniform.sql
   ✅ สร้างตารางเรียบร้อย (5 ก้อนคำสั่ง)
3) คอลัมน์ครบ               ✅ มี 14 คอลัมน์
4) อินเด็กซ์                 ✅ PK_UniformBranch, IX_UniformBranch_emp, IX_UniformBranch_branch_date
5) สิทธิ์อ่าน/เขียน/ลบ        ✅ (login: narai_web)
6) ไอเทมยูนิฟอร์ม 800000*    ✅ 12 รายการใน dbo.stock_item
7) ตาราง dbo.stock_request   ✅ (ปุ่ม "เบิกเข้าสาขา" ลงตารางนี้)
8) ข้อมูลในตารางตอนนี้        0 แถว / พนักงาน 0 คน
────────────────────────────────────────────────────────────────────────
พร้อมใช้งานครบทุกข้อ ✅
```

ข้อไหนขึ้น ❌ จะมีบรรทัดบอกวิธีแก้ของข้อนั้นต่อท้ายให้เลย **รันซ้ำได้ปลอดภัย** — ทุกคำสั่งห่อด้วย
`IF NOT EXISTS` ข้อมูลที่บันทึกไว้ไม่ถูกแตะ

ตัวเลือกที่มี:

| คำสั่ง | ใช้เมื่อ |
|---|---|
| `node scripts/setup-uniform-db.mjs --check` | ตรวจอย่างเดียว ไม่เขียนอะไรในฐานข้อมูล |
| `... --user=sa --password='<รหัส sa>'` | login ของเว็บสร้างตารางไม่ได้ (ไม่มีรหัส sa → ดูข้อ 6) |
| `... --sync-items` | ซิงก์ทะเบียนสินค้าจากชีท BOM ก่อนตรวจ (ไอเทม `800000*` ยังไม่ขึ้น — ดูข้อ 7) |
| `... --db=InventoryNarai` | ฐานข้อมูลชื่ออื่น |
| `... --file=<path>` | ชี้ไฟล์สคีมาเอง |

### ทาง ข) sqlcmd

```powershell
sqlcmd -S localhost\SQLEXPRESS -U sa -P '<รหัสผ่าน>' -i D:\Narai-branch-main\docs\schema-uniform.sql
```

### ทาง ค) SQL Server Management Studio

เปิด `docs\schema-uniform.sql` → เลือกฐานข้อมูล `InventoryNarai` ที่แถบบน → กด **Execute (F5)**
ต้องขึ้นข้อความ `สร้างตาราง dbo.UniformBranch เรียบร้อย` ที่แท็บ Messages

### ทาง ง) ไม่มีไฟล์สคีมาในเครื่องเลย — วางคำสั่งลง PowerShell ตรง ๆ

ใช้เมื่อโค้ดในเครื่องยังเก่ากว่าที่มี `docs\schema-uniform.sql` (เช็คด้วย
`Test-Path D:\Narai-branch-main\docs\schema-uniform.sql`) และไม่อยากอัปเดตโค้ดตอนนี้
ก้อนนี้เป็น ASCII ล้วน (ตัดคอมเมนต์ไทยออก เลี่ยงปัญหา codepage ของ sqlcmd) ได้ตารางเหมือนกันเป๊ะ

```powershell
$sql = @'
IF OBJECT_ID(N'dbo.UniformBranch', N'U') IS NULL
CREATE TABLE dbo.UniformBranch (
    uniform_id  INT IDENTITY(1,1) NOT NULL,
    branch      NVARCHAR(50)   NOT NULL,
    hr_code     NVARCHAR(50)   NOT NULL,
    emp_name    NVARCHAR(255)  NULL,
    item_key    NVARCHAR(50)   NOT NULL,
    item_code   NVARCHAR(50)   NOT NULL,
    item_name   NVARCHAR(255)  NULL,
    unit        NVARCHAR(50)   NULL,
    size        NVARCHAR(20)   NULL,
    qty         DECIMAL(18,2)  NOT NULL,
    note        NVARCHAR(500)  NULL,
    issued_at   DATETIME2(0)   NOT NULL,
    saved_at    DATETIME2(0)   NOT NULL
                CONSTRAINT DF_UniformBranch_saved_at DEFAULT (SYSDATETIME()),
    saved_by    NVARCHAR(255)  NULL,
    CONSTRAINT PK_UniformBranch PRIMARY KEY CLUSTERED (uniform_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE object_id = OBJECT_ID(N'dbo.UniformBranch') AND name = N'IX_UniformBranch_emp')
CREATE INDEX IX_UniformBranch_emp ON dbo.UniformBranch (hr_code, branch, issued_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes
                WHERE object_id = OBJECT_ID(N'dbo.UniformBranch') AND name = N'IX_UniformBranch_branch_date')
CREATE INDEX IX_UniformBranch_branch_date ON dbo.UniformBranch (branch, issued_at DESC)
    INCLUDE (item_key, qty);
GO
SELECT COUNT(*) AS columns_created FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.UniformBranch');
GO
'@
Set-Content -Path "$env:TEMP\uniform.sql" -Value $sql -Encoding ASCII
sqlcmd -S localhost\SQLEXPRESS -E -d InventoryNarai -i "$env:TEMP\uniform.sql"
```

ต้องได้ `columns_created = 14` — ไม่ต้องให้สิทธิ์อะไรเพิ่มแก่ `narai_web` เพราะสิทธิ์ที่ให้ไว้
ระดับฐานข้อมูล (`db_datareader` / `db_datawriter`) ครอบตารางใหม่ให้เองอยู่แล้ว

> ทาง ข) ค) และ ง) สร้างตารางให้เหมือนกัน แต่ไม่ได้ตรวจสิทธิ์ของ login ที่เว็บใช้และไม่ได้ตรวจ
> ทะเบียนไอเทม `800000*` ให้ — ทำเสร็จแล้วควรรัน `node scripts/setup-uniform-db.mjs --check` ปิดท้าย

---

## 4. ตรวจว่าใช้งานได้จริง

1. `node scripts/setup-uniform-db.mjs --check` → ต้องขึ้น ✅ ครบ
2. เปิดเว็บ → **รายชื่อพนักงาน** → เลือกสาขา → กดปุ่มรูปเสื้อของพนักงานคนหนึ่ง
   - ช่องค้นหาไอเทมต้องขึ้นรายการ `800000*` (ถ้าว่าง → ข้อ 7)
   - ลองบันทึก 1 รายการ แล้วกดปิด-เปิดกล่องใหม่ ต้องยังเห็นประวัติแถวนั้น
3. ดูในฐานข้อมูลว่าแถวลงจริง:

```sql
SELECT TOP 10 uniform_id, branch, hr_code, emp_name, item_code, item_name, size, qty, issued_at, saved_by
  FROM dbo.UniformBranch
 ORDER BY uniform_id DESC;
```

---

## 5. ปัญหาที่เจอบ่อย

| ข้อความที่ขึ้น | สาเหตุ | วิธีแก้ |
|---|---|---|
| `CREATE TABLE permission denied in database 'InventoryNarai'` | login ของเว็บมีแค่ `db_datareader` + `db_datawriter` สร้างตารางไม่ได้ | รันสคริปต์ซ้ำครั้งเดียวด้วย `--user=sa --password='...'` (ไม่ต้องแก้ `.env` และไม่ต้องเพิ่มสิทธิ์ถาวรให้ login ของเว็บ) — **ไม่มีรหัส sa ให้ดูข้อ 6** |
| `ยังไม่ได้ตั้ง HR_DB_USER / HR_DB_PASSWORD` | ยังไม่ได้ตั้ง `.env` ของ `office-server` | คัดลอก `.env.example` เป็น `.env` แล้วใส่ค่าจริง |
| `เข้าฐานข้อมูล HR ไม่ได้ (ชื่อผู้ใช้/รหัสผ่าน...)` | รหัสผิด หรือยังไม่เปิด SQL Server Authentication | ตรวจรหัสใน `.env` / เปิด Mixed Mode Authentication แล้วรีสตาร์ท SQL Server |
| `The server principal ... is not able to access the database` | login มีสิทธิ์ใน `narai_hr` แต่ยังไม่มี user ใน `InventoryNarai` | รันส่วนให้สิทธิ์ท้ายไฟล์ `docs/schema-stock.sql` |
| หน้าเว็บขึ้น `ยังไม่ได้สร้างตารางในฐานข้อมูล` | ยังไม่ได้รันสคีมา หรือรันผิดฐานข้อมูล | ทำข้อ 3 ให้จบ แล้วเช็คด้วย `--check` ว่าฐานข้อมูลที่ต่อคือ `InventoryNarai` |
| กล่องเปิดได้ แต่ช่องค้นหาไอเทมว่าง | ไม่มีไอเทมรหัส `800000*` ในทะเบียนสินค้า | ข้อ 7 |
| บันทึกที่สาขา `zjp` แล้วเปิดด้วย `sjp` ไม่เห็น | — | ไม่ใช่ปัญหา: โค้ดอ่านครอบรหัสสาขาพี่น้องให้แล้ว (`branchGroup`) ถ้าไม่เห็นจริงให้ตรวจว่าแถวนั้น `branch` เป็นตัวพิมพ์เล็ก |
| `node` ไม่มีในเครื่อง / `Cannot find module 'mssql'` | ยังไม่ได้ `npm install` ที่โฟลเดอร์ `office-server` | `cd office-server` แล้ว `npm install` (service ตัวนี้ใช้ `mssql` อยู่แล้ว ปกติจะมีอยู่) |

---

## 6. ไม่มีรหัส sa / จำรหัส sa ไม่ได้

**ไม่จำเป็นต้องใช้ sa เลย** — sa เป็นแค่ทางที่สะดวกที่สุดเท่านั้น ไล่ตามลำดับนี้

### 6.1 ลองรันตรง ๆ ก่อน (ส่วนใหญ่จบที่ข้อนี้)

login ที่ตั้งไว้ใน `.env` อาจสร้างตารางได้อยู่แล้ว (ถ้าเป็น `sa` เอง หรือถูกใส่ไว้ใน `db_owner`)

```powershell
cd D:\Narai-branch-main\office-server
Select-String -Path .env -Pattern 'HR_DB_USER'     # ดูว่า service ใช้ login อะไร
node scripts/setup-uniform-db.mjs
```

ผ่าน = จบ ไม่ต้องอ่านข้อต่อไป

### 6.2 เข้าด้วย Windows Authentication (ไม่ต้องมีรหัสผ่านอะไรทั้งนั้น)

บัญชี Windows ที่เป็นคนติดตั้ง SQL Server ไว้ มักมีสิทธิ์ `sysadmin` อยู่แล้ว
เปิด **PowerShell แบบ Run as Administrator** บนเครื่องฐานข้อมูล แล้วเช็คก่อนว่าใช่ไหม:

```powershell
sqlcmd -S localhost\SQLEXPRESS -E -Q "SELECT SUSER_SNAME() AS me, IS_SRVROLEMEMBER('sysadmin') AS sysadmin"
```

ไม่รู้ว่าต้องใส่ `-S` อะไร → ดูจากค่าที่ service ใช้อยู่ (ตรงกันเสมอ):

```powershell
Select-String -Path D:\Narai-branch-main\office-server\.env -Pattern 'HR_DB_HOST|HR_DB_INSTANCE|HR_DB_PORT'
Get-Service MSSQL*        # ดูชื่ออินสแตนซ์ที่ติดตั้งไว้จริง
```

`HR_DB_INSTANCE=SQLEXPRESS` → `-S localhost\SQLEXPRESS` / ไม่ได้ตั้งไว้ → `-S localhost`

`-E` = เข้าด้วยบัญชี Windows ที่ล็อกอินอยู่ (ไม่ต้องใส่รหัส) — ถ้าเป็น default instance ใช้ `-S localhost`
ได้ `sysadmin = 1` → สร้างตารางได้เลย:

```powershell
sqlcmd -S localhost\SQLEXPRESS -E -d InventoryNarai -i D:\Narai-branch-main\docs\schema-uniform.sql
cd D:\Narai-branch-main\office-server
node scripts/setup-uniform-db.mjs --check
```

ไม่มี `sqlcmd` ในเครื่อง → เปิด **SSMS** → ช่อง Authentication เลือก **Windows Authentication**
(ไม่ต้องกรอกรหัส) → เปิด `docs\schema-uniform.sql` → เลือกฐานข้อมูล `InventoryNarai` → **F5**

> สคริปต์ `setup-uniform-db.mjs` ใช้ Windows Authentication ไม่ได้ (ตัวเชื่อมต่อ `mssql` ของ Node
> ต้องมี user/password) จึงต้องสร้างตารางด้วย `sqlcmd -E` หรือ SSMS ในข้อนี้
> แล้วใช้สคริปต์ `--check` ตรวจต่อ ซึ่งใช้ login ของ service ที่มีรหัสอยู่ใน `.env` แล้ว

### 6.3 อยากให้สคริปต์สร้างตารางเองได้ในครั้งต่อไป

ตอนที่เข้าด้วย sysadmin ได้ (ข้อ 6.2) ให้สิทธิ์สร้างตารางแก่ login ของเว็บไว้เลย:

```sql
USE InventoryNarai;
ALTER ROLE db_ddladmin ADD MEMBER narai_web;   -- เปลี่ยนชื่อ login ให้ตรงกับ HR_DB_USER
```

แลกกันตรงที่ login ของเว็บจะสร้าง/ลบตารางในฐานนี้ได้ถาวร — ถ้าไม่สบายใจ **ไม่ต้องให้ก็ได้**
สคีมาใหม่ในอนาคตก็รันด้วย `sqlcmd -E` แบบข้อ 6.2 ทุกครั้ง (ปลอดภัยกว่า และไม่ได้ทำบ่อย)

### 6.4 ตั้งรหัส sa ใหม่ (ถ้าอยากได้คืน)

งานยูนิฟอร์มไม่ต้องใช้ แต่ถ้าอยากตั้งใหม่ ตอนเข้าด้วย sysadmin ได้:

```sql
ALTER LOGIN sa WITH PASSWORD = N'<รหัสใหม่>';
ALTER LOGIN sa ENABLE;   -- เผื่อ sa ถูกปิดไว้
```

### 6.5 ทางสุดท้าย — ไม่มีบัญชี Windows ไหนเป็น sysadmin เลย

(ข้อ 6.2 ขึ้น `Login failed` หรือได้ `sysadmin = 0` ทุกบัญชี) ต้องกู้สิทธิ์ผ่าน single-user mode
ทำจากเครื่องฐานข้อมูลโดยตรง ใน PowerShell แบบ Run as Administrator:

```powershell
Stop-Service 'MSSQL$SQLEXPRESS'
# สตาร์ทแบบ single-user: ผู้ที่เป็น local administrator จะเข้าได้ในฐานะ sysadmin
sc.exe start 'MSSQL$SQLEXPRESS' -m
sqlcmd -S localhost\SQLEXPRESS -E -Q "ALTER SERVER ROLE sysadmin ADD MEMBER [$env:USERDOMAIN\$env:USERNAME]"
Restart-Service 'MSSQL$SQLEXPRESS'
```

ระหว่าง single-user mode ต่อได้ทีละ 1 คำสั่ง — ต้องหยุด service `NaraiUsageAPI` ก่อน
ไม่งั้นมันจะแย่ง connection เดียวนั้นไป (`Stop-Service NaraiUsageAPI` แล้วค่อย `Start-Service` คืนตอนจบ)
เสร็จแล้วกลับไปข้อ 6.2

---

## 7. ไอเทมยูนิฟอร์มต้องมีในทะเบียนสินค้าก่อน

กล่องยูนิฟอร์มไม่มีทะเบียนไอเทมของตัวเอง — กรองจาก `dbo.stock_item` เฉพาะรหัสที่ขึ้นต้น **`800000`**
และสถานะไม่ใช่ `ปิดการใช้งาน` (กรองที่ SQL ไม่ได้ส่งสินค้าทั้งทะเบียนหลักพันรายการไปให้เบราว์เซอร์)

นับว่ามีกี่รายการ:

```sql
SELECT item_code, item_name, unit, status
  FROM dbo.stock_item
 WHERE item_code LIKE '800000%'
 ORDER BY item_code;
```

ได้ 0 แถว → เพิ่มไอเทมในชีท BOM แท็บ `item` (รหัสขึ้นต้น `800000`) แล้วซิงก์เข้า SQL:

```powershell
cd D:\Narai-branch-main\office-server
node scripts/setup-uniform-db.mjs --sync-items
```

(ตัวเดียวกับรอบซิงก์อัตโนมัติทุกชั่วโมงของ service — ไม่สั่งเองก็รอรอบถัดไปได้
ผู้ใช้สิทธิ์ `all` สั่งซิงก์จากหน้าเว็บได้เหมือนกัน ผ่านปุ่มซิงก์ทะเบียนสินค้าในหน้านับสต๊อก)

ตรวจไอเทมตัวใดตัวหนึ่งว่าทำไมไม่ขึ้น: `node scripts/check-item.mjs --item=<รหัสหรือชื่อ>`

ไม่ต้องผูกไอเทมพวกนี้กับสาขาใน `stock_item_branch` — ยูนิฟอร์มเป็นของกลางที่ทุกสาขาเบิกได้
จึงตั้งใจไม่กรองตามทะเบียนสินค้าของสาขา (ต่างจากหน้านับสต๊อก)

---

## 8. คำสั่งที่ใช้บ่อยหลังเปิดใช้งาน

```sql
-- พนักงานคนหนึ่งได้อะไรไปแล้วบ้าง
SELECT item_code, item_name, size, qty, issued_at, saved_by
  FROM dbo.UniformBranch
 WHERE hr_code = N'<รหัส HR>' AND branch = N'crm'
 ORDER BY issued_at DESC;

-- สรุปรายสาขา/รายเดือน (ไอเทมไหนจ่ายไปเท่าไหร่)
SELECT branch, FORMAT(issued_at, 'yyyy-MM') AS ym, item_code, item_name,
       SUM(qty) AS qty, COUNT(DISTINCT hr_code) AS emps
  FROM dbo.UniformBranch
 GROUP BY branch, FORMAT(issued_at, 'yyyy-MM'), item_code, item_name
 ORDER BY branch, ym DESC, qty DESC;

-- ลบแถวที่บันทึกผิด (ปกติกดลบในกล่องได้เลย ไม่ต้องมาทำที่นี่)
DELETE FROM dbo.UniformBranch WHERE uniform_id = <id>;
```

ในกล่องไม่มีปุ่ม “แก้ไข” โดยตั้งใจ — ลบแล้วบันทึกใหม่เห็นร่องรอยชัดกว่าการทับค่าเงียบ ๆ

---

## 9. ถอนออก (ถ้าต้องรื้อทำใหม่)

```sql
DROP TABLE dbo.UniformBranch;   -- ประวัติการจ่ายยูนิฟอร์มทั้งหมดหายไปด้วย
```

ใบเบิกที่กดจากปุ่ม “เบิกเข้าสาขา” อยู่ใน `dbo.stock_request` **ไม่ได้หายไปกับคำสั่งนี้**
(เป็นใบเบิกชุดเดียวกับหน้านับสต๊อก ถ้าจะลบต้องลบทีละใบที่ตารางนั้น)
