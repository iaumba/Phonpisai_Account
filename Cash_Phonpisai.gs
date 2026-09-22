function sendYesterdayLineReport() {
  // ฟังก์ชันช่วยแปลงตัวเลขให้มี comma (,) และคืนค่า '-' ถ้าไม่มีข้อมูล
  const formatNumber = (num) => {
    if (num === '' || num === null || num === undefined) return '-';
    const parsed = Number(num);
    return isNaN(parsed) ? num : parsed.toLocaleString('th-TH');
  };

  // ดึงค่าจาก Script Properties
  const scriptProperties = PropertiesService.getScriptProperties();
  const LINE_ACCESS_TOKEN = scriptProperties.getProperty('LINE_ACCESS_TOKEN');
  const TARGET_ID = scriptProperties.getProperty('TARGET_ID'); // ID กลุ่ม หรือ รายชื่อหลัก
  const ACCOUNTANT_LINE_ID = scriptProperties.getProperty('ACCOUNTANT_LINE_ID'); // ID ของบัญชี
  const EXTRA_LINE_IDS = (scriptProperties.getProperty('EXTRA_LINE_IDS') || '').split(',').map(id => id.trim()).filter(id => id !== ''); // ID ผู้รับเพิ่มเติม (คั่นด้วย ,)

  if (!LINE_ACCESS_TOKEN || !TARGET_ID) {
    Logger.log('กรุณาเซ็ต LINE_ACCESS_TOKEN และ TARGET_ID ใน Project Settings ก่อนนะคะ');
    return;
  }

  // 1. คำนวณวันที่ของเมื่อวาน
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const targetDayMonth = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'd/M');
  const targetDayMonthFull = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'dd/MM');
  const displayYesterday = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'd/M/yyyy');

  // 2. ดึงข้อมูลจากสเปรดชีต
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  const lastRow = sheet.getLastRow();
  let targetRows = [];
  let foundTargetDate = false;

  if (lastRow >= 2) {
    const data = sheet.getRange(1, 1, lastRow, 7).getValues(); 

    for (let i = 0; i < data.length; i++) {
      const cellValue = data[i][0];
      let cellStr = '';

      if (cellValue instanceof Date) {
        cellStr = Utilities.formatDate(cellValue, 'Asia/Bangkok', 'd/M/yyyy');
      } else if (cellValue !== null && cellValue !== undefined) {
        cellStr = String(cellValue).trim();
      }

      if (!foundTargetDate && (cellStr.includes(targetDayMonth) || cellStr.includes(targetDayMonthFull))) {
        foundTargetDate = true;
      } else if (foundTargetDate && cellStr !== '' && !cellStr.includes(targetDayMonth) && !cellStr.includes(targetDayMonthFull)) {
        break;
      }

      if (foundTargetDate) {
        targetRows.push(data[i]);
      }
    }
  }

  const url = 'https://api.line.me/v2/bot/message/push';

  // ฟังก์ชันรวบรวมผู้รับทั้งหมด (กัน ID ว่าง และกันซ้ำ)
  const getAllRecipients = () => {
    return [TARGET_ID, ACCOUNTANT_LINE_ID, ...EXTRA_LINE_IDS]
      .filter(id => id && id.trim() !== '')
      .filter((id, index, self) => self.indexOf(id) === index);
  };

  // 3. กรณี "ไม่พบข้อมูล" -> ส่ง Flex Message แจ้งเตือนให้ผู้รับทั้งหมด
  if (targetRows.length === 0) {
    const alertFlexMessage = {
      type: "flex",
      altText: `⚠️ แจ้งเตือนลงข้อมูลประจำวันที่ ${displayYesterday}`,
      contents: {
        type: "bubble",
        size: "mega",
        header: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#FFF3CD",
          paddingAll: "lg",
          contents: [
            { type: "text", text: "⚠️ แจ้งเตือนลงข้อมูลประจำวัน", weight: "bold", color: "#856404", size: "md" },
            { type: "text", text: "📌 บันทึกเงินสด โพนพิสัย", weight: "bold", color: "#333333", size: "lg", margin: "xs" }
          ]
        },
        body: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#FFFFFF",
          paddingAll: "lg",
          contents: [
            {
              type: "box",
              layout: "baseline",
              contents: [
                { type: "text", text: "วันที่ :", color: "#888888", size: "sm", flex: 2 },
                { type: "text", text: displayYesterday, color: "#333333", size: "sm", flex: 5, weight: "bold" }
              ]
            },
            { type: "separator", margin: "md", color: "#EEEEEE" },
            {
              type: "text",
              text: "ยังไม่พบข้อมูลรายการในระบบนะคะ\nรบกวนทางฝ่ายบัญชีช่วยตรวจสอบและลงข้อมูลให้เรียบร้อยด้วยนะคะ ขอบคุณค่ะ 🙏✨",
              wrap: true,
              color: "#555555",
              size: "sm",
              margin: "md"
            }
          ]
        }
      }
    };

    const recipients = getAllRecipients();

    recipients.forEach(sendToId => {
      const payload = JSON.stringify({
        to: sendToId,
        messages: [alertFlexMessage]
      });

      try {
        UrlFetchApp.fetch(url, {
          method: "post",
          contentType: "application/json",
          headers: { Authorization: "Bearer " + LINE_ACCESS_TOKEN },
          payload: payload
        });
        Logger.log("ส่ง Flex แจ้งเตือนไปยัง: " + sendToId);
      } catch (e) {
        Logger.log("เกิดข้อผิดพลาดส่งหา " + sendToId + ": " + e.toString());
      }
    });

    return;
  }

  // 4. กรณี "พบข้อมูล" -> ประกอบ Flex Message รายงานสรุปยอด
  let receiveListContents = [];
  let expenseListContents = [];
  let summaryIncome = "-";
  let summaryExpense = "-";
  let summaryBalanceDay = "-";
  let summaryBalanceHand = "-";
  let summaryNote = "";

  // ฟังก์ชันช่วยตรวจสอบว่าช่องมีค่า "ว่าง" (รวมค่าว่างกับค่า 0) หรือไม่
  const isEmptyCell = (val) => {
    if (val === null || val === undefined || val === '') return true;
    return String(val).trim() === '';
  };

  // ฟังก์ชันแปลงเลขติดลบให้เป็นค่าบวก แล้วฟอร์แมตเป็นจุลภาค (คืน '-' ถ้าว่าง)
  const formatAbsNumber = (num) => {
    if (isEmptyCell(num)) return '-';
    const parsed = Number(num);
    if (isNaN(parsed)) return String(num);
    return formatNumber(Math.abs(parsed));
  };

  for (let i = 0; i < targetRows.length; i++) {
    const row = targetRows[i];
    const item = (row[1] !== null && row[1] !== undefined) ? String(row[1]).trim() : '';
    const note = row[6] ? String(row[6]).trim() : '';
    const itemUpper = item.toUpperCase();

    // แถวสรุป "รวม" -> เก็บยอดรวม
    if (item.includes('รวม')) {
      summaryIncome = formatNumber(row[2]);
      summaryExpense = formatAbsNumber(row[3]);
      summaryBalanceDay = formatNumber(row[4]);
      summaryBalanceHand = formatNumber(row[5]);
      summaryNote = note;
      continue;
    }

    // แถวยอดยกมา/ยอดคงต้น -> ข้ามไม่ใส่ในรายการย่อย (เก็บเป็นบรรทัดแรกของ Flex Body แทน)
    if (itemUpper.includes('ยกมา') || itemUpper.includes('ยอดยก')) {
      continue;
    }

    // รายการจ่าย (คอลัมน์ D): มีค่า หรือ เป็นข้อมูลนำฝาก = 0 -> แสดงค่า 0
    const depositLike = itemUpper.includes('นำฝาก') || itemUpper.includes('ฝาก');
    if (!isEmptyCell(row[3]) || depositLike) {
      const expenseDisplay = isEmptyCell(row[3]) ? '0' : formatAbsNumber(row[3]);
      let expenseItemBox = {
        type: "box",
        layout: "vertical",
        margin: "sm",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: `• ${item}`, size: "sm", color: "#333333", weight: "bold", flex: 6, wrap: true },
              { type: "text", text: expenseDisplay, size: "sm", color: "#C62828", weight: "bold", align: "end", flex: 3 }
            ]
          }
        ]
      };
      if (note !== '') {
        expenseItemBox.contents.push({
          type: "text",
          text: `   📌 ${note}`,
          size: "xs",
          color: "#757575",
          wrap: true,
          margin: "xs"
        });
      }
      expenseListContents.push(expenseItemBox);
      continue;
    }

    // รายการรับ (คอลัมน์ C)
    if (!isEmptyCell(row[2])) {
      const incomeDisplay = formatNumber(row[2]);
      let receiveItemBox = {
        type: "box",
        layout: "vertical",
        margin: "sm",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: `• ${item}`, size: "sm", color: "#333333", weight: "bold", flex: 6, wrap: true },
              { type: "text", text: incomeDisplay, size: "sm", color: "#2E7D32", weight: "bold", align: "end", flex: 3 }
            ]
          }
        ]
      };
      if (note !== '') {
        receiveItemBox.contents.push({
          type: "text",
          text: `   📌 ${note}`,
          size: "xs",
          color: "#757575",
          wrap: true,
          margin: "xs"
        });
      }
      receiveListContents.push(receiveItemBox);
    }
  }

  // โครงสร้าง Flex Message รายงานสรุปยอด (Light Theme)
  const reportFlexMessage = {
    type: "flex",
    altText: `📊 รายงานบันทึกเงินสด โพนพิสัย ประจำวันที่ ${displayYesterday}`,
    contents: {
      type: "bubble",
      size: "mega",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#E8F5E9",
        paddingAll: "lg",
        contents: [
          { type: "text", text: "📊 รายงานบันทึกเงินสด โพนพิสัย", weight: "bold", color: "#1B5E20", size: "md" },
          { type: "text", text: `ประจำวันที่ ${displayYesterday}`, color: "#4CAF50", size: "xs", margin: "xs" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#FFFFFF",
        paddingAll: "lg",
        contents: [
          { type: "text", text: "รายการย่อยประจำวัน", size: "xs", color: "#999999", weight: "bold" },

          // === ส่วนรับ (คอลัมน์ C) ===
          ...(receiveListContents.length > 0 ? [
            {
              type: "box",
              layout: "vertical",
              margin: "md",
              backgroundColor: "#E3F2FD",
              paddingAll: "sm",
              cornerRadius: "sm",
              contents: [
                { type: "text", text: "🔵 ส่วนรับ", size: "sm", color: "#1565C0", weight: "bold" }
              ]
            },
            ...receiveListContents
          ] : []),

          // === ส่วนจ่าย (คอลัมน์ D) ===
          ...(expenseListContents.length > 0 ? [
            {
              type: "box",
              layout: "vertical",
              margin: "md",
              backgroundColor: "#FFEBEE",
              paddingAll: "sm",
              cornerRadius: "sm",
              contents: [
                { type: "text", text: "🔴 ส่วนจ่าย", size: "sm", color: "#C62828", weight: "bold" }
              ]
            },
            ...expenseListContents
          ] : []),

          { type: "separator", margin: "lg", color: "#E0E0E0" },

          // สรุปรวมรับ - จ่าย
          {
            type: "box",
            layout: "vertical",
            margin: "lg",
            spacing: "sm",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "🔵 รวมรับ :", size: "sm", color: "#333333", flex: 5 },
                  { type: "text", text: summaryIncome, size: "sm", color: "#2E7D32", weight: "bold", align: "end", flex: 5 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "🔴 รวมจ่าย :", size: "sm", color: "#333333", flex: 5 },
                  { type: "text", text: summaryExpense, size: "sm", color: "#C62828", weight: "bold", align: "end", flex: 5 }
                ]
              }
            ]
          },
          { type: "separator", margin: "md", color: "#E0E0E0" },

          // สรุปยอดคงเหลือ
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            spacing: "sm",
            backgroundColor: "#F9F9F9",
            paddingAll: "md",
            cornerRadius: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "💰 ยอดคงเหลือ/วัน :", size: "sm", color: "#424242", flex: 6 },
                  { type: "text", text: summaryBalanceDay, size: "sm", color: "#1565C0", weight: "bold", align: "end", flex: 5 }
                ]
              },
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "💵 ยอดเหลือในมือ :", size: "sm", color: "#424242", flex: 6 },
                  { type: "text", text: summaryBalanceHand, size: "sm", color: "#E65100", weight: "bold", align: "end", flex: 5 }
                ]
              }
            ]
          },

          // === แสดงหมายเหตุรวมเสมอ (ข้อความตาม G, ว่าง -> แสดงหัว) ===
          {
            type: "box",
            layout: "vertical",
            margin: "md",
            contents: [
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  { type: "text", text: "📝 หมายเหตุ :", size: "xs", color: "#666666", weight: "bold", flex: 4 },
                  { type: "text", text: summaryNote !== "" ? summaryNote : "-", size: "xs", color: "#666666", wrap: true, flex: 8 }
                ]
              }
            ]
          }
        ]
      }
    }
  };

  // ส่ง Flex Message รายงานสรุปให้ผู้รับทั้งหมด
  const sendPayload = (sendToId) => {
    const payload = JSON.stringify({
      to: sendToId,
      messages: [reportFlexMessage]
    });

    try {
      UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + LINE_ACCESS_TOKEN },
        payload: payload
      });
      Logger.log("ส่งรายงานสรุปไปยัง: " + sendToId);
    } catch (e) {
      Logger.log("เกิดข้อผิดพลาดส่งหา " + sendToId + ": " + e.toString());
    }
  };

  getAllRecipients().forEach(sendPayload);
}