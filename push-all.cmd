@echo off
rem ============================================================
rem  Push ทั้ง 2 Apps Script (แยกคนละ App):
rem    1) clasp-cash    -> สคริปต์เงินสด  Cash_Phonpisai
rem    2) clasp-payment -> สคริปต์รายการจ่าย โพนพิสัยรายการจ่าย
rem  วิธีใช้: ดับเบิลคลิก หรือรัน  push-all.cmd
rem ============================================================
call "%~dp0clasp-cash\push.cmd"
if errorlevel 1 (
  echo.
  echo [ERROR] ชุด clasp-cash ล้มเหลว ไม่ push ชุดถัดไป
  exit /b 1
)
echo.
echo ============================================================
echo     ต่อไป: ชุด clasp-payment
echo ============================================================
call "%~dp0clasp-payment\push.cmd"
exit /b %ERRORLEVEL%