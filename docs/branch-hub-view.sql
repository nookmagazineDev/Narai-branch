/* ============================================================================
   ระบบตารางงาน: เลิกเก็บทะเบียนสาขาของตัวเอง ไปอ่านทะเบียนแม่แทน
   ฐานข้อมูล narai_hr

   ที่มา
   ---------------------------------------------------------------------------
   ทะเบียนสาขาเคยมีอยู่สามชุดในสามโปรเจค แล้วก็หลุดกันจริง (รายละเอียดและแผนเต็ม
   อยู่ที่ naraipizzeria/docs/branch-hub.md) ทะเบียนแม่ตอนนี้คือ
       InventoryNarai.dbo.hr_branch          ทะเบียนสาขา
       InventoryNarai.dbo.hr_branch_target   เป้ายอด/เพดานค่าแรงรายสาขา
   ซึ่งแก้ได้จากหน้าเว็บ (แดชบอร์ดออฟฟิศ > HR > จัดการสาขา) ต่างจากตารางเดิมที่นี่
   ที่ไม่มีหน้าจอเลย ต้องเปิด SSMS แล้ว UPDATE เอง (ดู docs/hr-sql-migration.md:266)

   ทำไมใช้ view ไม่ใช่งาน sync
   ---------------------------------------------------------------------------
   narai_hr กับ InventoryNarai อยู่บนอินสแตนซ์เดียวกัน (ดู office-server/hr-db.js:6)
   จึงอ่านข้ามฐานด้วยชื่อสามท่อนได้ตรง ๆ

   และตาราง dbo.hr_branch ที่นี่ "ไม่มีใครเขียนจากแอปเลย" — ไล่ทั้งโปรเจคแล้วเจอแค่
   สอง SELECT (office-server/schedule.js:352 และ :632) ตารางที่มีแต่คนอ่าน
   เปลี่ยนเป็น view ได้โดยไม่ต้องแก้โค้ดสักบรรทัด

   ถ้าทำเป็นงาน sync แทน จะได้ข้อมูลสองชุดที่หลุดกันได้ + ต้องมี cron + ต้องมีคน
   คอยดูว่า sync ตายหรือยัง ซึ่งเป็นปัญหาเดียวกับที่กำลังจะแก้อยู่พอดี

   ⚠️ ไฟล์นี้เป็น UTF-8 (มี BOM) — ต่างจากไฟล์ .sql อื่นในโฟลเดอร์นี้โดยตั้งใจ
      เพราะมี N'ใช้งาน' อยู่ในเงื่อนไข ถ้าบันทึกทับเป็น ANSI หรือรันด้วย codepage ผิด
      view จะเทียบสถานะไม่ตรงแล้ว "ทุกสาขากลายเป็นปิดการใช้งาน" เงียบ ๆ
      ไม่แน่ใจให้บังคับด้วย sqlcmd -f 65001

   ก่อนรัน
   ---------------------------------------------------------------------------
     1. ฝั่ง InventoryNarai ต้องรัน docs/schema-hr-branch.sql และ
        docs/migrate-branch-hub.sql ของโปรเจค naraipizzeria ให้เสร็จก่อน
     2. รันช่วงนอกเวลาขาย — ระหว่างสลับ ตารางงานจะอ่านรายชื่อสาขาไม่ได้ชั่วขณะ
     3. รันด้วย sa หรือ login ที่มีสิทธิ์ ALTER/CREATE VIEW (narai_web ไม่มีสิทธิ์นี้ โดยตั้งใจ)

   วิธีรัน:
     sqlcmd -f 65001 -S localhost -E -i docs\branch-hub-view.sql

   ถอยกลับ: ดูหัวข้อ "ถอยกลับ" ท้ายไฟล์ — ตารางเดิมไม่ได้ถูกลบ แค่เปลี่ยนชื่อ
============================================================================ */

USE narai_hr;
GO

SET ANSI_NULLS ON;
GO
SET QUOTED_IDENTIFIER ON;
GO

/* ===================== ขั้นที่ 1: ตรวจว่าทะเบียนแม่พร้อมแล้วจริง =====================
   ยังไม่พร้อมแล้วรันต่อ = ได้ view ที่ query แล้วพัง ซึ่งแปลว่าหน้าลงตารางงาน
   ของทุกสาขาใช้ไม่ได้ทันที หยุดตรงนี้ดีกว่า                                   */
IF DB_ID(N'InventoryNarai') IS NULL
BEGIN
    RAISERROR(N'ไม่พบฐาน InventoryNarai บนอินสแตนซ์นี้ — ต้องรันที่เครื่องออฟฟิศเท่านั้น', 16, 1);
    SET NOEXEC ON;
END
GO

IF OBJECT_ID(N'InventoryNarai.dbo.hr_branch', N'U') IS NULL
BEGIN
    RAISERROR(N'ยังไม่มี InventoryNarai.dbo.hr_branch — รัน naraipizzeria/docs/schema-hr-branch.sql ก่อน', 16, 1);
    SET NOEXEC ON;
END
GO

IF OBJECT_ID(N'InventoryNarai.dbo.hr_branch_target', N'U') IS NULL
BEGIN
    RAISERROR(N'ยังไม่มี InventoryNarai.dbo.hr_branch_target — รัน naraipizzeria/docs/schema-hr-branch.sql รอบใหม่ก่อน', 16, 1);
    SET NOEXEC ON;
END
GO

/* ===================== ขั้นที่ 2: เก็บตารางเดิมไว้ ไม่ลบ =====================
   เปลี่ยนชื่อเฉย ๆ — ข้อมูลเป้ายอดที่กรอกไว้ยังอยู่ครบ ใช้ถอยกลับได้ทันทีถ้ามีปัญหา
   (ขั้นที่ 3 ของ migrate-branch-hub.sql คัดค่าเป้าจากตารางนี้ไปทะเบียนแม่แล้ว
    ถ้ายังไม่ได้รันขั้นนั้น ให้กลับไปรันก่อน ไม่งั้นเป้าทุกสาขาจะกลายเป็นศูนย์)

   สิทธิ์ที่เคย GRANT ไว้บนตารางจะติดตามชื่อใหม่ไปด้วย view ที่สร้างใหม่จึงยังไม่มีสิทธิ์
   — ขั้นที่ 4 ให้สิทธิ์ใหม่                                                        */
IF OBJECT_ID(N'dbo.hr_branch', N'U') IS NOT NULL
   AND OBJECT_ID(N'dbo.hr_branch_legacy', N'U') IS NULL
BEGIN
    EXEC sys.sp_rename N'dbo.hr_branch', N'hr_branch_legacy';
    PRINT N'ขั้นที่ 2: เปลี่ยนชื่อตารางเดิมเป็น dbo.hr_branch_legacy แล้ว (ไม่ได้ลบ)';
END
ELSE IF OBJECT_ID(N'dbo.hr_branch', N'V') IS NOT NULL
    PRINT N'ขั้นที่ 2: ข้าม — dbo.hr_branch เป็น view อยู่แล้ว';
ELSE
    PRINT N'ขั้นที่ 2: ข้าม — ไม่พบตารางเดิม หรือเปลี่ยนชื่อไปแล้ว';
GO

/* ===================== ขั้นที่ 3: สร้าง view ชื่อเดิม =====================
   ชื่อและชนิดของทุกคอลัมน์ต้องตรงกับตารางเดิมเป๊ะ เพราะ office-server/schedule.js
   SELECT ชื่อคอลัมน์ตรง ๆ (branch, branch_name, outlet_id, is_active,
   daily_target, monthly_target, max_wage)

   ⚠️ LOWER() ไม่ใช่ของประดับ — ทะเบียนแม่เก็บรหัสเป็นตัวพิมพ์ใหญ่ (SJP) ส่วนฐานนี้
      เก็บตัวพิมพ์เล็กมาตลอด (sjp) และ branchScope() ใน schedule.js ประกอบเงื่อนไข
      branch IN (@brg0, ...) ด้วยค่าตัวพิมพ์เล็กจาก branchGroup()
      collation ของเครื่องนี้เป็นแบบไม่สนตัวพิมพ์อยู่แล้วก็จริง แต่ผูกความถูกต้อง
      ไว้กับ collation คือรอวันที่ใครย้ายฐานไปเครื่องที่ตั้งไว้คนละแบบแล้วพังเงียบ ๆ  */
IF OBJECT_ID(N'dbo.hr_branch', N'V') IS NOT NULL
    DROP VIEW dbo.hr_branch;
GO

/* ใช้ DROP + CREATE ไม่ใช่ CREATE OR ALTER เพราะ CREATE OR ALTER มีตั้งแต่
   SQL Server 2016 SP1 ขึ้นไป และยังไม่ได้ยืนยันว่า SQLEXPRESS เครื่องนี้เวอร์ชันไหน
   แบบนี้รันได้ทุกเวอร์ชัน · CREATE VIEW ต้องเป็นคำสั่งแรกของ batch จึงต้องมี GO คั่น

   ถ้าขั้นนี้ขึ้นว่า "There is already an object named 'hr_branch'" แปลว่าขั้นที่ 2
   ยังไม่ได้เปลี่ยนชื่อตารางเดิม — กลับไปอ่าน PRINT ของขั้นนั้นก่อน อย่าลบตารางทิ้ง */
CREATE VIEW dbo.hr_branch AS
SELECT  LOWER(b.branch_code)                          AS branch,
        NULLIF(b.branch_name, N'')                    AS branch_name,
        b.outlet_id,
        ISNULL(t.daily_target,   0)                   AS daily_target,
        ISNULL(t.monthly_target, 0)                   AS monthly_target,
        ISNULL(t.max_wage,       0)                   AS max_wage,
        CASE WHEN b.status = N'ใช้งาน' THEN CAST(1 AS BIT) ELSE CAST(0 AS BIT) END AS is_active,
        b.updated_at
FROM        InventoryNarai.dbo.hr_branch        AS b
LEFT JOIN   InventoryNarai.dbo.hr_branch_target AS t
       ON   t.branch_code = b.branch_code;
GO

PRINT N'ขั้นที่ 3: สร้าง view dbo.hr_branch เรียบร้อย';
GO

/* ===================== ขั้นที่ 4: สิทธิ์ =====================
   สองอย่าง และต้องครบทั้งคู่:
     ก) SELECT บนตัว view เอง (ของใหม่ ยังไม่มีสิทธิ์ติดมา)
     ข) SELECT บนตารางต้นทางในอีกฐาน — cross-database ownership chaining ปิดอยู่
        ตามค่าเริ่มต้น สิทธิ์บน view จึงไม่ไหลข้ามฐานไปให้เอง

   ⚠️ ข้อ ข) คือข้อที่พลาดกันบ่อย: view สร้างผ่าน สิทธิ์ view ก็ให้แล้ว แต่พอแอปจริง
      query จะได้ "The SELECT permission was denied on object 'hr_branch'" ทั้งที่
      ทดสอบด้วย sa แล้วผ่าน — เพราะ sa มีสิทธิ์ทุกฐานอยู่แล้ว
      ทดสอบด้วย login จริงของแอปเสมอ (ดูคำสั่งท้ายไฟล์)                            */
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
    GRANT SELECT ON dbo.hr_branch TO narai_web;
ELSE
    PRINT N'ขั้นที่ 4: ข้าม view grant — ไม่พบ user narai_web ในฐานนี้ (รัน docs/create-app-login.sql ก่อน)';
GO

USE InventoryNarai;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
   AND EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'narai_web')
    CREATE USER narai_web FOR LOGIN narai_web;
GO

/* ให้เท่าที่ view ต้องใช้จริง: อ่านสองตารางนี้เท่านั้น ไม่ใช่ db_datareader ทั้งฐาน
   (ฐาน InventoryNarai มีข้อมูลต้นทุน/สต๊อกทั้งบริษัทอยู่ ระบบตารางงานไม่ต้องเห็น) */
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
BEGIN
    GRANT SELECT ON dbo.hr_branch        TO narai_web;
    GRANT SELECT ON dbo.hr_branch_target TO narai_web;
    PRINT N'ขั้นที่ 4: ให้สิทธิ์อ่านข้ามฐานแก่ narai_web เรียบร้อย';
END
ELSE
    PRINT N'ขั้นที่ 4: ข้าม cross-db grant — ไม่พบ login narai_web บนอินสแตนซ์นี้';
GO

USE narai_hr;
GO

/* ============================ ตรวจผลหลังรัน ============================
   1) view อ่านได้ และรหัสสาขาเป็นตัวพิมพ์เล็กเหมือนเดิม
        SELECT * FROM dbo.hr_branch ORDER BY branch;

   2) เป้ายอดตามมาครบ (เทียบกับตารางเดิมที่เก็บไว้)
        SELECT l.branch, l.daily_target AS เดิม, v.daily_target AS ใหม่
          FROM dbo.hr_branch_legacy l
          LEFT JOIN dbo.hr_branch v ON v.branch = LOWER(l.branch)
         WHERE l.daily_target <> ISNULL(v.daily_target, 0);
      -- ต้องได้ 0 แถว ถ้ามีแถวออกมาแปลว่าขั้นที่ 3 ของ migrate-branch-hub.sql ยังไม่ได้รัน

   3) ⭐ สำคัญที่สุด — ทดสอบด้วย login จริงของแอป ไม่ใช่ sa
        EXECUTE AS USER = N'narai_web';
        SELECT TOP 5 branch, branch_name, is_active FROM dbo.hr_branch;
        REVERT;
      -- ขึ้น "The SELECT permission was denied" = ขั้นที่ 4 ยังไม่ครบ

   4) เปิดหน้าลงตารางงานของสาขาใดสาขาหนึ่ง ดูว่ารายชื่อสาขาและการ์ดเป้ายอดขึ้นครบ
============================================================================ */

/* ================================ ถอยกลับ ================================
   ตารางเดิมยังอยู่ครบ ไม่ได้ลบ ถอยได้ในไม่ถึงนาที:

     USE narai_hr;
     DROP VIEW dbo.hr_branch;
     EXEC sys.sp_rename N'dbo.hr_branch_legacy', N'hr_branch';

   สิทธิ์เดิมติดตามตารางกลับมาเอง (ย้ายไปกับการเปลี่ยนชื่อตั้งแต่ขั้นที่ 2)
   ไม่ต้อง GRANT ใหม่

   ⚠️ ระหว่างที่ใช้ view อยู่ ถ้ามีคนไปแก้เป้ายอดที่หน้าเว็บ ค่านั้นอยู่ในทะเบียนแม่
      ไม่ได้อยู่ในตารางเดิม — ถอยกลับแล้วจะกลับไปเห็นค่าเก่า ณ วันที่สลับ
============================================================================ */

SET NOEXEC OFF;
GO

PRINT N'ระบบตารางงานอ่านทะเบียนสาขาจากทะเบียนแม่แล้ว';
GO
