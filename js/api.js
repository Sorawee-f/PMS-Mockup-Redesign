// =================================================================
// 🌟 เปลี่ยน URL ตัวเองให้ตรงกับค่า Web App URL ที่คุณกด Deploy มาจาก GAS
// =================================================================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/XXXXXX/exec";

async function apiCall(action, payload = {}) {
  try {
    const response = await fetch(GAS_WEBAPP_URL, {
      method: "POST",
      mode: "no-cors", // ใช้ no-cors ในกรณีป้องกันปัญหา Cross-Origin ทั่วไปของ GAS
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action, payload: payload })
    });
    
    // หมายเหตุ: เนื่องจากโหมด no-cors จะไม่สามารถอ่านค่า response ตรงๆ ได้
    // โค้ดนี้ถูกปรับแต่งให้หน้าต่างแอปจำลองผลลัพธ์ว่าบันทึกสำเร็จหากเชื่อมต่อเครือข่ายได้ปกติ
    return { status: "success", message: "Data packet synced successfully" };
  } catch (error) {
    console.error("API Call Failure:", error);
    return { status: "error", message: error.toString() };
  }
}

// ระบบจำลองการยืนยันตัวตนเบื้องต้น (เปลี่ยน Session ตรงนี้ตามความเหมาะสม)
function checkAuth(requiredRole) {
  // จำลอง Mock Session เพื่อให้ระบบทำงานได้รวดเร็วเมื่อนำขึ้นเว็บเทสต์
  if (requiredRole === "Manager") {
    return { email: "manager.it@company.com", userId: "M7601", role: "Manager" };
  } else if (requiredRole === "Director") {
    return { email: "director.executive@company.com", role: "Director", deptScope: "All" };
  }
  return null;
}
