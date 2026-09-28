/* ============================================================================
   ครัวกลาง: แผนผลิตรายวัน — เมนู "แพลนผลิต" (ปฏิทิน) ของแอป storefct

   หนึ่งแถว = เมนูหนึ่งตัวในวันหนึ่ง ตั้งจากปฏิทิน ทั้งทีละวันและหลายวันพร้อมกัน
   ตั้งเมนูเดิมซ้ำในวันเดิม = แทนที่จำนวนเดิม (UNIQUE plan_date + product_key)

   ผูกกับคำสั่งผลิตด้วย (plan_date = produce_date, product_key, source = 'plan') ไม่มีคอลัมน์ผูกตรง
   เพราะ UX_kitchen_order_day_auto ให้มีคำสั่ง source = 'plan' ได้ใบเดียวต่อสินค้าต่อวันอยู่แล้ว

   ใช้แทนแผนประจำรอบ (kitchen_production_plan) — ตารางเดิมไม่ถูกแตะ ข้อมูลยังอยู่ แค่ไม่มีหน้าเว็บใช้แล้ว

   ตัวเดียวกับ docs/migrate-kitchen-plan-by-date.sql ของ repo narai-storefct
   รันผ่าน update-office-server.bat (ใช้ login จาก .env ไม่ต้องพิมพ์รหัส) รันซ้ำได้ ไม่พัง
   ไม่มี USE — ตัวรันต่อเข้าฐาน InventoryNarai (STOCK_DB_NAME) ให้อยู่แล้ว
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_production_plan_day', N'U') IS NULL
CREATE TABLE dbo.kitchen_production_plan_day (
    plan_day_id   INT            IDENTITY(1,1) NOT NULL,
    plan_date     DATE           NOT NULL,
    product_key   NVARCHAR(50)   NOT NULL,
    product_code  NVARCHAR(50)   NOT NULL CONSTRAINT DF_kitchen_plan_day_code DEFAULT (N''),
    product_name  NVARCHAR(255)  NOT NULL CONSTRAINT DF_kitchen_plan_day_name DEFAULT (N''),
    planned_qty   DECIMAL(18,3)  NOT NULL,
    unit          NVARCHAR(50)   NULL,
    note          NVARCHAR(500)  NULL,
    recorder      NVARCHAR(255)  NULL,
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_kitchen_plan_day_created DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_kitchen_plan_day_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_kitchen_production_plan_day PRIMARY KEY (plan_day_id),
    CONSTRAINT UQ_kitchen_plan_day UNIQUE (plan_date, product_key),
    CONSTRAINT CK_kitchen_plan_day_qty CHECK (planned_qty > 0)
);
GO
