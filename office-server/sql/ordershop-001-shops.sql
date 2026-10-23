/* ============================================================================
   ordernaraipizzeria: ทะเบียนร้านที่เบิกของ + รหัสผ่านล็อกอินของร้าน (ดู office-server/ordershop.js)

   dbo.order_shop  หนึ่งแถวต่อหนึ่งร้าน
     shop_no      รหัสตัวเลข = outlet ของ POS (Ord_StrID ใน myfbdata.orderd) เช่น 51
     branch_code  รหัสสาขาภาษาอังกฤษ 3 ตัว (ตัวพิมพ์ใหญ่) เช่น SUM — ใช้ล็อกอินและหาฐาน myfbdata<code>
     shop_name    ชื่ออธิบายที่แสดงต่อท้ายรหัส เช่น นาราย พิซซ่า สุขุมวิท

   บัญชีแยกจาก dbo.hr_user (เว็บสาขา) และ dbo.storefct_user (สโตร์/ครัวกลาง) โดยตั้งใจ —
   ร้านล็อกอินด้วยรหัสร้านอย่างเดียว ไม่มีชื่อผู้ใช้รายคน ส่วนคนจัดการทะเบียนร้านคือแอดมินของ storefct

   รันผ่าน update-office-server.bat (scripts/run-migrations.mjs) รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.order_shop', N'U') IS NULL
CREATE TABLE dbo.order_shop (
    shop_no       INT           NOT NULL,
    branch_code   NVARCHAR(3)   NOT NULL,
    shop_name     NVARCHAR(150) NOT NULL,
    password_hash NVARCHAR(255) NULL,           -- scrypt$... (hr-password.js) · ว่าง = ยังล็อกอินไม่ได้
    is_active     BIT           NOT NULL CONSTRAINT DF_order_shop_is_active DEFAULT (1),
    last_login_at DATETIME2(0)  NULL,
    created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_order_shop_created_at DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_order_shop_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_order_shop PRIMARY KEY (shop_no),
    CONSTRAINT UQ_order_shop_code UNIQUE (branch_code),
    -- ตัวแรกต้องเป็นตัวอักษร ที่เหลือเป็นตัวอักษรหรือตัวเลข (มีสาขาเดิมที่เป็น P90 / ZK3 อยู่แล้ว)
    CONSTRAINT CK_order_shop_code CHECK (branch_code LIKE '[A-Z][A-Z0-9][A-Z0-9]'),
    CONSTRAINT CK_order_shop_no CHECK (shop_no > 0)
);
GO
