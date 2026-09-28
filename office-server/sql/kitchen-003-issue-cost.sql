/* ============================================================================
   ครัวกลาง: ต้นทุนวัตถุดิบ — ให้รายงานการผลิตของแอป storefct มีคอลัมน์ต้นทุน

   เพิ่มสองคอลัมน์ที่ใบเบิกวัตถุดิบ (kitchen_material_issue)
     unit_price  ราคาต้นทุนต่อหน่วยสต๊อก ณ ตอนเบิก — office-server เติมเองจาก stock_item.price
                 (คอลัมน์ C ของชีท item) ไม่รับจากหน้าเว็บ · ราคาว่างหรือ 0 = NULL (ไม่มีราคา)
     loss_qty    ส่วนที่เป็นของสูญเสีย (หน่วยสต๊อก) อยู่ใน qty แล้ว ไม่ได้บวกเพิ่ม · NULL = ไม่ได้แยก

   เก็บราคาไว้กับใบเบิก ไม่คิดจากราคาปัจจุบันตอนเปิดรายงาน เพราะราคาในชีทเปลี่ยนได้
   ต้นทุนของการผลิตที่ผ่านไปแล้วไม่ควรขยับตาม

   ใบเบิกที่มีอยู่ก่อนไฟล์นี้: เติม unit_price ด้วยราคาปัจจุบันครั้งเดียวตอนเพิ่มคอลัมน์
   (ไม่มีราคาย้อนหลังให้ใช้) รันซ้ำแล้วไม่เติมทับอีก

   ตัวเดียวกับ docs/migrate-kitchen-issue-cost.sql ของ repo narai-storefct
   รันผ่าน update-office-server.bat (ใช้ login จาก .env ไม่ต้องพิมพ์รหัส) รันซ้ำได้ ไม่พัง
   ไม่มี USE — ตัวรันต่อเข้าฐาน InventoryNarai (STOCK_DB_NAME) ให้อยู่แล้ว
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- ยังไม่ได้สร้างตารางครัวกลาง = ไม่มีอะไรให้แก้ ข้ามทั้งไฟล์ (ไม่ถือว่าพัง)
IF OBJECT_ID(N'dbo.kitchen_material_issue', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_material_issue';
    SET NOEXEC ON;
END
GO

IF COL_LENGTH(N'dbo.kitchen_material_issue', N'unit_price') IS NULL
BEGIN
    ALTER TABLE dbo.kitchen_material_issue ADD unit_price DECIMAL(18,4) NULL;
    -- ผ่าน EXEC เพราะคอลัมน์เพิ่งเกิดในชุดคำสั่งนี้ · อยู่ใน IF เดียวกันจึงเติมแค่ครั้งแรก
    EXEC (N'UPDATE mi SET unit_price = i.price
              FROM dbo.kitchen_material_issue mi
              JOIN dbo.stock_item i ON i.item_key = mi.item_key
             WHERE mi.unit_price IS NULL AND i.price > 0;');
END
GO

IF COL_LENGTH(N'dbo.kitchen_material_issue', N'loss_qty') IS NULL
    ALTER TABLE dbo.kitchen_material_issue ADD loss_qty DECIMAL(18,3) NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
     WHERE name = N'CK_kitchen_issue_loss'
       AND parent_object_id = OBJECT_ID(N'dbo.kitchen_material_issue')
)
    ALTER TABLE dbo.kitchen_material_issue ADD CONSTRAINT CK_kitchen_issue_loss
        CHECK (loss_qty IS NULL OR (loss_qty >= 0 AND loss_qty <= qty));
GO

-- รายงานดึงใบเบิกตามคำสั่งผลิต — ยังไม่มี index ที่ order_id
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'IX_kitchen_issue_order'
       AND object_id = OBJECT_ID(N'dbo.kitchen_material_issue')
)
    CREATE INDEX IX_kitchen_issue_order
        ON dbo.kitchen_material_issue (order_id) INCLUDE (qty, unit_price, loss_qty)
        WHERE order_id IS NOT NULL;
GO

SET NOEXEC OFF;
GO
