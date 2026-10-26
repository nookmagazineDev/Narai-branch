/* ============================================================================
   ครัวกลาง: แก้ยอดของเหลือที่บันทึกแล้ว (ป๊อปอัพแก้ยอดผลิตของ storefct) + เก็บประวัติ

   dbo.kitchen_production_order_event
     action เพิ่ม 'leftover' = แก้/เพิ่มยอดของเหลือของคำสั่ง (old_qty → new_qty ของ item_key)
     เพิ่มคอลัมน์ item_key / item_name / old_qty / new_qty (ใช้กับ action 'leftover')

   เขียนจาก saveOrderLeftover ของ office-server/kitchen.js

   ตัวเดียวกับ docs/migrate-kitchen-leftover-edit.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_production_order_event', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_production_order_event (รัน kitchen-008 ก่อน)';
    SET NOEXEC ON;
END
GO

IF COL_LENGTH(N'dbo.kitchen_production_order_event', N'item_key') IS NULL
    ALTER TABLE dbo.kitchen_production_order_event ADD item_key NVARCHAR(50) NULL;
GO
IF COL_LENGTH(N'dbo.kitchen_production_order_event', N'item_name') IS NULL
    ALTER TABLE dbo.kitchen_production_order_event ADD item_name NVARCHAR(255) NULL;
GO
IF COL_LENGTH(N'dbo.kitchen_production_order_event', N'old_qty') IS NULL
    ALTER TABLE dbo.kitchen_production_order_event ADD old_qty DECIMAL(18,3) NULL;
GO
IF COL_LENGTH(N'dbo.kitchen_production_order_event', N'new_qty') IS NULL
    ALTER TABLE dbo.kitchen_production_order_event ADD new_qty DECIMAL(18,3) NULL;
GO

-- ขยาย CHECK ของ action ให้รับ 'leftover' (ลบแล้วสร้างใหม่ — ของเดิมรับแค่ move/cancel/status)
IF EXISTS (SELECT 1 FROM sys.check_constraints
            WHERE name = N'CK_kitchen_order_event_action'
              AND parent_object_id = OBJECT_ID(N'dbo.kitchen_production_order_event')
              AND definition NOT LIKE N'%leftover%')
    ALTER TABLE dbo.kitchen_production_order_event DROP CONSTRAINT CK_kitchen_order_event_action;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
                WHERE name = N'CK_kitchen_order_event_action'
                  AND parent_object_id = OBJECT_ID(N'dbo.kitchen_production_order_event'))
    ALTER TABLE dbo.kitchen_production_order_event ADD CONSTRAINT CK_kitchen_order_event_action
        CHECK (action IN (N'move', N'cancel', N'status', N'leftover'));
GO

SET NOEXEC OFF;
GO
