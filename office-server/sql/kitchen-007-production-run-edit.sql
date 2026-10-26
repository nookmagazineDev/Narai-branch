/* ============================================================================
   ครัวกลาง: ประวัติการแก้ยอดผลิต (หน้าสถานะการผลิตของ storefct)

   dbo.kitchen_production_run_edit  หนึ่งแถวต่อการแก้/ลบบันทึกการผลิตหนึ่งครั้ง
     action     'edit' = แก้ยอด · 'delete' = ลบบันทึกการผลิตทั้งแถว (new_* เป็น NULL)
     old_* / new_*  ยอดผลิตได้ / ของเสีย ก่อนและหลังแก้
     reason     เหตุผลที่แก้ (ไม่บังคับ)

   ไม่ผูก FK กับ kitchen_production_run — ลบบันทึกการผลิตแล้วประวัติต้องยังอยู่
   เขียนจาก updateProductionRun / deleteProductionRun ของ office-server/kitchen.js

   ตัวเดียวกับ docs/migrate-kitchen-run-edit.sql ของ repo storefct
   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_production_run', N'U') IS NULL
BEGIN
    PRINT N'ข้าม: ยังไม่มีตาราง dbo.kitchen_production_run';
    SET NOEXEC ON;
END
GO

IF OBJECT_ID(N'dbo.kitchen_production_run_edit', N'U') IS NULL
CREATE TABLE dbo.kitchen_production_run_edit (
    edit_id           BIGINT         IDENTITY(1,1) NOT NULL,
    run_id            BIGINT         NOT NULL,
    order_id          BIGINT         NULL,
    action            NVARCHAR(10)   NOT NULL CONSTRAINT DF_kitchen_run_edit_action DEFAULT (N'edit'),
    old_qty_produced  DECIMAL(18,3)  NULL,
    new_qty_produced  DECIMAL(18,3)  NULL,
    old_qty_waste     DECIMAL(18,3)  NULL,
    new_qty_waste     DECIMAL(18,3)  NULL,
    reason            NVARCHAR(500)  NULL,
    recorder          NVARCHAR(255)  NULL,
    edited_at         DATETIME2(0)   NOT NULL CONSTRAINT DF_kitchen_run_edit_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_kitchen_production_run_edit PRIMARY KEY (edit_id),
    CONSTRAINT CK_kitchen_run_edit_action CHECK (action IN (N'edit', N'delete'))
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_run_edit_order'
                 AND object_id = OBJECT_ID(N'dbo.kitchen_production_run_edit'))
CREATE INDEX IX_kitchen_run_edit_order
    ON dbo.kitchen_production_run_edit (order_id, edited_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_run_order'
                 AND object_id = OBJECT_ID(N'dbo.kitchen_production_run'))
CREATE INDEX IX_kitchen_run_order
    ON dbo.kitchen_production_run (order_id) INCLUDE (qty_produced, qty_waste);
GO

SET NOEXEC OFF;
GO
