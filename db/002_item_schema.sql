/* ============================================================================
   ตารางฝั่ง "รายการสินค้า" (item master) — ต่อจาก 001_stock_schema.sql
   ปลายทาง: SQL Server 2019 Express — 203.154.185.48:14322 ฐาน InventoryNarai

   ต้นทางคือไฟล์ BOM  1v8WRTaUiEqjtRXzX2g2i5Z8p9FAUvQ37gkdZC8TzhWw
     - ชีท "item"                 (gid 302875824)
     - ชีท "ค่าเฉลี่ยยอดใช้ต่อหัว"  (gid 1722427042)

   ชีทนี้มีคนอ่านอยู่ 4 ทาง ต้องย้ายให้ครบทั้งหมด ไม่งั้นจะเหลือของค้างครึ่งๆ:
     1) getStockItems   (apps-script) อ่าน A-O   -> หน้านับสต๊อกและขอเบิก
     2) getClosingItems (apps-script) อ่าน A-J   -> หน้าปิดยอดสิ้นเดือน
     3) api/insert_order.js?units=1  อ่าน K, L   -> หน่วยเบิกไว้ปัดเศษยอด + itemid ตอนส่งใบสั่งเข้า POS
     4) api/stockcount.js?avgperhead=1           -> ค่าเฉลี่ยต่อหัว ไว้คำนวณยอดเบิกอัตโนมัติ

   รันหลัง 001 เสมอ (ไฟล์นี้ไม่ได้สร้าง database ให้)
   รันซ้ำได้ปลอดภัย — เช็คก่อนทุกคำสั่ง ไม่ลบไม่ทับข้อมูล
   ============================================================================ */

USE [InventoryNarai];
GO

/* ----------------------------------------------------------------------------
   ชีท "item" -> ตาราง item
   A=รหัส B=ชื่อ C=ราคา D=หน่วย E=สถานะ  J=สาขาที่ใช้  K=itemid  L=หน่วยเบิก
   N=หมวดสโตร์  O=Plan

   คอลัมน์ J (สาขาที่ใช้) ไม่ได้เก็บในตารางนี้ — แยกไปตาราง item_branch ข้างล่าง
   เหตุผลอยู่ในคอมเมนต์ของตารางนั้น
   ---------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.item', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.item (
        code_norm    NVARCHAR(32)  NOT NULL,   -- รหัสตัด 0 นำหน้า + ตัวเล็ก = คีย์ที่ทุกตารางใช้จับคู่
        product_code NVARCHAR(32)  NOT NULL,   -- A: รหัสตามที่ผู้ใช้เห็น
        name         NVARCHAR(255) NOT NULL CONSTRAINT DF_it_name  DEFAULT N'',  -- B
        price        DECIMAL(14,4) NULL,       -- C: ราคา/หน่วย
        unit         NVARCHAR(32)  NOT NULL CONSTRAINT DF_it_unit  DEFAULT N'',  -- D
        status       NVARCHAR(60)  NOT NULL CONSTRAINT DF_it_stat  DEFAULT N'',  -- E: ข้อความสถานะจากชีทตรงๆ
        is_active    BIT           NOT NULL CONSTRAINT DF_it_act   DEFAULT 1,    -- E: 0 เมื่อ status = 'ปิดการใช้งาน'
        item_id      INT           NULL,       -- K: itemid ของ POS (ใช้เป็น Ord_ItmID ตอนส่งใบสั่งของ)
        request_unit DECIMAL(14,3) NULL,       -- L: หน่วยเบิก ใช้ปัดเศษยอดเบิกเป็นจำนวนเต็มหน่วย
        store_cat    NVARCHAR(120) NOT NULL CONSTRAINT DF_it_scat  DEFAULT N'',  -- N: หมวดสโตร์ ใช้จัดกลุ่มตอนสั่งของ
        plan_only    BIT           NOT NULL CONSTRAINT DF_it_plan  DEFAULT 0,    -- O: true = สั่งได้เฉพาะปุ่ม "สั่งสินค้าแพลน"
        updated_at   DATETIME2(0)  NOT NULL CONSTRAINT DF_it_upd   DEFAULT SYSDATETIME(),
        CONSTRAINT PK_item PRIMARY KEY CLUSTERED (code_norm)
    );

    /* ตอนส่งใบสั่งของเข้า POS ต้องหา itemid จากรหัสสินค้า และบางครั้งหาย้อนกลับ */
    CREATE INDEX IX_it_item_id ON dbo.item (item_id) WHERE item_id IS NOT NULL;
END
GO

/* ----------------------------------------------------------------------------
   คอลัมน์ J "สาขาที่ใช้" -> ตาราง item_branch (แยกออกมาเป็นแถวๆ)

   ในชีทเก็บรวมเป็นข้อความเดียวคั่นด้วยจุลภาค เช่น "CRM,HRS,XHH"
   โค้ดเดิมจึงต้องอ่าน item ทั้งชีททุกครั้ง แล้ว split(',') ทีละแถวเพื่อดูว่าสาขานี้ใช้ไหม
   (apps-script.js บรรทัด ~830) — ค้นหาแบบนี้ใช้ index ไม่ได้เลย ต้องกวาดทั้งชีทเสมอ

   แยกเป็น 1 แถว = 1 คู่ (สาขา, สินค้า) แล้วคำถาม "สินค้าของสาขานี้มีอะไรบ้าง"
   จะกลายเป็นการ seek ตาม index ทันที — นี่คือจุดที่ได้ความเร็วมากที่สุดของหน้านี้
   ---------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.item_branch', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.item_branch (
        branch    NVARCHAR(10) NOT NULL,   -- รหัสสาขาตัวพิมพ์เล็ก
        code_norm NVARCHAR(32) NOT NULL,
        CONSTRAINT PK_item_branch PRIMARY KEY CLUSTERED (branch, code_norm),
        CONSTRAINT FK_item_branch_item FOREIGN KEY (code_norm) REFERENCES dbo.item (code_norm)
    );

    /* ถามกลับทาง: สินค้าตัวนี้สาขาไหนใช้บ้าง */
    CREATE INDEX IX_ib_code ON dbo.item_branch (code_norm);
END
GO

/* ----------------------------------------------------------------------------
   ชีท "ค่าเฉลี่ยยอดใช้ต่อหัว" -> ตาราง item_avg_per_head
   A=สาขา B=รหัส C=ชื่อ D=ค่าเฉลี่ยต่อหัว

   ใช้ในปุ่ม "คำนวณยอดเบิก" (สูตร: ค่าเฉลี่ยต่อหัว x จำนวนหัวลูกค้า x ตัวคูณวัน)
   และแก้ไขได้จากตารางในหน้านับสต๊อก (คำสั่ง saveAvgPerHead)

   PK (branch, code_norm) ทำให้ saveAvgPerHead ใช้ MERGE ได้ในคำสั่งเดียว
   ของเดิมต้องอ่านทั้งชีทมาไล่หาว่าแถวไหนคือแถวที่ต้องแก้
   ---------------------------------------------------------------------------- */
IF OBJECT_ID(N'dbo.item_avg_per_head', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.item_avg_per_head (
        branch     NVARCHAR(10)  NOT NULL,
        code_norm  NVARCHAR(32)  NOT NULL,
        name       NVARCHAR(255) NOT NULL CONSTRAINT DF_aph_name DEFAULT N'',
        avg_qty    DECIMAL(18,6) NOT NULL CONSTRAINT DF_aph_qty  DEFAULT 0,  -- ค่าเฉลี่ยยอดใช้ต่อหัวลูกค้า 1 คน
        updated_at DATETIME2(0)  NOT NULL CONSTRAINT DF_aph_upd  DEFAULT SYSDATETIME(),
        CONSTRAINT PK_item_avg_per_head PRIMARY KEY CLUSTERED (branch, code_norm)
    );
END
GO

/* ----------------------------------------------------------------------------
   วิวรวม "สินค้าที่สาขานี้ใช้และยังเปิดใช้งานอยู่"

   กฎ 2 ข้อที่โค้ดเดิมกระจายอยู่หลายที่ (ต้องอยู่ในสาขานี้ + ต้องไม่ปิดการใช้งาน)
   ถูกรวมไว้ที่เดียว เวลาเขียน api/stock_items.js จะได้ไม่ต้องเขียนเงื่อนไขซ้ำอีก
   ---------------------------------------------------------------------------- */
CREATE OR ALTER VIEW dbo.v_branch_item AS
SELECT ib.branch,
       i.code_norm,
       i.product_code,
       i.name,
       i.price,
       i.unit,
       i.item_id,
       i.request_unit,
       i.store_cat,
       i.plan_only,
       a.avg_qty
  FROM dbo.item AS i
  JOIN dbo.item_branch AS ib
    ON ib.code_norm = i.code_norm
  LEFT JOIN dbo.item_avg_per_head AS a
    ON a.branch = ib.branch AND a.code_norm = i.code_norm
 WHERE i.is_active = 1;
GO

/* ============================================================================
   ให้สิทธิ์ login ของเว็บอ่านวิวนี้ (ถ้าสร้าง narai_app ไว้แล้วจาก 001)
   db_datareader ครอบคลุมวิวอยู่แล้ว บรรทัดนี้ไว้เผื่อกรณีให้สิทธิ์แบบเจาะจง
   ============================================================================ */
-- GRANT SELECT ON dbo.v_branch_item TO [narai_app];

/* ============================================================================
   เช็คว่าสร้างครบไหม
   ============================================================================ */
-- SELECT name, type_desc FROM sys.objects
--  WHERE name IN ('item','item_branch','item_avg_per_head','v_branch_item');
