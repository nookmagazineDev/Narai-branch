/* ============================================================================
   ครัวกลาง: ประวัติการเลื่อนวันผลิต / ยกเลิก / เปลี่ยนสถานะคำสั่งผลิต (หน้าสถานะการผลิตของ storefct)

   dbo.kitchen_production_order_event  หนึ่งแถวต่อเหตุการณ์
     action      'move'   เลื่อนวันผลิต (old_date → new_date)
                 'cancel' ยกเลิก (reason = เหตุผลที่พิมพ์)
                 'status' เปลี่ยนสถานะจาก dropdown อื่น ๆ (เช่น ยกเลิก → รอผลิต)
     old_status / new_status  สถานะก่อน-หลัง
     plan_moved  1 = ย้ายแผนในปฏิทิน (kitchen_production_plan_day.plan_date) ไปด้วย

   เขียนจาก rescheduleProductionOrder / updateProductionOrderStatus ของ office-server/kitchen.js

   ตัวเดียวกับ docs/migrate-kitchen-order-event.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_production_order', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_production_order';
    SET NOEXEC ON;
END
GO

IF OBJECT_ID(N'dbo.kitchen_production_order_event', N'U') IS NULL
CREATE TABLE dbo.kitchen_production_order_event (
    event_id    BIGINT         IDENTITY(1,1) NOT NULL,
    order_id    BIGINT         NOT NULL,
    action      NVARCHAR(10)   NOT NULL,
    old_date    DATE           NULL,
    new_date    DATE           NULL,
    old_status  NVARCHAR(50)   NULL,
    new_status  NVARCHAR(50)   NULL,
    plan_moved  BIT            NOT NULL CONSTRAINT DF_kitchen_order_event_plan DEFAULT (0),
    reason      NVARCHAR(500)  NULL,
    recorder    NVARCHAR(255)  NULL,
    created_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_kitchen_order_event_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_kitchen_production_order_event PRIMARY KEY (event_id),
    CONSTRAINT CK_kitchen_order_event_action CHECK (action IN (N'move', N'cancel', N'status'))
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_order_event_order'
                 AND object_id = OBJECT_ID(N'dbo.kitchen_production_order_event'))
CREATE INDEX IX_kitchen_order_event_order
    ON dbo.kitchen_production_order_event (order_id, action, created_at DESC);
GO

SET NOEXEC OFF;
GO
