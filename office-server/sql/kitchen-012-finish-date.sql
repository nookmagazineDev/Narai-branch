/* ============================================================================
   ครัวกลาง: วันที่ผลิตเสร็จ แยกจากวันผลิต (ตามคำสั่ง/แผน) และเวลาที่กดสั่ง

   kitchen_production_run.finish_date    วันที่ผลิตเสร็จจริงของรอบนั้น (กรอกได้ ตั้งต้นเป็นวันที่บันทึก)
   kitchen_production_order.finish_date  วันที่ปิดงาน (สถานะเป็น "ผลิตเสร็จ") · ไม่เสร็จ = NULL
   kitchen_production_run_edit.old_finish_date / new_finish_date  ประวัติการแก้วันที่เสร็จ

   produce_date เดิม = วันผลิตตามคำสั่ง/แผน (ไม่เปลี่ยนความหมาย) · created_at ของคำสั่ง = เวลาที่กดสั่ง
   ข้อมูลเก่า: finish_date ของรอบผลิต = วันที่บันทึก (recorded_at) · ของคำสั่งที่เสร็จแล้ว = วันเสร็จล่าสุดของรอบผลิต

   เขียนจาก saveProductionRun / updateProductionRun / updateProductionOrderStatus ของ office-server/kitchen.js

   ตัวเดียวกับ docs/migrate-kitchen-finish-date.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_production_run', N'U') IS NULL OR OBJECT_ID(N'dbo.kitchen_production_order', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตารางครัวกลาง';
    SET NOEXEC ON;
END
GO

IF COL_LENGTH(N'dbo.kitchen_production_run', N'finish_date') IS NULL
    ALTER TABLE dbo.kitchen_production_run ADD finish_date DATE NULL;
GO
IF COL_LENGTH(N'dbo.kitchen_production_order', N'finish_date') IS NULL
    ALTER TABLE dbo.kitchen_production_order ADD finish_date DATE NULL;
GO
IF OBJECT_ID(N'dbo.kitchen_production_run_edit', N'U') IS NOT NULL
   AND COL_LENGTH(N'dbo.kitchen_production_run_edit', N'old_finish_date') IS NULL
    ALTER TABLE dbo.kitchen_production_run_edit ADD old_finish_date DATE NULL, new_finish_date DATE NULL;
GO

-- เติมข้อมูลเก่า (เฉพาะแถวที่ยังว่าง)
UPDATE dbo.kitchen_production_run
   SET finish_date = CAST(recorded_at AS DATE)
 WHERE finish_date IS NULL;
GO
UPDATE o
   SET finish_date = COALESCE(r.last_finish, CAST(o.updated_at AS DATE))
  FROM dbo.kitchen_production_order o
  OUTER APPLY (SELECT MAX(p.finish_date) AS last_finish FROM dbo.kitchen_production_run p WHERE p.order_id = o.order_id) r
 WHERE o.status = N'ผลิตเสร็จ' AND o.finish_date IS NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_production_run_finish'
                AND object_id = OBJECT_ID(N'dbo.kitchen_production_run'))
    CREATE INDEX IX_kitchen_production_run_finish ON dbo.kitchen_production_run (finish_date);
GO

SET NOEXEC OFF;
GO
