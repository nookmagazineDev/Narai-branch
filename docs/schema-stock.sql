/* ============================================================================
   หน้านับสต๊อก / ขอเบิก บน Microsoft SQL Server — อยู่ในฐานข้อมูล narai_hr เดียวกับตารางงาน
   รันไฟล์นี้ครั้งเดียวก่อนเปิดใช้ action ของสต๊อกใน /api/schedule

   วิธีรัน (บนเครื่องฐานข้อมูล):
     sqlcmd -S localhost -U sa -P '<รหัสผ่าน>' -i docs\schema-stock.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute

   ที่มา: ย้ายมาจาก Google Sheets 4 ไฟล์ (ดู docs/stock-sql-migration.md)
     - ไฟล์สต๊อก  1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ
         ชีท 'ข้อมูลนับสตอค'  -> stock_count
         ชีท 'ยอดยกมา'        -> stock_balance
         ชีท 'ข้อมูลเบิก'      -> stock_request
         ชีท 'หมวดจัดเก็บสาขา' -> stock_storage_category
         ชีท 'รายการสินค้า'    -> stock_item_total
     - ไฟล์ BOM   1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw
         ชีท 'item'                  -> stock_item + stock_item_branch
         ชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว'   -> stock_avg_per_head
     - ไฟล์ supplier 1YXOaA--qL71kxtCtqOVHF4LYTNLxc64-NNuhwKeVYZw
         ชีท 'เปอร์เซ็นการเบิกของแต่ละสาขา' -> stock_branch_percent

   หมายเหตุการออกแบบที่ต่างจากชีทเดิม
   ---------------------------------------------------------------------------
   1) รหัสสินค้าในชีทเขียนไม่ตรงกันทุกไฟล์ — บางที่มี 0 นำหน้า ('00123') บางที่เป็นตัวเลขล้วน
      Apps Script จึงเทียบกันด้วย normalizeId() (ตัด 0 นำหน้า + ตัวพิมพ์เล็ก) ทุกครั้งที่จับคู่
      ตารางนี้เก็บผลของการ normalize ไว้เป็นคอลัมน์ item_key และใช้เป็นคีย์ทุกจุด
      ส่วน item_code เก็บรหัสตามที่พิมพ์ในชีทไว้แสดงผล/ส่งเข้า POS เหมือนเดิม
      ถ้าเทียบกันด้วย item_code ตรงๆ จะจับคู่ไม่เจอเป็นพันรายการโดยไม่มีอะไรฟ้อง
   2) สาขาเก็บเป็นตัวพิมพ์เล็กเสมอ (crm, hrs, zjp) เพราะชีท item เขียนเป็นตัวใหญ่ (CRM)
      แต่ user.branch ที่หน้าเว็บส่งมาเป็นตัวเล็ก — ฝั่งอ่านทำ LOWER() ให้ก่อนเทียบ
      ยกเว้น zjp ที่ในชีท item เขียนว่า SJP (ดู alias ใน stock.js) จึงยังต้องแปลงตอนอ่าน
   3) ชีท 'ข้อมูลนับสตอค' เป็น log ต่อท้าย (25,000+ แถว) และหน้าเว็บใช้ประวัติทั้งชุด
      ตารางนี้จึงยังเก็บทุกครั้งที่นับ ไม่ยุบเหลือแถวเดียวเหมือน hr_timesheet
      แต่ใส่ unique key (branch, item_key, counted_at) ไว้ให้ย้ายซ้ำแล้วไม่เกิดแถวซ้ำ
   4) ทุกคอลัมน์ข้อความใช้ NVARCHAR เพราะข้อมูลเป็นภาษาไทย
============================================================================ */

USE narai_hr;
GO

/* ===================== รายการสินค้าของหน้านับสต๊อก =====================
   มาจากชีท 'item' ในไฟล์ BOM ซึ่งเป็นตัวหลักของฝ่ายจัดซื้อ
   เฟสนี้ SQL เป็นแค่สำเนาไว้อ่านให้เร็ว การแก้ยังทำที่ชีทเหมือนเดิม   */
IF OBJECT_ID(N'dbo.stock_item', N'U') IS NULL
CREATE TABLE dbo.stock_item (
    item_key      NVARCHAR(50)   NOT NULL,   -- รหัสที่ normalize แล้ว (ตัด 0 นำหน้า, ตัวพิมพ์เล็ก)
    item_code     NVARCHAR(50)   NOT NULL,   -- รหัสตามที่พิมพ์ในชีท (A)
    pos_item_id   NVARCHAR(50)   NULL,       -- itemid ฝั่ง POS (K) ใช้ตอนส่งใบสั่งของ
    item_name     NVARCHAR(255)  NOT NULL,   -- ชื่อสินค้า (B)
    unit          NVARCHAR(50)   NULL,       -- หน่วยนับ (D)
    request_unit  NVARCHAR(50)   NULL,       -- หน่วยเบิก (L)
    price         DECIMAL(18,4)  NULL,       -- ราคา (C)
    status        NVARCHAR(50)   NULL,       -- สถานะ (E) — 'ปิดการใช้งาน' = ไม่ต้องแสดง
    store_cat     NVARCHAR(150)  NULL,       -- หมวดสโตร์ (N) ใช้จัดกลุ่มตอนสั่งของ
    plan_only     BIT            NOT NULL CONSTRAINT DF_stock_item_plan_only DEFAULT (0), -- Plan (O)
    sort_order    INT            NOT NULL CONSTRAINT DF_stock_item_sort DEFAULT (0),  -- ลำดับแถวในชีท
    updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_item_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_item PRIMARY KEY (item_key)
);
GO

/* สาขาที่ใช้สินค้าตัวนั้น — ชีทเก็บรวมเป็นข้อความคั่นลูกน้ำในคอลัมน์ J ("CRM,HRS,XHH")
   แยกเป็นแถวเพื่อให้กรองด้วย WHERE branch = @branch ได้ตรงๆ ไม่ต้อง LIKE ทีละแถว
   (LIKE '%CRM%' จะจับ 'CRMX' ติดมาด้วย ซึ่งเป็นบั๊กที่รอวันเกิด) */
IF OBJECT_ID(N'dbo.stock_item_branch', N'U') IS NULL
CREATE TABLE dbo.stock_item_branch (
    item_key  NVARCHAR(50) NOT NULL,
    branch    NVARCHAR(50) NOT NULL,   -- ตัวพิมพ์เล็กเสมอ
    CONSTRAINT PK_stock_item_branch PRIMARY KEY (item_key, branch)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_item_branch_branch')
CREATE INDEX IX_stock_item_branch_branch ON dbo.stock_item_branch (branch) INCLUDE (item_key);
GO

/* ================== รายการสินค้าของหน้ารวมสต๊อกทุกสาขา ==================
   คนละชีทกับข้างบน — 'รายการสินค้า' ในไฟล์สต๊อก ซึ่งมีคอลัมน์คนละชุดและรายการไม่เท่ากัน
   getStockTotal ใช้ชีทนี้เป็นตัวตั้ง จึงเก็บแยกไว้ ไม่ยุบรวมกับ stock_item
   (ยุบรวมแล้วหน้ารวมสต๊อกจะมีสินค้าโผล่มา/หายไปจากเดิมทันที) */
IF OBJECT_ID(N'dbo.stock_item_total', N'U') IS NULL
CREATE TABLE dbo.stock_item_total (
    item_key     NVARCHAR(50)  NOT NULL,
    item_code    NVARCHAR(50)  NOT NULL,   -- A
    item_name    NVARCHAR(255) NOT NULL,   -- B
    unit         NVARCHAR(50)  NULL,       -- C
    store_cat    NVARCHAR(150) NULL,       -- D หมวดสโตร์
    storage_cat  NVARCHAR(150) NULL,       -- E หมวดจัดเก็บ (ค่าตั้งต้น ถ้าสาขายังไม่กำหนดเอง)
    rd_cat       NVARCHAR(150) NULL,       -- F หมวด RD
    sort_order   INT           NOT NULL CONSTRAINT DF_stock_item_total_sort DEFAULT (0), -- ลำดับแถวในชีท
    updated_at   DATETIME2(0)  NOT NULL CONSTRAINT DF_stock_item_total_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_item_total PRIMARY KEY (item_key)
);
GO

/* ========================== ข้อมูลการนับสต๊อก ==========================
   ชีท 'ข้อมูลนับสตอค': A=วันที่ลงข้อมูล B=ผู้นับ C=สาขา D=รหัส E=ชื่อ F=หน่วย G=คงเหลือ */
IF OBJECT_ID(N'dbo.stock_count', N'U') IS NULL
CREATE TABLE dbo.stock_count (
    count_id      BIGINT         IDENTITY(1,1) NOT NULL,
    counted_at    DATETIME2(0)   NOT NULL,   -- วันที่+เวลาที่กดบันทึก
    branch        NVARCHAR(50)   NOT NULL,
    item_key      NVARCHAR(50)   NOT NULL,
    item_code     NVARCHAR(50)   NOT NULL,
    item_name     NVARCHAR(255)  NULL,
    unit          NVARCHAR(50)   NULL,
    remaining     DECIMAL(18,3)  NOT NULL,
    counter_name  NVARCHAR(255)  NULL,       -- ชื่อพนักงานที่นับ
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_count_created_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_count PRIMARY KEY (count_id),
    -- กันแถวซ้ำตอนย้ายข้อมูลรอบสอง: การนับหนึ่งครั้งของสินค้าหนึ่งตัวในสาขาหนึ่ง = หนึ่งแถว
    CONSTRAINT UQ_stock_count UNIQUE (branch, item_key, counted_at)
);
GO
/* อ่านสองแบบ: "ล่าสุดของสาขานี้" (หน้านับสต๊อก) และ "ล่าสุดถึงวันที่กำหนดของทุกสาขา" (หน้ารวม) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_count_branch_item_date')
CREATE INDEX IX_stock_count_branch_item_date
    ON dbo.stock_count (branch, item_key, counted_at DESC) INCLUDE (remaining, counter_name);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_count_date')
CREATE INDEX IX_stock_count_date ON dbo.stock_count (counted_at DESC) INCLUDE (branch, item_key, remaining);
GO

/* ============================== ยอดยกมา ==============================
   ชีท 'ยอดยกมา': A=รหัส B=ชื่อ C=สาขา D=ยอดยกมา E=วันที่อัปเดต
   หนึ่งแถวต่อสินค้าต่อสาขา (ชีทเดิมก็เขียนทับแถวเดิมอยู่แล้ว ไม่ได้ต่อท้าย) */
IF OBJECT_ID(N'dbo.stock_balance', N'U') IS NULL
CREATE TABLE dbo.stock_balance (
    branch      NVARCHAR(50)   NOT NULL,
    item_key    NVARCHAR(50)   NOT NULL,
    item_code   NVARCHAR(50)   NOT NULL,
    item_name   NVARCHAR(255)  NULL,
    balance     DECIMAL(18,3)  NOT NULL,
    updated_at  DATETIME2(0)   NULL,        -- วันที่ในชีท (ไม่ใช่เวลาที่เขียนลง SQL)
    CONSTRAINT PK_stock_balance PRIMARY KEY (branch, item_key)
);
GO

/* ============================== ใบเบิกของ ==============================
   ชีท 'ข้อมูลเบิก': A=เลขที่ใบเบิก B=เวลาบันทึก C=รหัส D=ชื่อ E=หน่วย F=จำนวน
                    G=วันที่เบิก H=ผู้เบิก I=สาขา
   บางแถวเก่าไม่มีสาขา — Apps Script เดาจาก 3 ตัวแรกของเลขที่ใบเบิก (CRM-2605-0001 -> crm)
   สคริปต์ย้ายข้อมูลทำแบบเดียวกันแล้วเก็บผลไว้ที่นี่เลย ฝั่งอ่านจึงไม่ต้องเดาอีก */
IF OBJECT_ID(N'dbo.stock_request', N'U') IS NULL
CREATE TABLE dbo.stock_request (
    request_id    BIGINT         IDENTITY(1,1) NOT NULL,
    doc_no        NVARCHAR(50)   NOT NULL,   -- เลขที่ใบเบิก
    saved_at      DATETIME2(0)   NULL,       -- เวลาที่บันทึก
    branch        NVARCHAR(50)   NOT NULL,
    item_key      NVARCHAR(50)   NOT NULL,
    item_code     NVARCHAR(50)   NOT NULL,
    item_name     NVARCHAR(255)  NULL,
    unit          NVARCHAR(50)   NULL,
    qty           DECIMAL(18,3)  NOT NULL,
    request_date  NVARCHAR(30)   NULL,       -- วันที่เบิกตามที่ผู้ใช้เลือก (ชีทเก็บเป็นข้อความหลายรูปแบบ)
    requester     NVARCHAR(255)  NULL,
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_request_created_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_request PRIMARY KEY (request_id),
    CONSTRAINT UQ_stock_request UNIQUE (doc_no, item_key)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_stock_request_branch_item')
CREATE INDEX IX_stock_request_branch_item
    ON dbo.stock_request (branch, item_key, saved_at DESC) INCLUDE (qty, requester);
GO

/* ========================= หมวดจัดเก็บของแต่ละสาขา =========================
   ชีท 'หมวดจัดเก็บสาขา': A=รหัส B=ชื่อ C=สาขา D=หมวดจัดเก็บ
   ชีทเดิมต่อท้ายเรื่อยๆ แถวเดิมของสินค้าเดียวกันจึงมีได้หลายแถว (ตอนอ่านใช้แถวท้ายสุด)
   ตารางนี้เก็บหนึ่งแถวต่อสินค้าต่อสาขา — สคริปต์ย้ายข้อมูลหยิบแถวท้ายสุดของชีทมาให้ */
IF OBJECT_ID(N'dbo.stock_storage_category', N'U') IS NULL
CREATE TABLE dbo.stock_storage_category (
    branch      NVARCHAR(50)   NOT NULL,
    item_key    NVARCHAR(50)   NOT NULL,
    item_code   NVARCHAR(50)   NOT NULL,
    item_name   NVARCHAR(255)  NULL,
    category    NVARCHAR(150)  NULL,
    -- ลำดับแถวในชีท — หน้ารวมสต๊อกใช้ "หมวดของแถวแรกที่เจอ" เป็นค่าของสินค้านั้น
    -- ถ้าไม่เก็บลำดับไว้ จะเลือกไม่ได้ว่าแถวไหนคือแถวแรก แล้วหมวดจะเพี้ยนไปจากเดิม
    sheet_row   INT            NULL,
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_storage_cat_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_storage_category PRIMARY KEY (branch, item_key)
);
GO

/* ====================== ค่าเฉลี่ยยอดใช้ต่อหัว (สูตรเบิก) ======================
   ชีท 'ค่าเฉลี่ยยอดใช้ต่อหัว' ในไฟล์ BOM: A=สาขา B=รหัส C=ชื่อ D=ค่าเฉลี่ย
   ใช้ในสูตร: ยอดเบิก = ค่าเฉลี่ยต่อหัว x ผลรวมจำนวนหัว (ดูหน้านับสต๊อก)
   ยังไม่ได้ย้ายในเฟสนี้ (ตารางเตรียมไว้ก่อน — ดู docs/stock-sql-migration.md) */
IF OBJECT_ID(N'dbo.stock_avg_per_head', N'U') IS NULL
CREATE TABLE dbo.stock_avg_per_head (
    branch      NVARCHAR(50)   NOT NULL,
    item_key    NVARCHAR(50)   NOT NULL,
    item_code   NVARCHAR(50)   NOT NULL,
    item_name   NVARCHAR(255)  NULL,
    avg_qty     DECIMAL(18,4)  NOT NULL,
    updated_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_avg_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_avg_per_head PRIMARY KEY (branch, item_key)
);
GO

/* ==================== เปอร์เซ็นต์การเบิกของแต่ละสาขา ====================
   ชีท 'เปอร์เซ็นการเบิกของแต่ละสาขา' ในไฟล์ supplier: A=วันที่ B=สาขา C=เปอร์เซ็น D=จำนวน259 E=จำนวน359
   ยังไม่ได้ย้ายในเฟสนี้ (ตารางเตรียมไว้ก่อน) */
IF OBJECT_ID(N'dbo.stock_branch_percent', N'U') IS NULL
CREATE TABLE dbo.stock_branch_percent (
    percent_date  DATE           NOT NULL,
    branch        NVARCHAR(50)   NOT NULL,
    percent_value DECIMAL(9,4)   NULL,
    qty_259       DECIMAL(18,3)  NULL,
    qty_359       DECIMAL(18,3)  NULL,
    updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_stock_branch_percent_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_stock_branch_percent PRIMARY KEY (percent_date, branch)
);
GO

PRINT N'สร้างตารางของหน้านับสต๊อกเรียบร้อย';
GO
