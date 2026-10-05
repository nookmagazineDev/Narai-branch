/* ============================================================================
   ครัวกลาง: เก็บสูตร QC/RD ของวันที่ผลิตไว้กับคำสั่งผลิต

   เพิ่มสองคอลัมน์ที่ kitchen_production_order
     recipe_snapshot     สูตร BOM ของ QC/RD ณ ตอนผลิต เป็น JSON
                         { menu: { code, key, name, cost, yieldQty, yieldUnit },
                           lines: [{ itemKey, itemCode, itemName, qty, converter, purchaseUnit, useUnit, noDeduct }] }
                         หน้าเว็บส่งมาตอนเริ่มทำงานกับคำสั่ง (สั่งผลิต / เบิก / บันทึกผล) — เขียนครั้งเดียว ไม่ทับ
     recipe_snapshot_at  เวลาที่เก็บ

   เหตุผลเดียวกับ unit_price ของใบเบิก (kitchen-003): รายงานการผลิตเคยคิด "ตามสูตร" จากสูตรปัจจุบัน
   ทุกครั้งที่เปิด ถ้าแก้สูตรใน QC/RD ทีหลัง ยอดตามสูตร / จำนวนสูตร / ต้นทุนตามสูตรย้อนหลังจะขยับตาม
   คำสั่งผลิตที่มีอยู่ก่อนไฟล์นี้ไม่มีสูตรย้อนหลังให้เก็บ จึงเป็น NULL — รายงานใช้สูตรปัจจุบันแทนแล้วติดป้ายไว้

   ตัวเดียวกับ docs/migrate-kitchen-recipe-snapshot.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
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

IF COL_LENGTH(N'dbo.kitchen_production_order', N'recipe_snapshot') IS NULL
    ALTER TABLE dbo.kitchen_production_order ADD recipe_snapshot NVARCHAR(MAX) NULL;
GO

IF COL_LENGTH(N'dbo.kitchen_production_order', N'recipe_snapshot_at') IS NULL
    ALTER TABLE dbo.kitchen_production_order ADD recipe_snapshot_at DATETIME2(0) NULL;
GO

SET NOEXEC OFF;
GO
