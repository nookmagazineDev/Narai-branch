// NOTE: Replace this with your actual Google Apps Script Web App URL
export const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz3scE1W_YVAOd1vhhnx0HlShQn_2wh6ryIY1hJR_HdKe0xHP8-rin_aEqEZ0JJcqVJ/exec";

export const apiCall = async (action, payload) => {
  if (SCRIPT_URL === "YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL" || SCRIPT_URL === "") {
    throw new Error("กรุณาตั้งค่า SCRIPT_URL ในไฟล์ src/services/api.js ก่อนใช้งาน");
  }

  try {
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...payload
      }),
      // mode: 'no-cors' cannot read response, so we need Google Apps Script to be set to execute as "User accessing the web app" or "Me" with "Anyone" access.
      // Usually fetch to GAS requires redirect handling or simple POST
    });

    const result = await response.json();
    if (result.status === 'success') {
      return result;
    } else {
      throw new Error(result.message || "เกิดข้อผิดพลาดจากเซิร์ฟเวอร์");
    }
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
};
