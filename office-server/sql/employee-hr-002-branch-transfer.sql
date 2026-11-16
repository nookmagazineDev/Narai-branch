/* ============================================================================
   พนักงาน: ย้ายสาขา (ดู office-server/branch-transfer.js)

   dbo.hr_branch_transfer   1 แถว = การย้ายสาขา 1 ครั้งของพนักงาน 1 คน
     ออฟฟิศตั้งย้ายจากหน้า HR → รายชื่อพนักงาน (ปุ่มแก้ไข เลือกสาขาใหม่ + วันที่มีผล)
     status  pending   ยังไม่ถึงวันที่มีผล — office-server ย้ายให้เองเมื่อถึงวัน (เช็คทุก 30 นาที)
             done      ย้ายแล้ว (applied_at = เวลาที่ย้ายจริง)
             cancelled ยกเลิกก่อนถึงวัน
     พนักงานหนึ่งคนมีรายการ pending ได้ครั้งละ 1 รายการ

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.hr_branch_transfer', N'U') IS NULL
CREATE TABLE dbo.hr_branch_transfer (
    transfer_id     INT IDENTITY(1,1) NOT NULL,
    hr_code         NVARCHAR(30)   NOT NULL,
    full_name       NVARCHAR(150)  NULL,         -- ชื่อ ณ วันที่ตั้งย้าย
    from_branch     NVARCHAR(50)   NOT NULL,
    to_branch       NVARCHAR(50)   NOT NULL,
    effective_date  DATE           NOT NULL,
    reason          NVARCHAR(500)  NULL,
    status          NVARCHAR(10)   NOT NULL
                    CONSTRAINT DF_hr_branch_transfer_status DEFAULT (N'pending'),
    requested_by    NVARCHAR(255)  NULL,
    requested_at    DATETIME2(0)   NOT NULL
                    CONSTRAINT DF_hr_branch_transfer_requested_at DEFAULT (SYSDATETIME()),
    applied_at      DATETIME2(0)   NULL,
    cancelled_by    NVARCHAR(255)  NULL,
    cancelled_at    DATETIME2(0)   NULL,
    CONSTRAINT PK_hr_branch_transfer PRIMARY KEY CLUSTERED (transfer_id)
);
GO

/* รายการรอย้ายต่อคนมีได้ครั้งละหนึ่ง — กันกดซ้ำ/สองเครื่องตั้งพร้อมกัน */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_hr_branch_transfer_pending'
                 AND object_id = OBJECT_ID(N'dbo.hr_branch_transfer'))
CREATE UNIQUE INDEX UX_hr_branch_transfer_pending
    ON dbo.hr_branch_transfer (hr_code) WHERE status = N'pending';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_hr_branch_transfer_effective'
                 AND object_id = OBJECT_ID(N'dbo.hr_branch_transfer'))
CREATE INDEX IX_hr_branch_transfer_effective
    ON dbo.hr_branch_transfer (status, effective_date) INCLUDE (hr_code, to_branch);
GO
