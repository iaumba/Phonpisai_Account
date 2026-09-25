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

  // 1. คำนวณวันที่ของ "เมื่อวาน" ตามเขตเวลาไทย (Asia/Bangkok)
  //    * ไม่ใช้ new Date().setDate(-1) เพราะเป็นการลบวันตาม UTC จะเพี้ยนเมื่อ Trigger รันช่วงเช้ามืด
  //    * อ่านวันปัจจุบันตามเวลาไทยก่อน แล้วค่อยลบ 1 วัน (คำนวณแบบ UTC -> แปลงให้เป็นวันไทย)
  const todayParts = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy|M|d').split('|');
  const todayBkk = new Date(Date.UTC(
    parseInt(todayParts[0], 10),
    parseInt(todayParts[1], 10) - 1,
    parseInt(todayParts[2], 10)
  ));
  const yesterday = new Date(todayBkk.getTime() - 24 * 60 * 60 * 1000);

  const targetDayMonth = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'd/M');
  const targetDayMonthFull = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'dd/MM');
  const displayYesterday = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'd/M/yyyy');
  const targetMonthAbbr = Utilities.formatDate(yesterday, 'Asia/Bangkok', 'MMM', 'th_TH'); // เช่น ก.ย.

  // 2. หาชีตประจำเดือนเป้าหมาย: จับคู่ชื่อชีต (เช่น "ก.ย.69") กับเดือนของวันเมื่อวาน
  //    * Trigger รันเบื้องหลังมักไม่มี "active sheet" (getActiveSheet() คืนชีตแรก/ว่าง)
  //    * ดังนั้นระบุชีตให้ชัดเจนแทนการพึ่ง getActiveSheet()
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = findTargetSheet(ss, targetMonthAbbr);
  if (!sheet) {
    Logger.log('ไม่พบชีตประจำเดือนนี้ (' + targetMonthAbbr + ') กรุณาตรวจสอบชื่อชีตใน Google Sheets ค่ะ');
    return;
  }

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

/**
 * หาชีตประจำเดือนเป้าหมาย
 * (ใช้ได้ทั้ง Trigger รันเบื้องหลัง และ รันด้วยมือ)
 *
 * ลำดับการเลือก:
 *  1. ชีตที่ชื่อตรงเดือนของ "เมื่อวาน" และ มีข้อมูลวันที่เมื่อวานอยู่จริง
 *     (เช่น รัน 1 ต.ค. แต่ยังไม่มีชีต ต.ค.69 -> จะเลือก ก.ย.69 ที่มีข้อมูล 30/9)
 *  2. ชีตเดือนปัจจุบัน ที่มีข้อมูลเมื่อวาน
 *  3. ชีตที่ชื่อตรงเดือน (ตามลำดับที่มีในไฟล์)
 *  4. สำรอง -> active sheet
 *
 * @param {SpreadsheetApp.Spreadsheet} ss
 * @param {string} monthAbbr ชื่อเดือนแบบไทย เช่น "ก.ย."
 * @return {Sheet|null}
 */
function findTargetSheet(ss, monthAbbr) {
  // สำรองข้อมูลเดือนไทย กันกรณี locale ของ Utilities.formatDate ไม่ตรง
  const THAI_MONTHS = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];
  const abbr = monthAbbr || THAI_MONTHS[new Date().getMonth()] || '';
  const curMonthAbbr = THAI_MONTHS[new Date().getMonth()] || '';

  const sheets = ss.getSheets();
  let fallbackAbbr = null;   // ชีตที่ชื่อตรงเดือนเมื่อวาน (ไม่เช็ควัน)
  let fallbackCur = null;    // ชีตที่ชื่อตรงเดือนปัจจุบัน (ไม่เช็ควัน)

  for (let i = 0; i < sheets.length; i++) {
    const name = sheets[i].getName();
    if (!name.includes(abbr) && !name.includes(curMonthAbbr)) continue;

    // 1. ชีตที่มีข้อมูล "เมื่อวาน" จริง -> ใช้ทันที (สำคัญตอนข้ามเดือน)
    if (name.includes(abbr) && sheetHasDate(sheets[i], abbr)) {
      return sheets[i];
    }

    // 2. ชีตเดือนปัจจุบันที่มีข้อมูล
    if (name.includes(curMonthAbbr) && sheetHasDate(sheets[i], curMonthAbbr)) {
      if (!fallbackCur) fallbackCur = sheets[i];
      continue;
    }

    // เก็บสำรองไว้ก่อน
    if (name.includes(abbr) && !fallbackAbbr) fallbackAbbr = sheets[i];
    if (name.includes(curMonthAbbr) && !fallbackCur) fallbackCur = sheets[i];
  }

  // ส่งออกตามลำดับความสำคัญ
  if (fallbackCur) return fallbackCur;
  if (fallbackAbbr) return fallbackAbbr;

  // สำรอง: ยังไม่มีชีตเดือนนี้ -> ใช้ active sheet (กัน error กรณีรันมือ)
  try {
    return ss.getActiveSheet();
  } catch (e) {
    return null;
  }
}

/**
 * ตรวจสอบว่าชีตหนึ่ง มีข้อมูลวันที่ที่ตรงกับเดือนที่ระบุหรือไม่
 * (อ่านคอลัมน์ A แล้วเทียบเลขเดือน เช่น "30/9", "30/9/2026", Date ที่เป็นเดือน 9)
 * @param {Sheet} sheet
 * @param {string} abbr ชื่อเดือนแบบไทย เช่น "ก.ย."
 * @return {boolean}
 */
function sheetHasDate(sheet, abbr) {
  const THAI_MONTHS = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];
  const targetMonth = THAI_MONTHS.indexOf(abbr) + 1; // 1-12
  if (targetMonth <= 0) return false;

  try {
    const last = sheet.getLastRow();
    if (last < 2) return false;

    const aCol = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < aCol.length; i++) {
      const cv = aCol[i][0];
      if (cv instanceof Date) {
        if (cv.getMonth() + 1 === targetMonth) return true;
      } else if (cv !== null && cv !== undefined) {
        const m = String(cv).trim().match(/^\d{1,2}\/(\d{1,2})(?:\/\d{2,4})?/);
        if (m && parseInt(m[1], 10) === targetMonth) return true;
      }
    }
    return false;
  } catch (e) {
    return false;
  }
}