// --- ตั้งค่า ID ของ Spreadsheet ข้อมูลยอดขาย/เป้าหมาย ---
var SALES_DATA_SPREADSHEET_ID = '1kxVqX_hp5B0YTNSPj7mhyFl1OLbnhN-dIWm9ywzHA60';

// --- Helper: เปรียบเทียบวันที่อย่างปลอดภัย ---
function isSameDate(date1, date2) {
  if (!date1 || !date2) return false;
  var d1 = new Date(date1);
  var d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  d1.setHours(0, 0, 0, 0);
  d2.setHours(0, 0, 0, 0);
  return d1.getTime() === d2.getTime();
}

function setupPermissions() {
  // บังคับให้ Google รู้ว่าเราต้องการสิทธิ์ "เขียน" ไฟล์ลง Drive
  var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
  var testFile = folder.createFile("test_permission.txt", "OK");
  testFile.setTrashed(true); // สร้างเสร็จแล้วสั่งลบทิ้งทันที จะได้ไม่รก
}

function doPost(e) {
  var response = {
    status: 'error',
    message: 'Unknown error'
  };

  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    var ss = SpreadsheetApp.openById("1Abot2hKLUO6_z8NRW6c9A0m0ggra3ZE7Yq10kcUPr7Y");

    if (action === 'login') {
      var sheet = ss.getSheetByName('User');
      if (!sheet) {
        throw new Error("Sheet 'User' not found.");
      }

      var username = data.username;
      var password = data.password;

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();

      // Skip header row if exists, but we'll just search all
      var loggedIn = false;
      var branch = "";
      var outletId = "";

      for (var i = 0; i < values.length; i++) {
        // Col A = 0, Col B = 1, Col C = 2, Col D = 3
        if (values[i][0] == username && values[i][1] == password) {
          loggedIn = true;
          branch = values[i][2]; // สาขา
          outletId = values[i][3]; // Outlet ID
          break;
        }
      }

      if (loggedIn) {
        response.status = 'success';
        response.data = {
          username: username,
          branch: branch,
          outletId: outletId
        };
      } else {
        response.status = 'error';
        response.message = 'Invalid credentials';
      }

    } else if (action === 'addEmployee') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) {
        sheet = ss.insertSheet('DATA');
      }

      // Check for duplicate HR Code in DATA sheet (Column C = 3)
      var hrCodeToCheck = data.hrCode;
      if (hrCodeToCheck) {
        var lastRow = sheet.getLastRow();
        if (lastRow > 0) {
          var hrValues = sheet.getRange(1, 3, lastRow).getValues();
          for (var r = 0; r < hrValues.length; r++) {
            if (hrValues[r][0] == hrCodeToCheck) {
              throw new Error("รหัส HR นี้มีอยู่ในระบบแล้ว (ซ้ำ) กรุณาตรวจสอบและใช้รหัสอื่น");
            }
          }
        }
      }
      var sheet2 = ss.getSheetByName('พนักงานเข้า');
      if (!sheet2) {
        sheet2 = ss.insertSheet('พนักงานเข้า');
        var headers = [
          "Timestamp", "ผู้บันทึก", "รหัส HR", "ชื่อ - สกุล", "สังกัด", 
          "ประเภท", "ตำแหน่ง", "เลขประจำตัวประชาชน", "ที่อยู่", "วันเกิด",
          "เบอร์โทร", "ID LINE", "LOGA", "สัญชาติ", "เอกสารที่มี", 
          "ลิงก์ไฟล์แนบ", "วันที่เริ่มงาน"
        ];
        sheet2.appendRow(headers);
        // Make headers bold
        sheet2.getRange("A1:Q1").setFontWeight("bold");
      }

      var row = new Array(75);
      for (var i = 0; i < 75; i++) {
        row[i] = "";
      }

      var now = new Date();
      var formattedDate = Utilities.formatDate(now, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss");

      // Mapping:
      // C (index 2): รหัส HR
      // D (index 3): ชื่อ - สกุล
      // E (index 4): สังกัด
      // F (index 5): ประเภท
      // I (index 8): ตำแหน่ง
      // M (index 12): เลขประจำตัวประชาชน
      // Q (index 16): ที่อยู่
      // S (index 18): วันเกิด
      // BP (index 67): เบอร์โทร
      // BQ (index 68): IDLINE
      // BR (index 69): LOGA

      row[2] = data.hrCode || "";
      row[3] = data.fullName || "";
      row[4] = data.department || "";
      row[5] = data.type || "";
      row[6] = "ทำงาน";            // คอลัมน์ G (สถานะ) — พนักงานใหม่ตั้งเป็น "ทำงาน"
      row[8] = data.position || "";
      row[12] = data.idCard || "";
      row[16] = data.address || "";
      row[18] = data.birthday || "";
      row[67] = data.phone || "";
      row[68] = data.lineId || "";
      row[69] = data.loga || "";

      row[70] = data.nationality || "";
      var docList = [];
      if (data.documents) {
        data.documents.forEach(function(doc) {
          var exp = (data.documentExpiry && data.documentExpiry[doc]) ? data.documentExpiry[doc] : "";
          if (exp) {
            if (doc === 'สมุดบัญชีธนาคาร') {
              docList.push(doc + " (บัญชี: " + exp + ")");
            } else {
              docList.push(doc + " (หมดอายุ: " + exp + ")");
            }
          } else {
            docList.push(doc);
          }
        });
      }
      row[71] = docList.join(", ");
      
      var fileUrls = [];
      if (data.files && data.files.length > 0) {
        try {
          var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
          for (var f = 0; f < data.files.length; f++) {
            var fileObj = data.files[f];
            // Remove data URI prefix if present
            var base64Data = fileObj.base64.split(',')[1] || fileObj.base64;
            var decoded = Utilities.base64Decode(base64Data);
            var blob = Utilities.newBlob(decoded, fileObj.mimeType, fileObj.name);
            var driveFile = folder.createFile(blob);
            // Optional: set sharing permission so anyone with link can view
            driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            fileUrls.push(driveFile.getUrl());
          }
        } catch (e) {
          // If file upload fails, we log it in the URL column
          fileUrls.push("Error uploading files: " + e.message);
        }
      }
      row[72] = fileUrls.join(", ");
      row[73] = data.startDate || "";

      var row2 = [
        formattedDate,
        data.recorder || "Unknown",
        data.hrCode || "",
        data.fullName || "",
        data.department || "",
        data.type || "",
        data.position || "",
        data.idCard || "",
        data.address || "",
        data.birthday || "",
        data.phone || "",
        data.lineId || "",
        data.loga || "",
        data.nationality || "",
        docList.join(", "),
        fileUrls.join(", "),
        data.startDate || ""
      ];

      sheet.appendRow(row);
      sheet2.appendRow(row2);

      response.status = 'success';
      response.message = 'Employee added successfully';
    } else if (action === 'getEmployees') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) {
        response.status = 'success';
        response.data = [];
        return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
      }

      var dataRange = sheet.getDataRange();
      var values = dataRange.getValues();
      var employees = [];
      var requestBranch = data.branch || '';

      // Skip header row
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[2]) continue; // Skip completely empty rows
        
        var empBranch = row[4] ? row[4].toString().toLowerCase() : ''; // คอลัมน์ E (สาขา)
        var reqBranch = requestBranch.toLowerCase();
        var isMatch = false;
        
        if (reqBranch === 'all') {
          isMatch = true;
        } else {
          if (empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1) {
            isMatch = true;
          }
        }

        if (isMatch) {
          employees.push({
            hrCode: row[2] || '',       // คอลัมน์ C
            fullName: row[3] || '',     // คอลัมน์ D
            branch: row[4] || '',       // คอลัมน์ E (สาขา)
            type: row[5] || '',         // คอลัมน์ F (ประเภท)
            status: row[6] || '',       // คอลัมน์ G (การทำงาน)
            startDate: row[7] || '',    // คอลัมน์ H (วันเริ่มงาน)
            position: row[8] || '',     // คอลัมน์ I (ตำแหน่ง)
            loga: row[69] || '',        // คอลัมน์ BR (เลขที่ LOGA)
            newCode: row[70] || '',     // คอลัมน์ BS (รหัสใหม่ / ใช้ตั้งชื่อไฟล์รูป)
            photoFile: row[71] || '',   // คอลัมน์ BT (ชื่อไฟล์รูปเดิม)
            photoUrl: row[72] || ''     // คอลัมน์ BU (ลิงก์รูป)
          });
        }
      }

      response.status = 'success';
      response.data = employees;

    } else if (action === 'uploadEmployeePhoto') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      if (!hrCode) throw new Error('ไม่มีรหัสพนักงาน');
      if (!data.base64) throw new Error('ไม่มีไฟล์รูป');

      // หาแถวของพนักงานจากรหัส HR (คอลัมน์ C = index 2)
      var values = sheet.getDataRange().getValues();
      var rowIndex = -1;
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][2]).trim() == String(hrCode).trim()) { rowIndex = i + 1; break; }
      }
      if (rowIndex === -1) throw new Error('ไม่พบรหัสพนักงานนี้ในระบบ');

      // รหัสใหม่สำหรับตั้งชื่อไฟล์ = คอลัมน์ BS (index 70); ตัดนามสกุลไฟล์ที่อาจติดมาออก, ถ้าว่างใช้รหัส HR แทน
      var bsVal = String(values[rowIndex - 1][70] || '').trim();
      var newCode = bsVal.replace(/\.(jpg|jpeg|png|gif|webp)$/i, '').trim() || String(hrCode).trim();
      var ext = String(data.ext || (data.fileName ? data.fileName.split('.').pop() : '') || 'jpg').toLowerCase();
      var fileName = newCode + '.' + ext;

      var folder = DriveApp.getFolderById("1i-8K4E97vwcghQyT1yJ_TpFTt0irbZtR");
      // ลบไฟล์เก่าที่ชื่อขึ้นต้นด้วยรหัสใหม่ หรือรหัส HR เดิม (กันไฟล์ซ้ำ)
      var existing = folder.getFiles();
      while (existing.hasNext()) {
        var ef = existing.next();
        var en = ef.getName();
        if (en === fileName || en.indexOf(newCode + '.') === 0 || en.indexOf(String(hrCode) + '.') === 0) ef.setTrashed(true);
      }

      var base64Data = data.base64.split(',')[1] || data.base64;
      var decoded = Utilities.base64Decode(base64Data);
      var blob = Utilities.newBlob(decoded, data.mimeType || 'image/jpeg', fileName);
      var driveFile = folder.createFile(blob);
      driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      var url = driveFile.getUrl();

      // เก็บลิงก์รูปไว้ที่คอลัมน์ BU (คอลัมน์ที่ 73) สำหรับแสดงรูปบนหน้าจอ
      // ไม่เขียนทับคอลัมน์ BT (72) อีกต่อไป เพราะ BT = รหัสใหม่ที่ใช้ตั้งชื่อไฟล์
      sheet.getRange(rowIndex, 73).setValue(url);

      response.status = 'success';
      response.message = 'อัปโหลดรูปสำเร็จ';
      response.data = { url: url, fileName: fileName };

    } else if (action === 'resignEmployee') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      var values = sheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < values.length; i++) {
        if (values[i][2] == hrCode) {
          sheet.getRange(i + 1, 7).setValue('ลาออก'); // Column G is index 6, so column 7
          found = true;
          break;
        }
      }
      if (found) {
        response.status = 'success';
        response.message = 'แจ้งลาออกสำเร็จ';
      } else {
        response.status = 'error';
        response.message = 'ไม่พบรหัสพนักงานนี้';
      }

    } else if (action === 'updateEmployeeLoga') {
      // บันทึกเลขที่ LOGA กลับไปที่คอลัมน์ BR (column 70) ของแถวพนักงานนั้น
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var hrCode = data.hrCode;
      var values = sheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < values.length; i++) {
        if (values[i][2] == hrCode) {
          sheet.getRange(i + 1, 70).setValue(data.loga || ''); // column 70 = BR = LOGA
          found = true;
          break;
        }
      }
      if (found) {
        response.status = 'success';
        response.message = 'บันทึกเลขที่ LOGA เรียบร้อย';
      } else {
        response.status = 'error';
        response.message = 'ไม่พบรหัสพนักงานนี้';
      }

    } else if (action === 'getScheduleEmployees') {
      var sheet = ss.getSheetByName('DATA');
      if (!sheet) throw new Error('Sheet DATA not found');
      var values = sheet.getDataRange().getValues();
      var reqBranch = (data.branch || '').toLowerCase();
      var employees = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[2]) continue;
        var empBranch = row[4] ? row[4].toString().toLowerCase() : '';
        var isMatch = reqBranch === 'all' || empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1;
        if (isMatch && row[6] === 'ทำงาน') {
          employees.push({
            hrCode: row[2] || '',
            name: row[3] || '',
            branch: row[4] || '',
            type: row[5] || '',
            status: row[6] || '',
            position: row[8] || '',
            dailyWage: row[9] || ''
          });
        }
      }
      // Simple sort by position
      const posPriority = { 'ผู้จัดการ':1, 'ผช.ผู้จัดการ':2, 'ซุปเปอร์ไวเซอร์':3, 'แคชเชียร์':4, 'บริการ':5, 'กุ๊ก':6, 'ล้างจาน':7 };
      employees.sort((a,b) => (posPriority[a.position]||99) - (posPriority[b.position]||99));
      response.status = 'success';
      response.data = employees;
    } else if (action === 'saveTimesheet') {
      var destSs = SpreadsheetApp.openById('1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U');
      var sheet = destSs.getSheetByName('ลงตารางงาน');
      if (!sheet) {
        sheet = destSs.insertSheet('ลงตารางงาน');
        sheet.appendRow([
          'Timestamp', 'วันที่ลงงาน', 'สาขา', 'รหัส HR', 'ชื่อ-สกุล', 'ตำแหน่ง', 
          'เวลาเข้า', 'เวลาออก', 'เวลาเบรค', 'OT (ชม.)', 'ค่าแรง (บาท)', 'สถานะ', 
          'ลา/หมายเหตุ (รับค่าแรง)', 'ประเภท', 'หยุดไม่รับค่าแรง', 'ชั่วโมงสะสม',
          'ลารายชั่วโมง (ชม.)', 'หมายเหตุเพิ่มเติม', 'ช่วงเวลาเบรค', 'จุดปฏิบัติงาน', 'ผู้อนุมัติ OT', 'ใช้ชั่วโมงสะสม'
        ]);
      }
      var logs = data.logs || [];
      var timestamp = new Date();
      logs.forEach(function(item) {
        sheet.appendRow([
          timestamp, item.workDate, item.branch, item.hrCode, item.name, item.position,
          item.checkIn || '', item.checkOut || '', item.breakTime || '', item.ot || '', item.wage || '',
          item.status || '', item.leaveNote || '', item.empType || '', item.unpaidLeave || '',
          item.otAccumulated || '', item.hourlyLeave || '', item.otherNote || item.note || '',
          item.breakTimeRange || '', item.workStation || '', '', item.useAccumulatedHours || ''
        ]);
      });
      response.status = 'success';
      response.message = 'บันทึกสำเร็จ';
    } else if (action === 'getHistoryData') {
      var destSs = SpreadsheetApp.openById('1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U');
      var sheet = destSs.getSheetByName('ลงตารางงาน');
      if (!sheet) {
        response.status = 'success'; 
        response.data = []; 
      } else {
        var values = sheet.getDataRange().getValues();
        var reqBranch = (data.branch || '').toLowerCase();
        var reqDate = data.date || '';
        var history = [];
        for (var i = 1; i < values.length; i++) {
          var row = values[i];
          var empBranch = row[2] ? row[2].toString().toLowerCase() : ''; // สาขา (Col C)
          var isMatchBranch = reqBranch === 'all' || empBranch.indexOf(reqBranch) !== -1 || reqBranch.indexOf(empBranch) !== -1;
          
          var rowDate = '';
          if (row[1] instanceof Date) { rowDate = Utilities.formatDate(row[1], Session.getScriptTimeZone(), 'yyyy-MM-dd'); } else { rowDate = String(row[1]); }
          
          var isMatchDate = true;
          if (data.startDate && data.endDate) {
            isMatchDate = (rowDate >= data.startDate && rowDate <= data.endDate);
          } else {
            isMatchDate = !reqDate || rowDate.indexOf(reqDate) !== -1;
          }
          
          if (isMatchBranch && isMatchDate) {
            var checkInVal = row[6];
            if (checkInVal instanceof Date) { checkInVal = Utilities.formatDate(checkInVal, "Asia/Bangkok", "HH:mm"); } else { checkInVal = String(checkInVal || ''); }
            
            var checkOutVal = row[7];
            if (checkOutVal instanceof Date) { checkOutVal = Utilities.formatDate(checkOutVal, "Asia/Bangkok", "HH:mm"); } else { checkOutVal = String(checkOutVal || ''); }

            history.push({
              timestamp: row[0],
              workDate: rowDate,
              branch: row[2],
              hrCode: row[3],
              name: row[4],
              position: row[5],
              checkIn: checkInVal,
              checkOut: checkOutVal,
              breakTime: row[8],
              ot: row[9],
              wage: row[10],
              status: row[11],
              leaveNote: row[12],
              empType: row[13],
              unpaidLeave: row[14],
              otAccumulated: row[15],
              hourlyLeave: row[16],
              otherNote: row[17],
              breakTimeRange: row[18],
              workStation: row[19],
              otApprover: row[20],
              useAccumulatedHours: row[21]
            });
          }
        }
        // ล่าสุดอยู่ล่างสุด ดังนั้นเวลาเรียงควรจะเอาอันล่าสุดก่อนไหม? แต่เดิม script ให้ sort by position.
        // Simple sort by position
        const posPriority = { 'ผู้จัดการ':1, 'ผช.ผู้จัดการ':2, 'ซุปเปอร์ไวเซอร์':3, 'แคชเชียร์':4, 'บริการ':5, 'กุ๊ก':6, 'ล้างจาน':7 };
        history.sort((a,b) => (posPriority[a.position]||99) - (posPriority[b.position]||99));
        response.status = 'success';
        response.data = history;
      }
    } else if (action === 'getBranches') {
      // ดึงรายชื่อสาขาจากชีท User (ชีทหลัก) คอลัมน์ C
      var userSheet = ss.getSheetByName('User');
      var branches = [];
      if (userSheet) {
        var uData = userSheet.getDataRange().getValues();
        var branchSet = {};
        for (var r = 0; r < uData.length; r++) {
          var br = uData[r][2]; // Column C = Branch
          var oId = uData[r][3]; // Column D = Outlet ID
          if (br && String(br).toLowerCase() !== 'all' && !branchSet[String(br).toLowerCase()]) {
            branchSet[String(br).toLowerCase()] = true;
            branches.push({ name: br, outletId: oId || '' });
          }
        }
      }
      response.status = 'success';
      // Sort by name
      response.data = branches.sort(function(a, b) {
        return a.name.localeCompare(b.name);
      });
    } else if (action === 'getStockItems') {
      var reqBranch = (data.branch || '').toLowerCase();
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      
      var balanceMap = {};
      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');
      
      // Helper function to normalize ID (remove leading zeros for safe matching)
      var normalizeId = function(id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };

      if (balanceSheet) {
        var balValues = balanceSheet.getDataRange().getValues();
        for (var b = 1; b < balValues.length; b++) {
          var bRow = balValues[b];
          var bProductId = normalizeId(bRow[0]);
          var bBranch = bRow[2] ? bRow[2].toString().toLowerCase() : '';
          var bBalance = bRow[3];
          var bDate = bRow[4];
          if (bProductId && bBranch === reqBranch) {
            balanceMap[bProductId] = {
              balance: bBalance,
              date: bDate instanceof Date ? Utilities.formatDate(bDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : bDate
            };
          }
        }
      }

      // Build lastStock map from ข้อมูลนับสตอค sheet — keep full history per product
      var lastStockMap = {};
      var previousStockMap = {}; // second-to-last = ยอดยกมา
      var stockHistoryMap = {}; // all entries sorted oldest-first
      var countSheetR = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (countSheetR && countSheetR.getLastRow() > 1) {
        var csValues = countSheetR.getDataRange().getValues();
        for (var cs = 1; cs < csValues.length; cs++) {
          var csRow = csValues[cs];
          var csBranch = csRow[2] ? csRow[2].toString().toLowerCase() : '';
          var csPid = normalizeId(csRow[3]);
          var csDate = csRow[0];
          var csRemaining = csRow[6];
          var csCounter = csRow[1];
          var csDateStr = csDate instanceof Date ? Utilities.formatDate(csDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : csDate;
          if (csPid && csBranch === reqBranch) {
            if (lastStockMap[csPid]) {
              previousStockMap[csPid] = lastStockMap[csPid];
            }
            lastStockMap[csPid] = {
              remaining: csRemaining,
              date: csDateStr,
              counter: csCounter
            };
            if (!stockHistoryMap[csPid]) stockHistoryMap[csPid] = [];
            stockHistoryMap[csPid].push({
              remaining: csRemaining,
              date: csDateStr,
              counter: csCounter
            });
          }
        }
      }
      
      // Build lastRequest map from ข้อมูลเบิก sheet (latest request per product per branch)
      var lastRequestMap = {};
      var reqSheetR = stockSs.getSheetByName('ข้อมูมูลเบิก');
      if (!reqSheetR) reqSheetR = stockSs.getSheetByName('ข้อมูลเบิก');
      if (reqSheetR && reqSheetR.getLastRow() > 1) {
        var rqValues = reqSheetR.getDataRange().getValues();
        // A=reqNo, B=date, C=productId, D=name, E=unit, F=qty, G=requestDate, H=requester, I=branch
        for (var rq = 1; rq < rqValues.length; rq++) {
          var rqRow = rqValues[rq];
          var rqPid = normalizeId(rqRow[2]);
          var rqBranch = rqRow[8] ? rqRow[8].toString().toLowerCase() : '';
          // Fallback: parse branch from reqNo prefix (e.g. CRM-2605-0001 -> crm)
          if (!rqBranch && rqRow[0]) {
            rqBranch = rqRow[0].toString().substring(0, 3).toLowerCase();
          }
          var rqQty = rqRow[5];
          var rqDate = rqRow[1];
          var rqRequester = rqRow[7];
          if (rqPid && rqBranch === reqBranch) {
            lastRequestMap[rqPid] = {
              qty: rqQty,
              date: rqDate instanceof Date ? Utilities.formatDate(rqDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : rqDate,
              requester: rqRequester
            };
          }
        }
      }
      
      var categoryMap = {};
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (categorySheet) {
        var catValues = categorySheet.getDataRange().getValues();
        for (var c = 1; c < catValues.length; c++) {
          var cRow = catValues[c];
          var cProductId = normalizeId(cRow[0]);
          var cBranch = cRow[2] ? cRow[2].toString().toLowerCase() : '';
          var cCategory = cRow[3];
          if (cProductId && cBranch === reqBranch) {
            categoryMap[cProductId] = cCategory;
          }
        }
      }

      var sheet = stockSs.getSheetByName('รายการสินค้า');
      if (!sheet) throw new Error('Sheet "รายการสินค้า" not found');
      var values = sheet.getDataRange().getValues();
      var items = [];
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[1]) continue;
        var pId = row[0] || '';
        var normId = normalizeId(pId);
        items.push({
          productId: pId,
          name: row[1] || '',
          unit: row[2] || '',
          storeCat: row[3] || '',
          storageCat: categoryMap[normId] !== undefined ? categoryMap[normId] : (row[4] || ''),
          rdCat: row[5] || '',
          previousBalance: previousStockMap[normId] ? previousStockMap[normId].remaining : (balanceMap[normId] ? balanceMap[normId].balance : ''),
          previousBalanceDate: previousStockMap[normId] ? previousStockMap[normId].date : (balanceMap[normId] ? balanceMap[normId].date : ''),
          lastStock: lastStockMap[normId] ? lastStockMap[normId].remaining : '',
          lastStockDate: lastStockMap[normId] ? lastStockMap[normId].date : '',
          lastStockCounter: lastStockMap[normId] ? lastStockMap[normId].counter : '',
          stockHistory: stockHistoryMap[normId] ? stockHistoryMap[normId] : [],
          lastRequest: lastRequestMap[normId] ? lastRequestMap[normId].qty : '',
          lastRequestDate: lastRequestMap[normId] ? lastRequestMap[normId].date : '',
          lastRequester: lastRequestMap[normId] ? lastRequestMap[normId].requester : ''
        });
      }
      response.status = 'success';
      response.data = items;
    } else if (action === 'getStockTotal') {
      var endDateStr = data.endDate || ''; 
      var endDateObj = null;
      if (endDateStr) {
        var parts = endDateStr.split('-');
        endDateObj = new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59);
      }
      
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      
      var normalizeId = function(id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };

      // 1. Read ยอดยกมา
      var balancesMap = {}; // { pid: { branch: { balance, date } } }
      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');
      if (balanceSheet) {
        var balValues = balanceSheet.getDataRange().getValues();
        for (var b = 1; b < balValues.length; b++) {
          var bRow = balValues[b];
          var bProductId = normalizeId(bRow[0]);
          var bBranch = bRow[2] ? bRow[2].toString().toLowerCase() : '';
          var bBalance = parseFloat(bRow[3]);
          var bDate = bRow[4];
          if (bProductId && bBranch && !isNaN(bBalance)) {
            if (!balancesMap[bProductId]) balancesMap[bProductId] = {};
            balancesMap[bProductId][bBranch] = {
              balance: bBalance,
              date: bDate instanceof Date ? bDate : null
            };
          }
        }
      }

      // 2. Read ข้อมูลนับสตอค and get the LATEST count <= endDate for each branch
      var latestCountMap = {}; // { pid: { branch: { remaining, date } } }
      var countSheetR = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (countSheetR && countSheetR.getLastRow() > 1) {
        var csValues = countSheetR.getDataRange().getValues();
        for (var cs = 1; cs < csValues.length; cs++) {
          var csRow = csValues[cs];
          var csDate = csRow[0];
          var csCounter = csRow[1];
          var csBranch = csRow[2] ? csRow[2].toString().toLowerCase() : '';
          var csPid = normalizeId(csRow[3]);
          var csRemaining = parseFloat(csRow[6]);
          
          if (csPid && csBranch && !isNaN(csRemaining)) {
            var rowDateObj = csDate instanceof Date ? csDate : new Date(csDate);
            // Check if within endDate
            if (!endDateObj || rowDateObj <= endDateObj) {
              if (!latestCountMap[csPid]) latestCountMap[csPid] = {};
              // Keep the latest date
              if (!latestCountMap[csPid][csBranch] || rowDateObj > latestCountMap[csPid][csBranch].dateObj) {
                latestCountMap[csPid][csBranch] = {
                  remaining: csRemaining,
                  dateObj: rowDateObj,
                  dateStr: Utilities.formatDate(rowDateObj, "Asia/Bangkok", "dd/MM/yyyy HH:mm")
                };
              }
            }
          }
        }
      }
      
      var categoryMap = {};
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (categorySheet) {
        var catValues = categorySheet.getDataRange().getValues();
        for (var c = 1; c < catValues.length; c++) {
          var cRow = catValues[c];
          var cProductId = normalizeId(cRow[0]);
          var cBranch = cRow[2] ? cRow[2].toString().toLowerCase() : '';
          var cCategory = cRow[3];
          if (cProductId && cBranch) {
            // we'll just take the first encountered category for "all" since it varies by branch
            if (!categoryMap[cProductId]) {
              categoryMap[cProductId] = cCategory;
            }
          }
        }
      }

      var sheet = stockSs.getSheetByName('รายการสินค้า');
      if (!sheet) throw new Error('Sheet "รายการสินค้า" not found');
      var values = sheet.getDataRange().getValues();
      var items = [];
      
      for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (!row[0] && !row[1]) continue;
        var pId = row[0] || '';
        var normId = normalizeId(pId);
        
        // Calculate Total Remaining
        var totalRemaining = 0;
        var branchesAccounted = {};
        var maxDateObj = null;
        var hasAnyStock = false;
        var branchDetails = [];

        // Add from latest count first
        if (latestCountMap[normId]) {
          for (var br in latestCountMap[normId]) {
            totalRemaining += latestCountMap[normId][br].remaining;
            branchesAccounted[br] = true;
            hasAnyStock = true;
            if (!maxDateObj || latestCountMap[normId][br].dateObj > maxDateObj) {
              maxDateObj = latestCountMap[normId][br].dateObj;
            }
            branchDetails.push({
              branch: br,
              remaining: latestCountMap[normId][br].remaining,
              date: latestCountMap[normId][br].dateStr,
              type: 'นับล่าสุด'
            });
          }
        }
        
        // Add from balances if no count exists for that branch
        if (balancesMap[normId]) {
          for (var br in balancesMap[normId]) {
            if (!branchesAccounted[br]) {
              totalRemaining += balancesMap[normId][br].balance;
              hasAnyStock = true;
              var bDateStr = '';
              if (balancesMap[normId][br].date) {
                if (!maxDateObj || balancesMap[normId][br].date > maxDateObj) {
                  maxDateObj = balancesMap[normId][br].date;
                }
                bDateStr = Utilities.formatDate(balancesMap[normId][br].date, "Asia/Bangkok", "dd/MM/yyyy HH:mm");
              }
              branchDetails.push({
                branch: br,
                remaining: balancesMap[normId][br].balance,
                date: bDateStr,
                type: 'ยอดยกมา'
              });
            }
          }
        }

        items.push({
          productId: pId,
          name: row[1] || '',
          unit: row[2] || '',
          storeCat: row[3] || '',
          storageCat: categoryMap[normId] !== undefined ? categoryMap[normId] : (row[4] || ''),
          rdCat: row[5] || '',
          totalRemaining: hasAnyStock ? Number(totalRemaining.toFixed(2)) : '',
          lastDate: maxDateObj ? Utilities.formatDate(maxDateObj, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : '',
          branchDetails: branchDetails
        });
      }
      response.status = 'success';
      response.data = items;
    } else if (action === 'saveStock') {
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      
      var countSheet = stockSs.getSheetByName('ข้อมูลนับสตอค');
      if (!countSheet) {
        countSheet = stockSs.insertSheet('ข้อมูลนับสตอค');
        countSheet.appendRow(['วันที่ลงข้อมูล', 'ชื่อพนักงานนับสต๊อก', 'สาขา', 'รหัสสินค้า', 'ชื่อสินค้า', 'หน่วย', 'จำนวนคงเหลือ']);
        countSheet.getRange("A1:G1").setFontWeight("bold");
      }
      
      var requestSheet = stockSs.getSheetByName('ข้อมูลเบิก');
      if (!requestSheet) {
        requestSheet = stockSs.insertSheet('ข้อมูลเบิก');
        requestSheet.appendRow(['เลขที่ใบเบิก', 'วันที่เวลาบันทึก', 'รหัส', 'ชื่อ', 'หน่วย', 'จำนวน', 'วันที่เบิก', 'ชื่อผู้เบิก', 'สาขา']);
        requestSheet.getRange("A1:I1").setFontWeight("bold");
      }
      
      var balanceSheet = stockSs.getSheetByName('ยอดยกมา');
      if (!balanceSheet) {
        balanceSheet = stockSs.insertSheet('ยอดยกมา');
        balanceSheet.appendRow(['รหัสสินค้า', 'ชื่อสินค้า', 'สาขา', 'ยอดยกมา', 'วันที่อัปเดต']);
        balanceSheet.getRange("A1:E1").setFontWeight("bold");
      }
      
      var items = data.items || [];
      var branch = data.branch || '';
      var username = data.username || 'Unknown';
      var counterName = data.counterName || username;
      var requestDate = data.requestDate || '';
      var requesterName = data.requesterName || '';
      var dateNow = new Date();
      var formattedDate = Utilities.formatDate(dateNow, "Asia/Bangkok", "dd/MM/yyyy HH:mm:ss");
      
      var normalizeId = function(id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };
      
      // Load current balances to update them
      var balValues = balanceSheet.getDataRange().getValues();
      var balRowMap = {};
      var reqBranch = branch.toLowerCase();
      for (var b = 1; b < balValues.length; b++) {
        var bId = normalizeId(balValues[b][0]);
        var bBranch = balValues[b][2] ? balValues[b][2].toString().toLowerCase() : '';
        if (bId && bBranch === reqBranch) {
          balRowMap[bId] = b + 1; // 1-based index
        }
      }
      
      // Filter requested items to check if we need a requisition number
      var reqItems = items.filter(function(i) { return i.requested > 0; });
      var reqNumber = "";
      
      if (reqItems.length > 0) {
        var yy = Utilities.formatDate(dateNow, "Asia/Bangkok", "yy");
        var mm = Utilities.formatDate(dateNow, "Asia/Bangkok", "MM");
        var branchPrefix = branch.toString().substring(0, 3).toUpperCase();
        var prefix = branchPrefix + yy + mm; // e.g. BKK2605
        
        // Find next running number
        var lastNum = 0;
        if (requestSheet.getLastRow() > 1) {
          var reqValues = requestSheet.getDataRange().getValues();
          for (var r = reqValues.length - 1; r >= 1; r--) {
            var exNo = reqValues[r][0]; // คอลัมน์ A: เลขที่ใบเบิก
            if (exNo && exNo.toString().indexOf(prefix) === 0) {
              var suffix = exNo.toString().replace(prefix, '');
              var parsed = parseInt(suffix, 10);
              if (!isNaN(parsed) && parsed > lastNum) {
                lastNum = parsed;
              }
            }
          }
        }
        lastNum += 1;
        var runningStr = ("000" + lastNum).slice(-3);
        reqNumber = prefix + runningStr;
      }
      
      items.forEach(function(item) {
        // Save remaining stock
        if (item.remaining !== null && item.remaining !== undefined && item.remaining !== '') {
          countSheet.appendRow([formattedDate, counterName, branch, "'" + item.productId, item.name, item.unit, item.remaining]);
          
          // Update balance sheet
          var normId = normalizeId(item.productId);
          if (balRowMap[normId]) {
            var rowIndex = balRowMap[normId];
            balanceSheet.getRange(rowIndex, 4).setValue(item.remaining);
            balanceSheet.getRange(rowIndex, 5).setValue(formattedDate);
          } else {
            balanceSheet.appendRow(["'" + item.productId, item.name, branch, item.remaining, formattedDate]);
            balRowMap[normId] = balanceSheet.getLastRow();
          }
        }
        // Save requested stock
        if (item.requested > 0) {
          requestSheet.appendRow([reqNumber, formattedDate, "'" + item.productId, item.name, item.unit, item.requested, requestDate, requesterName, branch]);
        }
      });
      
      response.status = 'success';
      response.message = 'บันทึกข้อมูลเรียบร้อยแล้ว' + (reqNumber ? ' (เลขที่ใบเบิก: ' + reqNumber + ')' : '');
    } else if (action === 'updateStorageCategory') {
      var stockSs = SpreadsheetApp.openById('1xegMuvTYJ9A5E_Wj8J2orc-fp7fSq_lCOXZCQK0eKBQ');
      var categorySheet = stockSs.getSheetByName('หมวดจัดเก็บสาขา');
      if (!categorySheet) {
        categorySheet = stockSs.insertSheet('หมวดจัดเก็บสาขา');
        categorySheet.appendRow(['รหัสสินค้า', 'ชื่อสินค้า', 'สาขา', 'หมวดจัดเก็บ']);
        categorySheet.getRange("A1:D1").setFontWeight("bold");
      }
      
      var productId = data.productId;
      var name = data.name || '';
      var branch = data.branch || '';
      var category = data.category || '';
      
      var normalizeId = function(id) {
        if (id === null || id === undefined) return '';
        return String(id).replace(/^0+/, '').toLowerCase();
      };
      var normIdToUpdate = normalizeId(productId);
      var reqBranch = branch.toLowerCase();
      
      var catValues = categorySheet.getDataRange().getValues();
      var foundIndex = -1;
      for (var c = 1; c < catValues.length; c++) {
        var cId = normalizeId(catValues[c][0]);
        var cBranch = catValues[c][2] ? catValues[c][2].toString().toLowerCase() : '';
        if (cId === normIdToUpdate && cBranch === reqBranch) {
          foundIndex = c + 1;
          break;
        }
      }
      
      if (foundIndex !== -1) {
        categorySheet.getRange(foundIndex, 4).setValue(category);
      } else {
        categorySheet.appendRow(["'" + productId, name, branch, category]);
      }
      
      response.status = 'success';
      response.message = 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว';
    } else if (action === 'getUsageData') {
      var reqBranch = data.branch || '';
      var startDateStr = data.startDate || '';
      var endDateStr = data.endDate || '';
      
      if (!reqBranch || !startDateStr || !endDateStr) {
        throw new Error('ระบุสาขา, วันที่เริ่มต้น และวันที่สิ้นสุดไม่ครบถ้วน');
      }
      
      var branchMap = {
        'sjp': '7', 'crm': '12', 'xcm': '19', 'slr': '37', 'sum': '51',
        'xum': '59', 'scs': '61', 'smp': '63', 'xsb': '67', 'xhh': '72',
        'hrs': '78', 'clk': '79', 'p90': '80', 'hps': '109', 'zbw': '400',
        'zpt': '401', 'npt': '500', 'wrm': '501', 'wmt': '503', 'ipr': '904',
        'zk3': '906'
      };
      var branchKey = String(reqBranch).toLowerCase().trim();
      var outletId = branchMap[branchKey] || branchKey;
      
      var url = "http://183.89.248.221:14369/api/trn_usg?outletid=" + encodeURIComponent(outletId);
      var fetchOptions = {
        'method' : 'get',
        'muteHttpExceptions': true
      };
      
      var fetchResponse = UrlFetchApp.fetch(url, fetchOptions);
      var responseCode = fetchResponse.getResponseCode();
      
      if (responseCode === 200) {
        var apiData = JSON.parse(fetchResponse.getContentText());
        if (Array.isArray(apiData)) {
          var usageMap = {};
          var start = new Date(startDateStr);
          start.setHours(0,0,0,0);
          var end = new Date(endDateStr);
          end.setHours(23,59,59,999);
          
          apiData.forEach(function(item) {
            if (item.Usg_Date) {
              var d = new Date(item.Usg_Date);
              if (d >= start && d <= end) {
                var itmCode = item.Itm_Code;
                if (itmCode) {
                  var normId = String(itmCode).replace(/^0+/, '').toLowerCase();
                  var qty = parseFloat(item.Qty) || 0;
                  if (!usageMap[normId]) usageMap[normId] = 0;
                  usageMap[normId] += qty;
                }
              }
            }
          });
          response.status = 'success';
          response.data = usageMap;
        } else {
           response.status = 'error';
           response.message = apiData.message || 'API ตอบกลับในรูปแบบที่ไม่ถูกต้อง';
        }
      } else {
        response.status = 'error';
        response.message = 'API Error: ' + responseCode;
      }
    } else if (action === 'updateOTApprovalBulk') {
      var resOT = updateOTApprovalBulk(data.dateStr, data.branch, data.updates, data.approverName);
      response.status = resOT.success ? 'success' : 'error';
      response.message = resOT.message;
    } else if (action === 'getBranchStats') {
      var resStats = getBranchStats(data.branch);
      if(resStats.success) {
        response.status = 'success';
        response.data = resStats;
      } else {
        response.status = 'error';
        response.message = resStats.message;
      }
    } else if (action === 'getDailySales') {
      var resSales = getDailySales(data.searchDateStr, data.searchBranch);
      if(resSales.success) {
        response.status = 'success';
        response.data = resSales;
      } else {
        response.status = 'error';
        response.message = resSales.message;
      }
    } else if (action === 'getOTNotifications') {
      var resNotif = getOTNotifications(data.branch);
      if(resNotif.success) {
        response.status = 'success';
        response.data = resNotif.data;
      } else {
        response.status = 'error';
        response.message = resNotif.message;
      }
    } else {
      response.status = 'error';
      response.message = 'Invalid action';
    }

  } catch (error) {
    response.status = 'error';
    response.message = error.toString();
  }

  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

// --- 8. อัปเดตสถานะการอนุมัติ OT ---
function updateOTApprovalBulk(dateStr, branch, updates, approverName) {
  try {
    var ss = SpreadsheetApp.openById("1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U");
    var sheet = ss.getSheetByName('ลงตารางงาน');
    if (!sheet) return { success: false, message: 'ไม่พบ Sheet ข้อมูล' };

    var data = sheet.getDataRange().getValues();
    var updateMap = {};
    updates.forEach(function(u) { updateMap[String(u.name).trim()] = u.isApproved; });
    var searchB = String(branch).trim();

    for (var i = 1; i < data.length; i++) {
      if (isSameDate(data[i][1], dateStr) && String(data[i][2]).trim() === searchB) {
        var rowName = String(data[i][4]).trim();
        if (updateMap.hasOwnProperty(rowName)) {
          var isAppr = updateMap[rowName];
          var val = isAppr ? approverName : '';
          sheet.getRange(i + 1, 21).setValue(val); // Col U (Index 20 / Column 21)
        }
      }
    }
    return { success: true, message: 'บันทึกการอนุมัติ OT เรียบร้อย' };
  } catch(e) { return { success: false, message: e.message }; }
}

// --- 5. ดึงข้อมูลสถิติสาขา ---
function getBranchStats(selectedBranch) {
  try {
    var ss = SpreadsheetApp.openById(SALES_DATA_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('Details');
    if (!sheet) return { success: false, message: 'ไม่พบ Sheet Details' };
    var data = sheet.getDataRange().getDisplayValues();
    var searchBranch = String(selectedBranch).trim();

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === searchBranch) {
        return {
          success: true, sales: data[i][1], dailyTarget: data[i][2],  
          monthlyTarget: data[i][3], maxWage: data[i][5]       
        };
      }
    }
    return { success: false, message: 'ไม่พบข้อมูลสาขานี้' };
  } catch(e) { return { success: false, message: e.message }; }
}

// --- 6. ดึงยอดขายรายวัน ---
function getDailySales(searchDateStr, searchBranch) {
  try {
    var ss = SpreadsheetApp.openById(SALES_DATA_SPREADSHEET_ID);
    var sheet = ss.getSheetByName('ยอดขายสาขา');
    if (!sheet) return { success: true, sales: 0, message: 'ไม่พบ Sheet' };
    var data = sheet.getDataRange().getValues();
    var searchB = String(searchBranch).trim();

    for (var i = 1; i < data.length; i++) {
      if (isSameDate(data[i][0], searchDateStr) && String(data[i][2]).trim() === searchB) {
        return { success: true, sales: data[i][3] }; 
      }
    }
    return { success: true, sales: 0 }; 
  } catch(e) { return { success: false, message: e.message }; }
}

// --- ดึงข้อมูลการแจ้งเตือน OT ---
function getOTNotifications(searchBranch) {
  try {
    var ss = SpreadsheetApp.openById("1bGSENQjSmmYv8V84aInyqk-K7r4niSXFlPqv0zEFQ1U");
    var sheet = ss.getSheetByName('ลงตารางงาน');
    if (!sheet) return { success: false, message: 'ไม่พบตารางข้อมูล' };

    var data = sheet.getDataRange().getValues();
    var pending = [];
    var approved = [];
    
    var branchStr = String(searchBranch).trim();
    var isAdmin = (branchStr === 'All' || branchStr === 'Admin' || branchStr === '');

    // วนลูปจากล่างขึ้นบน เพื่อให้ได้ข้อมูลล่าสุดก่อน
    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      var rowBranch = String(row[2]).trim(); // คอลัมน์ C: สาขา
      
      if (isAdmin || rowBranch === branchStr) {
         var otVal = parseFloat(row[9]); // คอลัมน์ J: OT (ชม.)
         if (!isNaN(otVal) && otVal > 0) {
             var approver = String(row[20] || '').trim(); // คอลัมน์ U: ผู้อนุมัติ OT
             var workDateStr = '';
             var workDateFormatted = '';
             
             // แก้ไขการแปลงวันที่ให้แม่นยำยิ่งขึ้น
             var d = new Date(row[1]);
             if (!isNaN(d.getTime())) {
                 workDateStr = Utilities.formatDate(d, "Asia/Bangkok", 'yyyy-MM-dd');
                 workDateFormatted = Utilities.formatDate(d, "Asia/Bangkok", 'dd/MM/yyyy');
             } else {
                 workDateStr = String(row[1]);
                 workDateFormatted = workDateStr;
             }

             var notifItem = {
                 date: workDateStr,
                 dateFormatted: workDateFormatted,
                 branch: rowBranch,
                 name: String(row[4] || '').trim(), // คอลัมน์ E: ชื่อพนักงาน
                 ot: otVal,
                 approver: approver
             };

             if (approver === '') {
                 if (pending.length < 30) pending.push(notifItem); // แสดงรออนุมัติสูงสุด 30 รายการ
             } else {
                 if (approved.length < 10) approved.push(notifItem); // แสดงอนุมัติแล้วล่าสุด 10 รายการ
             }
         }
      }
      
      // หยุดค้นหาเมื่อข้อมูลเต็ม เพื่อความรวดเร็ว
      if (pending.length >= 30 && approved.length >= 10) break;
    }

    return { success: true, data: { pending: pending, approved: approved } };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

function doOptions(e) {
  // Return empty response with CORS headers for Preflight requests
  var response = { status: 'ok' };
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput("HR System Backend is running.");
}
