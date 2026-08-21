USE narai_hr;
GO

IF OBJECT_ID(N'dbo.hr_user', N'U') IS NULL
CREATE TABLE dbo.hr_user (
    username      NVARCHAR(100) NOT NULL,
    password_hash NVARCHAR(255) NOT NULL,
    branch        NVARCHAR(50)  NOT NULL,
    outlet_id     NVARCHAR(50)  NULL,
    display_name  NVARCHAR(150) NULL,
    is_active     BIT           NOT NULL CONSTRAINT DF_hr_user_is_active DEFAULT (1),
    last_login_at DATETIME2(0)  NULL,
    created_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_created_at DEFAULT (SYSDATETIME()),
    updated_at    DATETIME2(0)  NOT NULL CONSTRAINT DF_hr_user_updated_at DEFAULT (SYSDATETIME()),
    CONSTRAINT PK_hr_user PRIMARY KEY (username)
);
GO

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'narai_web')
    GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.hr_user TO narai_web;
GO

SELECT COUNT(*) AS users_migrated FROM dbo.hr_user;
GO
