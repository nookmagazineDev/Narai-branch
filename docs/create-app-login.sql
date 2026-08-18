-- สร้าง login เฉพาะสำหรับเว็บ ใช้แทน sa
-- ============================================================================
-- ทำไมต้องเลิกใช้ sa: พอร์ต 1433 ของเครื่องนี้เปิดออกอินเทอร์เน็ต จึงโดนสแกน
-- เดารหัสตลอดเวลา และ sa มีสิทธิ์ทุกอย่างบนทุกฐานข้อมูลในเครื่อง
-- ถ้าหลุดคือเสียทั้งเครื่อง ไม่ใช่แค่ narai_hr
--
-- login ตัวนี้เข้าได้เฉพาะ narai_hr และทำได้แค่ อ่าน/เพิ่ม/แก้/ลบ ในตาราง hr_*
-- เปลี่ยนสคีมาหรือแตะฐานข้อมูลอื่นไม่ได้เลย
--
-- วิธีรัน (ที่เครื่องเซิร์ฟเวอร์ เปิด PowerShell แบบ Run as Administrator):
--   1. แก้ <<<ใส่รหัสผ่านใหม่ตรงนี้>>> ข้างล่างเป็นรหัสที่ตั้งเอง
--      ยาวอย่างน้อย 16 ตัว ผสมพิมพ์เล็ก-ใหญ่-ตัวเลข-อักขระพิเศษ
--      ห้ามใช้รหัสเดียวกับ sa และห้ามมีเครื่องหมาย ' (single quote) ในรหัส
--   2. sqlcmd -S localhost -E -i docs\create-app-login.sql
--   3. เอา narai_web + รหัสที่ตั้ง ไปใส่ HR_DB_USER / HR_DB_PASSWORD บน Vercel
--      แล้วกด Redeploy
-- ============================================================================

USE master;
GO

-- ดูก่อนว่ามี login อะไรอยู่บ้าง (เผื่อเคยสร้างไว้แล้ว)
SELECT name, type_desc, is_disabled, create_date
  FROM sys.sql_logins
 ORDER BY create_date DESC;
GO

IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'narai_web')
BEGIN
    CREATE LOGIN narai_web
      WITH PASSWORD = N'<<<ใส่รหัสผ่านใหม่ตรงนี้>>>',
           CHECK_POLICY = ON,
           DEFAULT_DATABASE = narai_hr;
    PRINT 'สร้าง login narai_web แล้ว';
END
ELSE
BEGIN
    -- มีอยู่แล้ว = ตั้งรหัสใหม่ทับ (ใช้ตอนลืมรหัส)
    ALTER LOGIN narai_web WITH PASSWORD = N'<<<ใส่รหัสผ่านใหม่ตรงนี้>>>';
    ALTER LOGIN narai_web ENABLE;
    PRINT 'มี login narai_web อยู่แล้ว — ตั้งรหัสใหม่ให้';
END
GO

USE narai_hr;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
    CREATE USER narai_web FOR LOGIN narai_web;
GO

-- สิทธิ์เท่าที่เว็บต้องใช้จริง ไม่ให้เกินนี้
-- (ไม่ให้ db_owner / ไม่ให้ ALTER / ไม่ให้ CREATE — เปลี่ยนสคีมาต้องใช้ sa เท่านั้น)
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_branch        TO narai_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_employee      TO narai_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_timesheet     TO narai_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_timesheet_log TO narai_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_daily_sales   TO narai_web;
GO

-- เช็คผล: ต้องได้ narai_hr กับสิทธิ์ครบ 5 ตาราง
SELECT DB_NAME() AS current_db;
SELECT o.name AS table_name, p.permission_name
  FROM sys.database_permissions p
  JOIN sys.objects o ON o.object_id = p.major_id
  JOIN sys.database_principals u ON u.principal_id = p.grantee_principal_id
 WHERE u.name = N'narai_web'
 ORDER BY o.name, p.permission_name;
GO
