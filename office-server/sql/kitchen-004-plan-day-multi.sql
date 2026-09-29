/* ============================================================================
   ครัวกลาง: แผนผลิตรายวัน — เมนูเดิมในวันเดิมตั้งได้หลายงาน (แยกแถว ไม่บันทึกทับ)

   เดิม: UQ_kitchen_plan_day = UNIQUE (plan_date, product_key) ตั้งเมนูเดิมซ้ำ = แทนที่จำนวนเดิม
         คำสั่งผลิตผูกกับแผนด้วย (วัน, สินค้า, source = 'plan') และ UX_kitchen_order_day_auto
         ให้มีใบ plan ได้ใบเดียวต่อสินค้าต่อวัน
   ใหม่: - ลบ UQ_kitchen_plan_day — หนึ่งแถว = หนึ่งงาน ตั้งซ้ำ = งานใหม่อีกแถว
         - คำสั่งผลิตมีคอลัมน์ plan_day_id ผูกกับแถวแผนตรง ๆ (unique — หนึ่งแผนมีคำสั่งได้ใบเดียว)
           เติมให้คำสั่ง source = 'plan' ที่มีอยู่แล้วด้วยวัน+สินค้า (ตอนนี้ยังจับคู่ได้ตัวเดียวแน่นอน)
         - UX_kitchen_order_day_auto เหลือกันซ้ำเฉพาะ source = 'demand'

   ตัวเดียวกับ docs/migrate-kitchen-plan-day-multi.sql ของ repo narai-storefct
   รันผ่าน update-office-server.bat (ใช้ login จาก .env ไม่ต้องพิมพ์รหัส) รันซ้ำได้ ไม่พัง
   ไม่มี USE — ตัวรันต่อเข้าฐาน InventoryNarai (STOCK_DB_NAME) ให้อยู่แล้ว
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- ยังไม่ได้สร้างตารางครัวกลาง/แผนรายวัน = ไม่มีอะไรให้แก้ ข้ามทั้งไฟล์ (ไม่ถือว่าพัง)
IF OBJECT_ID(N'dbo.kitchen_production_order', N'U') IS NULL
   OR OBJECT_ID(N'dbo.kitchen_production_plan_day', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_production_order / dbo.kitchen_production_plan_day';
    SET NOEXEC ON;
END
GO

IF EXISTS (
    SELECT 1 FROM sys.key_constraints
     WHERE name = N'UQ_kitchen_plan_day'
       AND parent_object_id = OBJECT_ID(N'dbo.kitchen_production_plan_day')
)
    ALTER TABLE dbo.kitchen_production_plan_day DROP CONSTRAINT UQ_kitchen_plan_day;
GO

-- ดัชนีธรรมดาไว้ค้นแผนตามวัน (แทน unique ที่เพิ่งลบ ซึ่งเคยทำหน้าที่นี้ให้)
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'IX_kitchen_plan_day_date'
       AND object_id = OBJECT_ID(N'dbo.kitchen_production_plan_day')
)
    CREATE INDEX IX_kitchen_plan_day_date ON dbo.kitchen_production_plan_day (plan_date, product_key);
GO

IF COL_LENGTH(N'dbo.kitchen_production_order', N'plan_day_id') IS NULL
    ALTER TABLE dbo.kitchen_production_order ADD plan_day_id INT NULL;
GO

-- คำสั่งจากแผนที่มีอยู่แล้ว: ผูกกับแถวแผนด้วยวัน+สินค้า (ก่อนไฟล์นี้ unique อยู่ จับคู่ได้แถวเดียว)
UPDATE o
   SET plan_day_id = d.plan_day_id
  FROM dbo.kitchen_production_order o
  JOIN dbo.kitchen_production_plan_day d
    ON d.plan_date = o.produce_date AND d.product_key = o.product_key
 WHERE o.source = N'plan' AND o.plan_day_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM dbo.kitchen_production_order x WHERE x.plan_day_id = d.plan_day_id);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'UX_kitchen_order_plan_day'
       AND object_id = OBJECT_ID(N'dbo.kitchen_production_order')
)
    CREATE UNIQUE INDEX UX_kitchen_order_plan_day
        ON dbo.kitchen_production_order (plan_day_id)
        WHERE plan_day_id IS NOT NULL;
GO

-- กันซ้ำ "หนึ่งใบต่อสินค้าต่อวัน" เหลือเฉพาะ demand — plan กันด้วย plan_day_id แทน
IF EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'UX_kitchen_order_day_auto'
       AND object_id = OBJECT_ID(N'dbo.kitchen_production_order')
       AND filter_definition LIKE N'%plan%'
)
    DROP INDEX UX_kitchen_order_day_auto ON dbo.kitchen_production_order;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = N'UX_kitchen_order_day_auto'
       AND object_id = OBJECT_ID(N'dbo.kitchen_production_order')
)
    CREATE UNIQUE INDEX UX_kitchen_order_day_auto
        ON dbo.kitchen_production_order (produce_date, product_key, source)
        WHERE source = N'demand';
GO

SET NOEXEC OFF;
GO
