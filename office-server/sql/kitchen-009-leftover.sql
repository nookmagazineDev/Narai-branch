/* ============================================================================
   ครัวกลาง: ของเหลือจากการผลิต (เช่น เศษลูกชิ้น) — เก็บเข้าสต๊อกครัว ใช้ผลิตครั้งต่อไป

   dbo.kitchen_menu_leftover   ผูกไอเทมของเหลือกับเมนูที่ผลิต (หนึ่งไอเทมผูกได้หลายเมนู)
     product_key  เมนู QC/RD ที่ผลิตแล้วได้ของเหลือ / ใช้ของเหลือนี้ได้
     item_key     ไอเทมของเหลือใน dbo.stock_item (สร้างจากหน้าเมนูครัวกลางได้ รหัสขึ้นต้น LO-)

   dbo.kitchen_material_receipt เพิ่มสองคอลัมน์ ให้รู้ว่าใบรับเข้าไหนเป็นของเหลือจากคำสั่งผลิตใบไหน
     order_id      คำสั่งผลิตที่ได้ของเหลือนี้ออกมา (NULL = รับของปกติ)
     receipt_kind  'leftover' = ของเหลือจากการผลิต · NULL = รับของปกติ

   ใช้ของเหลือ = ใบเบิกวัตถุดิบปกติ (kitchen_material_issue ผูก order_id) → คงเหลือ/สต๊อกการ์ดตัดเอง

   ตัวเดียวกับ docs/migrate-kitchen-leftover.sql ของ repo storefct
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

IF OBJECT_ID(N'dbo.kitchen_menu_leftover', N'U') IS NULL
CREATE TABLE dbo.kitchen_menu_leftover (
    product_key   NVARCHAR(50)   NOT NULL,
    product_name  NVARCHAR(255)  NULL,
    item_key      NVARCHAR(50)   NOT NULL,
    sort_order    INT            NOT NULL CONSTRAINT DF_kitchen_menu_leftover_sort DEFAULT (0),
    recorder      NVARCHAR(255)  NULL,
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_kitchen_menu_leftover_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_kitchen_menu_leftover PRIMARY KEY (product_key, item_key)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_menu_leftover_item'
                 AND object_id = OBJECT_ID(N'dbo.kitchen_menu_leftover'))
CREATE INDEX IX_kitchen_menu_leftover_item ON dbo.kitchen_menu_leftover (item_key);
GO

IF COL_LENGTH(N'dbo.kitchen_material_receipt', N'order_id') IS NULL
    ALTER TABLE dbo.kitchen_material_receipt ADD order_id BIGINT NULL;
GO

IF COL_LENGTH(N'dbo.kitchen_material_receipt', N'receipt_kind') IS NULL
    ALTER TABLE dbo.kitchen_material_receipt ADD receipt_kind NVARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_kitchen_receipt_kind_item'
                 AND object_id = OBJECT_ID(N'dbo.kitchen_material_receipt'))
CREATE INDEX IX_kitchen_receipt_kind_item
    ON dbo.kitchen_material_receipt (item_key, receive_date DESC) INCLUDE (receipt_kind, order_id, qty);
GO

SET NOEXEC OFF;
GO
