/* ============================================================================
   หน้ารายชื่อพนักงาน: สัญชาติ + เอกสารพนักงานต่างชาติ (ดู office-server/employee-doc.js)

   dbo.employee_doc  1 แถว = พนักงาน 1 คน
     เก็บว่าเป็นคนไทยหรือต่างชาติ และเอกสารที่มีวันหมดอายุ (พาสปอร์ต วีซ่า ใบอนุญาตทำงาน
     รายงานตัว 90 วัน บัตรชมพู ปกค.) หน้าเว็บใช้วันหมดอายุพวกนี้แจ้งเตือนล่วงหน้า 120 วัน

   พนักงานที่ไม่มีแถวในตารางนี้ = คนไทย (ค่าเริ่มต้น) ไม่ต้องกรอกอะไรให้คนไทยทีละคน

   hr_code ว่างได้: แถวที่นำเข้าจาก Excel แล้วยังหาพนักงานในระบบไม่เจอ (ชื่อสะกดไม่ตรง)
   จะค้างอยู่แบบไม่มี hr_code ให้สาขากด "ผูกกับพนักงาน" เองในหน้าเว็บ — ไม่ทิ้งข้อมูลเอกสารของใคร

   วันที่ทุกช่องเป็น ค.ศ. (หน้าเว็บ/ตัวนำเข้าแปลง พ.ศ. ให้ก่อนส่งมา)

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.employee_doc', N'U') IS NULL
CREATE TABLE dbo.employee_doc (
    doc_id          INT IDENTITY(1,1) NOT NULL,
    branch          NVARCHAR(50)   NOT NULL,      -- รหัสสาขา (ตัวพิมพ์เล็ก)
    hr_code         NVARCHAR(30)   NULL,          -- ว่าง = ยังไม่ได้ผูกกับพนักงานในระบบ
    full_name       NVARCHAR(150)  NOT NULL,      -- ชื่อตามเอกสาร (จาก Excel หรือชื่อในระบบตอนบันทึก)
    prefix          NVARCHAR(20)   NULL,          -- นาย / นส.
    nat_type        NVARCHAR(10)   NOT NULL
                    CONSTRAINT DF_employee_doc_nat_type DEFAULT (N'foreign'),  -- thai / foreign
    country         NVARCHAR(50)   NULL,          -- พม่า / ลาว / เขมร / ...
    phone           NVARCHAR(50)   NULL,
    email           NVARCHAR(150)  NULL,
    sso_no          NVARCHAR(50)   NULL,          -- เลขประกันสังคม
    bank_account    NVARCHAR(50)   NULL,
    passport_no     NVARCHAR(50)   NULL,
    passport_expiry DATE           NULL,
    visa_expiry     DATE           NULL,
    mou             NVARCHAR(50)   NULL,
    wp_id_no        NVARCHAR(50)   NULL,          -- ใบอนุญาตทำงาน: เลขประจำตัว
    wp_permit_no    NVARCHAR(50)   NULL,          -- ใบอนุญาตทำงาน: เลขที่ใบอนุญาต
    wp_expiry       DATE           NULL,          -- มติแรงงาน หมดอายุ
    report90_date   DATE           NULL,          -- รายงานตัว 90 วัน ครบกำหนด
    pink_no         NVARCHAR(50)   NULL,          -- บัตรชมพู เลขที่
    pink_expiry     DATE           NULL,
    pkk_expiry      DATE           NULL,          -- ปกค. หมดอายุ
    missing_docs    NVARCHAR(500)  NULL,          -- ขาดเอกสาร / หมายเหตุ
    updated_by      NVARCHAR(255)  NULL,
    updated_at      DATETIME2(0)   NOT NULL
                    CONSTRAINT DF_employee_doc_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_employee_doc PRIMARY KEY CLUSTERED (doc_id)
);
GO

/* พนักงานหนึ่งคนมีได้แถวเดียว (แถวที่ยังไม่ผูก hr_code มีได้หลายแถว) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_employee_doc_hr_code'
                 AND object_id = OBJECT_ID(N'dbo.employee_doc'))
CREATE UNIQUE INDEX UX_employee_doc_hr_code
    ON dbo.employee_doc (hr_code) WHERE hr_code IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_employee_doc_branch'
                 AND object_id = OBJECT_ID(N'dbo.employee_doc'))
CREATE INDEX IX_employee_doc_branch ON dbo.employee_doc (branch);
GO
