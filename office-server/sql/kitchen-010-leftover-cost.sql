/* ============================================================================
   ครัวกลาง: ต้นทุนของของเหลือจากการผลิต

   kitchen_material_receipt.unit_price  ต้นทุนต่อหน่วย ณ ตอนบันทึกของเหลือ
     = ต้นทุนวัตถุดิบจริงของคำสั่งผลิต (ใบเบิก × ราคาตอนเบิก) ÷ ยอดผลิตได้ทั้งคำสั่ง
     (เฉพาะไอเทม LO- ที่หน่วยตรงกับหน่วยผลผลิต · คิดไม่ได้ = NULL)
   และอัปเดต stock_item.price ของไอเทม LO- เป็นค่านี้ทุกครั้ง → ตอนนำของเหลือไปใช้ ใบเบิกได้ราคานี้

   เขียนจาก saveProductionRun ของ office-server/kitchen.js

   ตัวเดียวกับ docs/migrate-kitchen-leftover-cost.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_material_receipt', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตารางครัวกลาง';
    SET NOEXEC ON;
END
GO

IF COL_LENGTH(N'dbo.kitchen_material_receipt', N'unit_price') IS NULL
    ALTER TABLE dbo.kitchen_material_receipt ADD unit_price DECIMAL(18,4) NULL;
GO

SET NOEXEC OFF;
GO
