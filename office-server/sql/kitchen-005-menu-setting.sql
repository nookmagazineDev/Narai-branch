/* ============================================================================
   ครัวกลาง: เปิด/ปิดเมนูที่แสดงในหน้าครัวกลาง (หน้า "เมนูครัวกลาง" ของ storefct)

   dbo.kitchen_menu_setting  หนึ่งแถวต่อเมนู QC/RD (product_key = รหัสเมนูแบบ normCode)
                             is_hidden = 1 ไม่แสดงในตัวเลือกเมนูของหน้าครัวกลาง (แพลนผลิต ฯลฯ)
                             ไม่มีแถว = แสดงตามปกติ · ไม่แตะทะเบียนเมนูของ QC/RD

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.kitchen_menu_setting', N'U') IS NULL
CREATE TABLE dbo.kitchen_menu_setting (
    product_key  NVARCHAR(50)  NOT NULL,
    product_name NVARCHAR(255) NULL,
    is_hidden    BIT           NOT NULL CONSTRAINT DF_kitchen_menu_setting_hidden DEFAULT (0),
    recorder     NVARCHAR(255) NULL,
    updated_at   DATETIME2(0)  NOT NULL CONSTRAINT DF_kitchen_menu_setting_updated DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_kitchen_menu_setting PRIMARY KEY (product_key)
);
GO
