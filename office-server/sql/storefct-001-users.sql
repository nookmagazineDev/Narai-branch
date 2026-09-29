/* ============================================================================
   storefct: ผู้ใช้ + สิทธิ์รายหน้า (ดู office-server/storefct-auth.js)

   dbo.storefct_user       บัญชีของแอป storefct (สโตร์ + ครัวกลาง) แยกจาก dbo.hr_user ของเว็บสาขา
   dbo.storefct_user_page  หน้าที่ผู้ใช้แต่ละคนใช้ได้ · can_edit = 1 บันทึก/แก้ไขได้, 0 = ดูอย่างเดียว
                           page_key ตรงกับ lib/pages.js ของ repo narai-storefct
                           แอดมิน (is_admin = 1) ใช้ได้ทุกหน้าโดยไม่ต้องมีแถวที่นี่

   บัญชีแรก: admin (แอดมิน) รหัสผ่านว่างไว้ — ล็อกอินครั้งแรกด้วยรหัสอะไรก็ได้ (6 ตัวขึ้นไป)
   รหัสนั้นจะกลายเป็นรหัสของ admin ทันที ไม่ต้องฝังรหัสไว้ในไฟล์นี้

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.storefct_user', N'U') IS NULL
CREATE TABLE dbo.storefct_user (
    username      NVARCHAR(100) NOT NULL,
    password_hash NVARCHAR(255) NULL,           -- scrypt$... (hr-password.js) · ว่าง = ตั้งตอนล็อกอินครั้งแรก
    display_name  NVARCHAR(150) NULL,
    is_admin      BIT           NOT NULL CONSTRAINT DF_storefct_user_is_admin DEFAULT (0),
    is_active     BIT           NOT NULL CONSTRAINT DF_storefct_user_is_active DEFAULT (1),
    last_login_at DATETIME2(0)  NULL,
    created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_storefct_user_created_at DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_storefct_user_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_storefct_user PRIMARY KEY (username)
);
GO

IF OBJECT_ID(N'dbo.storefct_user_page', N'U') IS NULL
CREATE TABLE dbo.storefct_user_page (
    username  NVARCHAR(100) NOT NULL,
    page_key  NVARCHAR(50)  NOT NULL,
    can_edit  BIT           NOT NULL CONSTRAINT DF_storefct_user_page_can_edit DEFAULT (0),
    CONSTRAINT PK_storefct_user_page PRIMARY KEY (username, page_key),
    CONSTRAINT FK_storefct_user_page_user FOREIGN KEY (username)
        REFERENCES dbo.storefct_user (username) ON DELETE CASCADE
);
GO

IF NOT EXISTS (SELECT 1 FROM dbo.storefct_user)
    INSERT dbo.storefct_user (username, password_hash, display_name, is_admin)
    VALUES (N'admin', NULL, N'ผู้ดูแลระบบ', 1);
GO
