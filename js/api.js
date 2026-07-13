// =================================================================
// PMS Prototype API Client
// - Frontend เรียก Vercel Serverless Proxy ที่ /api/gas-proxy
// - Proxy จะส่งต่อไป Google Apps Script เพื่อเลี่ยงปัญหา CORS/no-cors
// =================================================================
const PMS_SESSION_KEY = "hr_user_session";
const API_ENDPOINT = "/api/gas-proxy";

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(PMS_SESSION_KEY) || "null");
  } catch (error) {
    console.warn("Invalid session payload", error);
    localStorage.removeItem(PMS_SESSION_KEY);
    return null;
  }
}

function setSession(user) {
  localStorage.setItem(PMS_SESSION_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(PMS_SESSION_KEY);
}

function checkAuth(requiredRole) {
  const user = getSession();
  if (!user || !user.token || !user.role) {
    window.location.href = `index.html?role=${encodeURIComponent(requiredRole || "")}`;
    return null;
  }
  if (requiredRole && user.role !== requiredRole) {
    alert(`บัญชีนี้เป็นสิทธิ์ ${user.role} ไม่สามารถเข้า Workspace ของ ${requiredRole} ได้`);
    window.location.href = user.role === "Director" ? "director.html" : "manager.html";
    return null;
  }
  return user;
}

async function apiCall(action, payload = {}) {
  try {
    const session = getSession();
    const requestPayload = { ...payload };

    // ส่งเฉพาะ token กลับไปให้ GAS ตรวจสิทธิ์จากฝั่ง server
    if (action !== "login" && session?.token) {
      requestPayload._session = { token: session.token };
    }

    const response = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload: requestPayload })
    });

    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch (error) {
      throw new Error(`API response is not JSON: ${text.slice(0, 200)}`);
    }

    if (!response.ok || result.status === "error") {
      throw new Error(result.message || `HTTP ${response.status}`);
    }

    return result;
  } catch (error) {
    console.error("API Call Failure:", error);
    return { status: "error", message: error.message || String(error) };
  }
}

async function loginUser(email, pin) {
  const result = await apiCall("login", { email, pin });
  if (result.status === "success" && result.user) {
    setSession(result.user);
  }
  return result;
}

function logout() {
  clearSession();
  window.location.href = "index.html";
}
