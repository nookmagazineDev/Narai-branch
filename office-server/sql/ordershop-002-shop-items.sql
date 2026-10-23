/* ============================================================================
   ordernaraipizzeria: สินค้าที่แต่ละร้านเบิกได้ (ดู orderShopGetItems / orderShopSetItems ใน ordershop.js)

   dbo.order_shop_item  หนึ่งแถว = ร้านนี้เบิกสินค้านี้ได้ · ร้านที่ไม่มีแถวเลย = ยังเบิกอะไรไม่ได้
     item_key  ตรงกับ dbo.stock_item.item_key (รหัสที่ normalize แล้ว)

   แยกจาก dbo.stock_item_branch โดยตั้งใจ — ตารางนั้น item-sync.js เขียนทับจากชีท 'item' ทุกชั่วโมง
   รายการที่ผู้ดูแลตั้งเองต้องไม่หายตามรอบซิงก์

   รันผ่าน update-office-server.bat (scripts/run-migrations.mjs) รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.order_shop_item', N'U') IS NULL
CREATE TABLE dbo.order_shop_item (
    shop_no     INT           NOT NULL,
    item_key    NVARCHAR(50)  NOT NULL,
    created_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_order_shop_item_created_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_order_shop_item PRIMARY KEY (shop_no, item_key),
    -- แก้รหัสตัวเลขร้านแล้วรายการตามไปด้วย · ลบร้านแล้วรายการหายตาม
    CONSTRAINT FK_order_shop_item_shop FOREIGN KEY (shop_no)
        REFERENCES dbo.order_shop (shop_no) ON UPDATE CASCADE ON DELETE CASCADE
);
GO
