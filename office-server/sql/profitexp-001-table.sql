/* ============================================================================
   ค่าใช้จ่ายอื่น ๆ ในตาราง "สรุปกำไร / ขาดทุน" บนหน้า Dashboard
   (Petty Cash, ค่าเช่าพื้นที่, ค่าน้ำ, ค่าไฟ, ค่าน้ำแข็ง, ค่าโทรศัพท์, ค่าแก๊ส, ค่าประกันภัย
    + ยอดขาย Member / Delivery ฝั่งรายรับ)

   เดิมช่องพวกนี้ไม่ได้บันทึกที่ไหนเลย รีเฟรชหน้าหรือออกจากเมนูแล้วตัวเลขหายหมด
   ตอนนี้เก็บ "ต่อเดือน ต่อสาขา" — หนึ่งแถว = (เดือน + สาขา + รายการ)

   branch เก็บรหัสหลักของกลุ่มสาขา (branchGroup()[0] ใน hr-session.js เช่น zjp/sjp -> zjp)
   คนสาขากับออฟฟิศที่เลือกรหัสพี่น้องจะเห็นและแก้ชุดเดียวกัน ไม่แตกเป็นสองกอง

   เขียน/อ่านจาก office-server/profitexpense.js (saveProfitExpenses / getProfitExpenses)
   ข้อมูลเก่าจาก Google Sheet: node scripts/import-profit-expense.mjs --url=<ลิงก์แท็บ> (source = 'sheet')

   รันผ่าน update-office-server.bat รันซ้ำได้ ไม่มีข้อมูลหาย
============================================================================ */

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID(N'dbo.profit_expense', N'U') IS NULL
CREATE TABLE dbo.profit_expense (
    exp_id        INT IDENTITY(1,1) NOT NULL,
    exp_month     CHAR(7)        NOT NULL,   -- 'YYYY-MM' (ค.ศ.)
    branch        NVARCHAR(50)   NOT NULL,   -- รหัสหลักของกลุ่มสาขา ตัวพิมพ์เล็ก
    item_key      NVARCHAR(30)   NOT NULL,   -- petty | rent | water | power | ice | phone | gas | insurance | member | delivery
    amount        DECIMAL(18,2)  NOT NULL CONSTRAINT DF_profit_expense_amount DEFAULT (0),
    created_at    DATETIME2(0)   NOT NULL CONSTRAINT DF_profit_expense_created DEFAULT (SYSDATETIME()),
    created_by    NVARCHAR(255)  NULL,
    updated_at    DATETIME2(0)   NULL,
    updated_by    NVARCHAR(255)  NULL,
    source        NVARCHAR(20)   NOT NULL CONSTRAINT DF_profit_expense_source DEFAULT (N'web'), -- web | sheet
    CONSTRAINT PK_profit_expense PRIMARY KEY (exp_id),
    CONSTRAINT UQ_profit_expense UNIQUE (exp_month, branch, item_key)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_profit_expense_branch_month'
                AND object_id = OBJECT_ID(N'dbo.profit_expense'))
    CREATE INDEX IX_profit_expense_branch_month ON dbo.profit_expense (branch, exp_month)
        INCLUDE (item_key, amount);
GO
