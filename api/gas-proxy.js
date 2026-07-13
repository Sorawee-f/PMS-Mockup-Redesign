module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    return res.status(500).json({
      status: "error",
      message: "Missing Vercel environment variable: GAS_WEBAPP_URL"
    });
  }

  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const gasResponse = await fetch(gasUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body
    });

    const text = await gasResponse.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(gasResponse.ok ? 200 : gasResponse.status).send(text);
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message || String(error) });
  }
};
