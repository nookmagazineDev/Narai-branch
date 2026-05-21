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

      for (var i = 0; i < values.length; i++) {
        // Col A = 0, Col B = 1, Col C = 2
        if (values[i][0] == username && values[i][1] == password) {
          loggedIn = true;
          branch = values[i][2]; // สาขา
          break;
        }
      }

      if (loggedIn) {
        response.status = 'success';
        response.data = {
          username: username,
          branch: branch
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
            position: row[8] || ''      // คอลัมน์ I (ตำแหน่ง)
          });
        }
      }

      response.status = 'success';
      response.data = employees;

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
          var isMatchDate = !reqDate || rowDate.indexOf(reqDate) !== -1;
          
          if (isMatchBranch && isMatchDate) {
            history.push({
              timestamp: row[0],
              workDate: rowDate,
              branch: row[2],
              hrCode: row[3],
              name: row[4],
              position: row[5],
              checkIn: row[6],
              checkOut: row[7],
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
          if (br && String(br).toLowerCase() !== 'all' && !branchSet[String(br).toLowerCase()]) {
            branchSet[String(br).toLowerCase()] = true;
            branches.push(br);
          }
        }
      }
      response.status = 'success';
      response.data = branches.sort();
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

      // Build lastStock map from ข้อมูลนับสตอค sheet (latest row per product per branch)
      var lastStockMap = {};
      var previousStockMap = {}; // second-to-last = ยอดยกมา
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
          if (csPid && csBranch === reqBranch) {
            if (lastStockMap[csPid]) {
              previousStockMap[csPid] = lastStockMap[csPid];
            }
            lastStockMap[csPid] = {
              remaining: csRemaining,
              date: csDate instanceof Date ? Utilities.formatDate(csDate, "Asia/Bangkok", "dd/MM/yyyy HH:mm") : csDate,
              counter: csCounter
            };
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
          lastRequest: lastRequestMap[normId] ? lastRequestMap[normId].qty : '',
          lastRequestDate: lastRequestMap[normId] ? lastRequestMap[normId].date : '',
          lastRequester: lastRequestMap[normId] ? lastRequestMap[normId].requester : ''
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

function doOptions(e) {
  // Return empty response with CORS headers for Preflight requests
  var response = { status: 'ok' };
  return ContentService.createTextOutput(JSON.stringify(response)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput("HR System Backend is running.");
}
