-- สร้างตาราง hr_user สำหรับหน้าล็อกอิน — รันไฟล์นี้ไฟล์เดียวจบ
-- ============================================================================
-- ใช้ตอนที่ฐานข้อมูล narai_hr มีอยู่แล้ว (ตารางงาน/พนักงานใช้งานอยู่) แล้วต้องการ
-- เพิ่มเฉพาะตารางของหน้าล็อกอิน ไม่ต้องรัน docs\schema-hr.sql ทั้งไฟล์
--
-- ทำให้ครบทั้ง 2 อย่างในไฟล์เดียว: สร้างตาราง + ให้สิทธิ์ narai_web
-- (ลืมข้อให้สิทธิ์ = ล็อกอินจะขึ้นว่า "login ที่ใช้ยังไม่มีสิทธิ์ในฐานข้อมูลนั้น")
--
-- ----------------------------------------------------------------------------
-- วิธีรัน (ที่เครื่องเซิร์ฟเวอร์ PowerShell แบบ Run as Administrator)
--
--   sqlcmd -S localhost -E -i docs\create-hr-user-table.sql
--
-- หรือเปิดใน SQL Server Management Studio แล้วกด Execute
--
-- รันซ้ำได้ ถ้ามีตารางอยู่แล้วจะข้ามให้ ไม่ลบข้อมูลเดิมทิ้ง
--
-- ----------------------------------------------------------------------------
-- ไม่ต้องกรอกผู้ใช้เองทีละคน
--
-- ครั้งแรกที่ใครล็อกอินแล้วยังไม่มีชื่อในตารางนี้ ระบบจะไปถามชีท User เดิมให้ตามเดิม
-- ถ้าชีทบอกว่าผ่าน ก็คัดลอกคนนั้นเข้าตารางพร้อมเข้ารหัสรหัสผ่านให้เลย
-- ครั้งต่อไปจะเข้าทาง SQL ล้วนๆ ไม่แตะชีทอีก
--
-- จึงรันไฟล์นี้ตอนไหนก็ได้ ไม่ต้องนัดเวลาปิดระบบ และไม่มีช่วงที่ใครล็อกอินไม่ได้
-- (รายละเอียดอยู่ในหัวข้อ "การล็อกอิน" ของ docs/hr-sql-migration.md)
--
-- รหัสผ่านในตารางนี้ไม่ใช่รหัสจริง เก็บเป็นค่าที่ย้อนกลับไม่ได้ (scrypt)
-- ต่างจากชีทเดิมที่ใครเปิดชีทได้ก็อ่านรหัสของทุกสาขาได้ทันที
-- ============================================================================

USE narai_hr;
GO

/* ---------------------------- 1) สร้างตาราง ---------------------------- */
/* คอลัมน์ A/B/C/D ของชีท User เดิม = username / password / สาขา / outlet id
   branch = 'all' คือผู้ใช้ที่เห็นได้ทุกสาขา ใช้กติกาเดียวกับ office-server/hr-session.js */
IF OBJECT_ID(N'dbo.hr_user', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.hr_user (
        username      NVARCHAR(100) NOT NULL,       -- ชื่อผู้ใช้ที่กรอกหน้าล็อกอิน (ชีทคอลัมน์ A)
        password_hash NVARCHAR(255) NOT NULL,       -- scrypt$... — ห้ามเก็บรหัสจริง
        branch        NVARCHAR(50)  NOT NULL,       -- รหัสสาขา หรือ 'all' (ชีทคอลัมน์ C)
        outlet_id     NVARCHAR(50)  NULL,           -- รหัสสาขาฝั่ง POS (ชีทคอลัมน์ D)
        display_name  NVARCHAR(150) NULL,           -- ชื่อที่แสดง (ชีทเดิมไม่มี ปล่อยว่างได้)
        is_active     BIT           NOT NULL CONSTRAINT DF_hr_user_is_active DEFAULT (1),
        last_login_at DATETIME2(0)  NULL,
        created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_created_at DEFAULT (SYSDATETIME()),
        updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_updated_at DEFAULT (SYSDATETIME()),
        CONSTRAINT PK_hr_user PRIMARY KEY (username)
    );
    PRINT 'สร้างตาราง dbo.hr_user แล้ว';
END
ELSE
    PRINT 'มีตาราง dbo.hr_user อยู่แล้ว — ข้ามให้ (ข้อมูลเดิมไม่ถูกแตะ)';
GO

/* --------------------- 2) ให้สิทธิ์ login ที่เว็บใช้ --------------------- */
/* ต้องให้ INSERT/UPDATE ด้วย ไม่ใช่แค่ SELECT เพราะระบบคัดลอกผู้ใช้จากชีทเข้ามาเอง
   ตอนล็อกอินครั้งแรก และเข้ารหัสรหัสผ่านที่ยังเป็นข้อความล้วนทับให้

   ข้ามให้เองถ้ายังไม่มี narai_web (เครื่องที่ยังใช้ sa อยู่) — ไม่ให้สคริปต์ล้มทั้งไฟล์
   วิธีสร้าง narai_web อยู่ใน docs\create-app-login.sql */
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
BEGIN
    GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_user TO narai_web;
    PRINT 'ให้สิทธิ์ dbo.hr_user กับ narai_web แล้ว';
END
ELSE
    PRINT 'ยังไม่มี user narai_web ในฐานข้อมูลนี้ — ข้ามการให้สิทธิ์ (ดู docs\create-app-login.sql)';
GO

/* ------------------------------ 3) เช็คผล ------------------------------ */
/* ต้องได้: ตาราง 9 คอลัมน์ และสิทธิ์ 4 บรรทัด (DELETE/INSERT/SELECT/UPDATE) */
SELECT c.name AS column_name, t.name AS data_type, c.max_length, c.is_nullable
  FROM sys.columns c
  JOIN sys.types t ON t.user_type_id = c.user_type_id
 WHERE c.object_id = OBJECT_ID(N'dbo.hr_user')
 ORDER BY c.column_id;
GO

SELECT u.name AS granted_to, p.permission_name
  FROM sys.database_permissions p
  JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
 WHERE p.major_id = OBJECT_ID(N'dbo.hr_user')
 ORDER BY u.name, p.permission_name;
GO

/* จำนวนผู้ใช้ที่ย้ายเข้ามาแล้ว — รันซ้ำได้เรื่อยๆ เพื่อดูความคืบหน้าการย้าย
   ตอนเพิ่งสร้างจะเป็น 0 ถูกต้องแล้ว เดี๋ยวเพิ่มเองตามที่แต่ละสาขาล็อกอินเข้ามา */
SELECT COUNT(*) AS ผู้ใช้ที่ย้ายเข้ามาแล้ว FROM dbo.hr_user;
GO
