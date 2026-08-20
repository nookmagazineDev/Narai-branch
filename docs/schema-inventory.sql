/* ============================================================================
   ฐานข้อมูลสต๊อก (InventoryNarai) บน Microsoft SQL Server — เครื่องเดียวกับ narai_hr
   รันไฟล์นี้ครั้งเดียวก่อนย้ายข้อมูล

   วิธีรัน (บนเครื่องฐานข้อมูล):
     sqlcmd -S localhost -U narai_web -P "<รหัสผ่าน>" -i docs\schema-inventory.sql
   หรือเปิดใน SQL Server Management Studio แล้วกด Execute

   ที่มาของโครงสร้าง
   ---------------------------------------------------------------------------
   ทุกตารางในไฟล์นี้ถอดมาจากชีทที่ Apps Script ใช้อยู่จริง (ดู apps-script.js)
   คอลัมน์เรียงตามชีทเป๊ะๆ เพื่อให้ย้ายข้อมูลแล้วตรวจทานง่าย ยังไม่ได้ปรับโครงสร้างใหม่
   ตั้งใจให้ขั้นนี้ "ย้ายของให้ครบและตรวจสอบได้ก่อน" แล้วค่อยปรับโครงสร้างทีหลัง

   หลักการที่ใช้
   ---------------------------------------------------------------------------
   1) ชีทที่เป็น "log ต่อท้าย" (นับสต๊อก/เบิก/ของเสีย/รับของ/ปิดรอบ) -> ตารางที่มี id
      รันเข้าเป็นแถวใหม่เรื่อยๆ เหมือนเดิม ไม่ยุบให้เหลือแถวเดียว เพราะระบบเดิม
      อ่าน "แถวล่าสุด" มาใช้และเก็บประวัติทั้งหมดไว้ดูย้อนหลัง (stockHistory)
   2) ชีทที่เป็น "สถานะปัจจุบัน" (ยอดยกมา/หมวดจัดเก็บ/รายการสินค้า) -> PK ตามคีย์จริง
   3) ทุกตารางที่อ้างถึงสินค้า มีคอลัมน์ item_code_norm เพิ่มมาให้
      เพราะรหัสสินค้าในชีทปนกันทั้งแบบตัวเลข (5001) และข้อความ ('05001')
      Apps Script จึงตัด 0 นำหน้าก่อนจับคู่ทุกครั้ง (ฟังก์ชัน normalizeId)
      ถ้าไม่เก็บค่าที่ normalize แล้วไว้ การ join จะพลาดเงียบๆ แบบเดียวกับที่เคยเจอ
      ตอนย้ายตารางงานครั้งแรก (กะ 72% หาเจ้าของไม่เจอ)
   4) วันที่ในชีทเก็บเป็นข้อความ 'dd/MM/yyyy HH:mm' ที่นี่เก็บเป็นชนิดวันที่จริง
      สคริปต์ย้ายข้อมูลจะรายงานให้ดูว่ามีกี่แถวที่แปลงวันที่ไม่ได้ (ถ้ามี)
   5) ข้อความใช้ NVARCHAR ทั้งหมดเพราะเป็นภาษาไทย
============================================================================ */

IF DB_ID(N'InventoryNarai') IS NULL
    CREATE DATABASE InventoryNarai;
GO

USE InventoryNarai;
GO

/* ======================= รายการสินค้า (ชีท item ในไฟล์ BOM) =======================
   A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ J=สาขาที่ใช้ K=itemid L=หน่วยเบิก
   N=หมวดสโตร์ O=Plan (true = สั่งได้เฉพาะปุ่มสั่งสินค้าแพลน) */
IF OBJECT_ID(N'dbo.inv_item', N'U') IS NULL
CREATE TABLE dbo.inv_item (
    item_code       NVARCHAR(50)   NOT NULL,
    item_code_norm  NVARCHAR(50)   NOT NULL,   -- ตัด 0 นำหน้า + ตัวพิมพ์เล็ก ใช้ join
    item_name       NVARCHAR(255)  NULL,
    price           DECIMAL(18,4)  NULL,       -- C = ราคา
    unit            NVARCHAR(50)   NULL,       -- D = หน่วย
    status          NVARCHAR(50)   NULL,       -- E = 'ปิดการใช้งาน' คือเลิกใช้แล้ว
    branches        NVARCHAR(500)  NULL,       -- J = สาขาที่ใช้ คั่นด้วย , เก็บดิบไว้ตรวจทาน
    pos_item_id     NVARCHAR(50)   NULL,       -- K = itemid ฝั่ง POS (ใช้ตอนส่งใบสั่ง)
    order_unit      NVARCHAR(50)   NULL,       -- L = หน่วยเบิก
    store_cat       NVARCHAR(100)  NULL,       -- N = หมวดสโตร์
    plan_only       BIT            NOT NULL CONSTRAINT DF_inv_item_plan_only DEFAULT (0),
    updated_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_inv_item_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_inv_item PRIMARY KEY (item_code)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_item_norm' AND object_id = OBJECT_ID(N'dbo.inv_item'))
    CREATE INDEX IX_inv_item_norm ON dbo.inv_item (item_code_norm);
GO

/* สาขาที่ใช้สินค้าตัวนี้ — แตกจากคอลัมน์ J ที่เก็บเป็น "CRM,HRS,XHH" มาเป็นแถวๆ
   หน้านับสต๊อกกรองด้วยสาขาทุกครั้ง ถ้าปล่อยเป็นข้อความก้อนเดียวจะใช้ index ไม่ได้เลย
   (คอลัมน์ branches ในตารางบนยังเก็บของดิบไว้ ใช้ตรวจทานว่าแตกครบไหม) */
IF OBJECT_ID(N'dbo.inv_item_branch', N'U') IS NULL
CREATE TABLE dbo.inv_item_branch (
    item_code   NVARCHAR(50) NOT NULL,
    branch      NVARCHAR(50) NOT NULL,   -- เก็บเป็นตัวพิมพ์เล็กให้ตรงกับที่เว็บใช้
    CONSTRAINT PK_inv_item_branch PRIMARY KEY (branch, item_code)
);
GO

/* ========================= ราคากลาง (ชีท "8.2") =========================
   [0]รหัส [1]ชื่อ [2]ราคา/หน่วย — ใช้คิดมูลค่าสต๊อกคงเหลือ (ดู api/stockcount.js) */
IF OBJECT_ID(N'dbo.inv_price', N'U') IS NULL
CREATE TABLE dbo.inv_price (
    item_code       NVARCHAR(50)  NOT NULL,
    item_code_norm  NVARCHAR(50)  NOT NULL,
    item_name       NVARCHAR(255) NULL,
    unit_price      DECIMAL(18,4) NULL,
    updated_at      DATETIME2(0)  NOT NULL CONSTRAINT DF_inv_price_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_inv_price PRIMARY KEY (item_code)
);
GO

/* ==================== ข้อมูลนับสตอค (log ต่อท้าย 25,000+ แถว) ====================
   วันที่ลงข้อมูล | ชื่อพนักงานนับสต๊อก | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | จำนวนคงเหลือ */
IF OBJECT_ID(N'dbo.inv_stock_count', N'U') IS NULL
CREATE TABLE dbo.inv_stock_count (
    count_id        BIGINT         IDENTITY(1,1) NOT NULL,
    counted_at      DATETIME2(0)   NULL,        -- 'วันที่ลงข้อมูล' (มีเวลาด้วย)
    counter_name    NVARCHAR(150)  NULL,
    branch          NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    unit            NVARCHAR(50)   NULL,
    remaining       DECIMAL(18,3)  NULL,
    CONSTRAINT PK_inv_stock_count PRIMARY KEY (count_id)
);
GO

/* เส้นทางหลักคือ "ยอดนับล่าสุดของสาขานี้ รายสินค้า" — เรียง count_id ถอยหลังได้เลย */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_stock_count_branch_item' AND object_id = OBJECT_ID(N'dbo.inv_stock_count'))
    CREATE INDEX IX_inv_stock_count_branch_item ON dbo.inv_stock_count (branch, item_code_norm, count_id DESC) INCLUDE (remaining, counted_at, counter_name);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_stock_count_date' AND object_id = OBJECT_ID(N'dbo.inv_stock_count'))
    CREATE INDEX IX_inv_stock_count_date ON dbo.inv_stock_count (branch, counted_at);
GO

/* ========================= ยอดยกมา (สถานะปัจจุบัน) =========================
   รหัสสินค้า | ชื่อสินค้า | สาขา | ยอดยกมา | วันที่อัปเดต */
IF OBJECT_ID(N'dbo.inv_balance', N'U') IS NULL
CREATE TABLE dbo.inv_balance (
    branch          NVARCHAR(50)   NOT NULL,
    item_code_norm  NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,       -- รหัสตามที่เก็บในชีท (ยังไม่ normalize)
    item_name       NVARCHAR(255)  NULL,
    balance         DECIMAL(18,3)  NULL,
    updated_at      DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_balance PRIMARY KEY (branch, item_code_norm)
);
GO

/* ========================== ข้อมูลเบิก (log ต่อท้าย) ==========================
   เลขที่ใบเบิก | วันที่เวลาบันทึก | รหัส | ชื่อ | หน่วย | จำนวน | วันที่เบิก | ชื่อผู้เบิก | สาขา */
IF OBJECT_ID(N'dbo.inv_request', N'U') IS NULL
CREATE TABLE dbo.inv_request (
    request_id      BIGINT         IDENTITY(1,1) NOT NULL,
    req_no          NVARCHAR(50)   NULL,        -- เช่น CRM-2605-0001
    saved_at        DATETIME2(0)   NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    unit            NVARCHAR(50)   NULL,
    qty             DECIMAL(18,3)  NULL,
    request_date    DATE           NULL,        -- 'วันที่เบิก' ที่ผู้ใช้เลือก
    requester       NVARCHAR(150)  NULL,
    branch          NVARCHAR(50)   NULL,
    CONSTRAINT PK_inv_request PRIMARY KEY (request_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_request_branch_item' AND object_id = OBJECT_ID(N'dbo.inv_request'))
    CREATE INDEX IX_inv_request_branch_item ON dbo.inv_request (branch, item_code_norm, request_id DESC) INCLUDE (qty, saved_at, requester);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_request_no' AND object_id = OBJECT_ID(N'dbo.inv_request'))
    CREATE INDEX IX_inv_request_no ON dbo.inv_request (req_no);
GO

/* ====================== หมวดจัดเก็บสาขา (สถานะปัจจุบัน) ======================
   รหัสสินค้า | ชื่อสินค้า | สาขา | หมวดจัดเก็บ */
IF OBJECT_ID(N'dbo.inv_storage_category', N'U') IS NULL
CREATE TABLE dbo.inv_storage_category (
    branch          NVARCHAR(50)   NOT NULL,
    item_code_norm  NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    category        NVARCHAR(100)  NULL,
    updated_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_inv_storage_cat_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_inv_storage_category PRIMARY KEY (branch, item_code_norm)
);
GO

/* ======================== ปิดรอบสิ้นเดือน (log ต่อท้าย) ========================
   วันที่ปิดยอด | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | ยอดคงเหลือสิ้นเดือน |
   มูลค่า/หน่วย | มูลค่ารวม | ผู้บันทึก | เวลาบันทึก

   เก็บเป็น log เหมือนชีทเดิม (ปิดยอดซ้ำได้ ระบบอ่านครั้งล่าสุดมาใช้)
   ถ้าจะบังคับให้เหลือรอบละแถวเดียว ค่อยทำตอนย้าย action มา จะได้ตัดสินใจพร้อมโค้ด */
IF OBJECT_ID(N'dbo.inv_month_end', N'U') IS NULL
CREATE TABLE dbo.inv_month_end (
    closing_id      BIGINT         IDENTITY(1,1) NOT NULL,
    closing_date    DATE           NULL,
    branch          NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    unit            NVARCHAR(50)   NULL,
    qty             DECIMAL(18,3)  NULL,
    unit_value      DECIMAL(18,4)  NULL,
    total_value     DECIMAL(18,4)  NULL,
    recorder        NVARCHAR(150)  NULL,
    saved_at        DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_month_end PRIMARY KEY (closing_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_month_end_branch_date' AND object_id = OBJECT_ID(N'dbo.inv_month_end'))
    CREATE INDEX IX_inv_month_end_branch_date ON dbo.inv_month_end (branch, closing_date DESC) INCLUDE (item_code_norm, qty, total_value);
GO

/* ====================== ต้นทุนจากsup (log ต่อท้าย) ======================
   วันที่ | สาขา | รหัส | ชื่อรายการ | หน่วย | จำนวน | ราคา/หน่วย | มูลค่ารวม | ผู้บันทึก | เวลาบันทึก */
IF OBJECT_ID(N'dbo.inv_sup_cost', N'U') IS NULL
CREATE TABLE dbo.inv_sup_cost (
    cost_id         BIGINT         IDENTITY(1,1) NOT NULL,
    cost_date       DATE           NULL,
    branch          NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    unit            NVARCHAR(50)   NULL,
    qty             DECIMAL(18,3)  NULL,
    unit_price      DECIMAL(18,4)  NULL,
    amount          DECIMAL(18,4)  NULL,
    recorder        NVARCHAR(150)  NULL,
    saved_at        DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_sup_cost PRIMARY KEY (cost_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_sup_cost_branch_date' AND object_id = OBJECT_ID(N'dbo.inv_sup_cost'))
    CREATE INDEX IX_inv_sup_cost_branch_date ON dbo.inv_sup_cost (branch, cost_date);
GO

/* =========================== ของเสีย WASTE (log ต่อท้าย) ===========================
   วันที่ของเสีย | สาขา | รหัสสินค้า | ชื่อสินค้า | หน่วย | จำนวนที่เสีย | ผู้บันทึก | เวลาที่คีย์
   'วันที่ของเสีย' เลือกย้อนหลังได้ จึงแยกจาก 'เวลาที่คีย์' ที่เป็นเวลาจริงตอนกดบันทึก */
IF OBJECT_ID(N'dbo.inv_waste', N'U') IS NULL
CREATE TABLE dbo.inv_waste (
    waste_id        BIGINT         IDENTITY(1,1) NOT NULL,
    waste_date      DATE           NULL,
    branch          NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    unit            NVARCHAR(50)   NULL,
    qty             DECIMAL(18,3)  NULL,
    recorder        NVARCHAR(150)  NULL,
    keyed_at        DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_waste PRIMARY KEY (waste_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_waste_branch_date' AND object_id = OBJECT_ID(N'dbo.inv_waste'))
    CREATE INDEX IX_inv_waste_branch_date ON dbo.inv_waste (branch, waste_date);
GO

/* ==================== ใบสั่งแพลน/สั่งเพิ่มเติม (ชีท plan, log ต่อท้าย) ====================
   วันที่สั่ง | เวลาบันทึก | สาขา | รหัสสาขา | เลขที่ใบสั่ง | ลำดับ | วันที่รับ | itemId |
   รหัสสินค้า | ชื่อสินค้า | จำนวน | หน่วย | ราคา/หน่วย | มูลค่ารวม | ประเภท | ผู้บันทึก

   หมายเหตุ: ตัวจริงของใบสั่งอยู่ใน MySQL ฝั่ง POS (/api/insert_order) ชีทนี้เป็นสำเนาไว้ดู */
IF OBJECT_ID(N'dbo.inv_plan_order', N'U') IS NULL
CREATE TABLE dbo.inv_plan_order (
    plan_id         BIGINT         IDENTITY(1,1) NOT NULL,
    order_date      DATE           NULL,
    saved_time      NVARCHAR(20)   NULL,       -- เก็บเป็นข้อความ 'HH:mm:ss' ตามชีท
    branch          NVARCHAR(50)   NULL,
    outlet_id       NVARCHAR(50)   NULL,
    order_no        NVARCHAR(50)   NULL,
    seq             INT            NULL,
    deliver_date    DATE           NULL,
    pos_item_id     NVARCHAR(50)   NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    qty             DECIMAL(18,3)  NULL,
    unit            NVARCHAR(50)   NULL,
    unit_price      DECIMAL(18,4)  NULL,
    amount          DECIMAL(18,4)  NULL,
    order_type      NVARCHAR(20)   NULL,       -- 'TRF'
    recorder        NVARCHAR(150)  NULL,
    CONSTRAINT PK_inv_plan_order PRIMARY KEY (plan_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_plan_order_no' AND object_id = OBJECT_ID(N'dbo.inv_plan_order'))
    CREATE INDEX IX_inv_plan_order_no ON dbo.inv_plan_order (order_no);
GO

/* ======================== จัดของ (ฝั่งโกดังจัดให้, log) ========================
   A=วันที่ B=สาขา C=รหัส D=ชื่อ E=จำนวนเบิก F=จำนวนส่ง G=เลขที่ใบเบิก H=สถานะฝั่งstore I=เวลาบันทึก */
IF OBJECT_ID(N'dbo.inv_dispatch', N'U') IS NULL
CREATE TABLE dbo.inv_dispatch (
    dispatch_id     BIGINT         IDENTITY(1,1) NOT NULL,
    dispatch_date   DATE           NULL,
    branch          NVARCHAR(50)   NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    qty_requested   DECIMAL(18,3)  NULL,
    qty_sent        DECIMAL(18,3)  NULL,
    order_no        NVARCHAR(50)   NULL,
    store_status    NVARCHAR(50)   NULL,       -- 'แก้ไข' = โกดังส่งไม่เท่าที่เบิก
    saved_at        DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_dispatch PRIMARY KEY (dispatch_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_dispatch_branch_no' AND object_id = OBJECT_ID(N'dbo.inv_dispatch'))
    CREATE INDEX IX_inv_dispatch_branch_no ON dbo.inv_dispatch (branch, order_no);
GO

/* ========================= รับของ (สาขายืนยันรับ, log) =========================
   วันที่รับ | สาขา | เลขที่ใบเบิก | รหัส | ชื่อ | จำนวนเบิก | จำนวนส่ง | จำนวนที่รับจริง |
   สถานะ | หมายเหตุ | รูปภาพ | ผู้บันทึก | เวลาบันทึก */
IF OBJECT_ID(N'dbo.inv_goods_received', N'U') IS NULL
CREATE TABLE dbo.inv_goods_received (
    received_id     BIGINT         IDENTITY(1,1) NOT NULL,
    received_date   DATE           NULL,
    branch          NVARCHAR(50)   NULL,
    order_no        NVARCHAR(50)   NULL,
    item_code       NVARCHAR(50)   NULL,
    item_code_norm  NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    qty_requested   DECIMAL(18,3)  NULL,
    qty_sent        DECIMAL(18,3)  NULL,
    qty_received    DECIMAL(18,3)  NULL,
    status          NVARCHAR(50)   NULL,       -- 'ยืนยัน' / 'แก้ไข'
    note            NVARCHAR(500)  NULL,
    image_url       NVARCHAR(1000) NULL,
    recorder        NVARCHAR(150)  NULL,
    saved_at        DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_goods_received PRIMARY KEY (received_id)
);
GO

/* หน้ารับสินค้าเช็คว่า "ใบนี้/รายการนี้รับไปหรือยัง" ด้วยคู่ เลขที่ใบเบิก + รหัสสินค้า */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_goods_received_no_item' AND object_id = OBJECT_ID(N'dbo.inv_goods_received'))
    CREATE INDEX IX_inv_goods_received_no_item ON dbo.inv_goods_received (order_no, item_code_norm);
GO

/* ======================= ยกเลิกใบเบิก (log อย่างเดียว) =======================
   วันที่สั่ง | สาขา | เลขที่ใบเบิก | วันที่รับ | จำนวนรายการ | ผู้บันทึก | เวลาที่ยกเลิก
   เป็นแค่บันทึกแจ้งทีมที่เกี่ยวข้อง ไม่ได้ไปลบใบสั่งจริงใน POS */
IF OBJECT_ID(N'dbo.inv_order_cancel', N'U') IS NULL
CREATE TABLE dbo.inv_order_cancel (
    cancel_id       BIGINT         IDENTITY(1,1) NOT NULL,
    order_date      DATE           NULL,
    branch          NVARCHAR(50)   NULL,
    order_no        NVARCHAR(50)   NULL,
    deliver_date    DATE           NULL,
    item_count      INT            NULL,
    recorder        NVARCHAR(150)  NULL,
    cancelled_at    DATETIME2(0)   NULL,
    CONSTRAINT PK_inv_order_cancel PRIMARY KEY (cancel_id)
);
GO

/* ================= เปอร์เซ็นการเบิกของแต่ละสาขา (ประวัติรายวัน) =================
   วันที่ | ชื่อสาขา | เปอร์เซ็น | จำนวน259 | จำนวน359 */
IF OBJECT_ID(N'dbo.inv_branch_percent', N'U') IS NULL
CREATE TABLE dbo.inv_branch_percent (
    percent_id      BIGINT         IDENTITY(1,1) NOT NULL,
    effective_date  DATE           NULL,
    branch          NVARCHAR(50)   NULL,
    percent_value   DECIMAL(9,4)   NULL,
    qty_259         DECIMAL(18,3)  NULL,
    qty_359         DECIMAL(18,3)  NULL,
    CONSTRAINT PK_inv_branch_percent PRIMARY KEY (percent_id)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_inv_branch_percent_key' AND object_id = OBJECT_ID(N'dbo.inv_branch_percent'))
    CREATE INDEX IX_inv_branch_percent_key ON dbo.inv_branch_percent (branch, effective_date DESC);
GO

/* ==================== ค่าเฉลี่ยยอดใช้ต่อหัว (สถานะปัจจุบัน) ====================
   สาขา | รหัส | ชื่อ | ค่าเฉลี่ย */
IF OBJECT_ID(N'dbo.inv_avg_per_head', N'U') IS NULL
CREATE TABLE dbo.inv_avg_per_head (
    branch          NVARCHAR(50)   NOT NULL,
    item_code_norm  NVARCHAR(50)   NOT NULL,
    item_code       NVARCHAR(50)   NULL,
    item_name       NVARCHAR(255)  NULL,
    avg_value       DECIMAL(18,4)  NULL,
    updated_at      DATETIME2(0)   NOT NULL CONSTRAINT DF_inv_avg_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_inv_avg_per_head PRIMARY KEY (branch, item_code_norm)
);
GO

/* ==========================================================================
   สิทธิ์: ใช้ login เดียวกับฝั่ง HR (narai_web) จะได้ไม่ต้องดูแลหลายรหัสผ่าน

     USE InventoryNarai;
     CREATE USER narai_web FOR LOGIN narai_web;
     ALTER ROLE db_datareader ADD MEMBER narai_web;
     ALTER ROLE db_datawriter ADD MEMBER narai_web;

   ถ้ายังไม่มี login narai_web ให้สร้างก่อนตามท้ายไฟล์ docs/schema-hr.sql
========================================================================== */
