/* ============================================================================
   ครัวกลาง: ให้คำสั่งผลิตแบบกรอกเอง (manual) สั่งซ้ำสินค้าเดิมในวันเดิมได้ — แยกใบทุกครั้งที่กดสั่ง

   เดิม: UQ_kitchen_order_day = UNIQUE (produce_date, product_key, source) ครอบทุก source
   ใหม่: unique index แบบกรองเฉพาะ source = demand / plan
         ปุ่ม "สร้างจากยอดสาขา" / "สร้างจากแผน" ยังกันใบซ้ำเหมือนเดิม ส่วน manual ออกใบใหม่ได้ทุกครั้ง

   ตัวเดียวกับ docs/migrate-kitchen-order-per-click.sql ของ repo narai-storefct
   รันผ่าน update-office-server.bat (ใช้ login จาก .env ไม่ต้องพิมพ์รหัส) รันซ้ำได้ ไม่พัง
   ไม่มี USE — ตัวรันต่อเข้าฐาน InventoryNarai (STOCK_DB_NAME) ให้อยู่แล้ว
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- ยังไม่ได้สร้างตารางครัวกลาง = ไม่มีอะไรให้แก้ ข้ามทั้งไฟล์ (ไม่ถือว่าพัง)
IF OBJECT_ID(N'dbo.kitchen_production_order', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_production_order';
    SET NOEXEC ON;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.key_constraints
     WHERE name = N'UQ_kitchen_order_day'
       AND parent_object_id = OBJECT_ID(N'dbo.kitchen_production_order')
)
    ALTER TABLE dbo.kitchen_production_order DROP CONSTRAINT UQ_kitchen_order_day;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'UX_kitchen_order_day_auto'
       AND object_id = OBJECT_ID(N'dbo.kitchen_production_order')
)
    CREATE UNIQUE INDEX UX_kitchen_order_day_auto
        ON dbo.kitchen_production_order (produce_date, product_key, source)
        WHERE source IN (N'demand', N'plan');
GO

SET NOEXEC OFF;
GO
