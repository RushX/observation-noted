
 
const MODEL = "gemini-2.5-flash"; // swap to gemini-3.5-flash etc. if you like
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
 
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REQ = 30; // ~15 grading rounds (2 calls each) per IP per window
const hits = new Map();
 
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  // light cleanup so the map doesn't grow forever on a warm instance
  if (hits.size > 5000) hits.clear();
  return arr.length > MAX_REQ;
}
 
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY not set on server" });
  }
 
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests — slow down a bit and retry." });
  }
 
  try {
    // Vercel usually parses JSON into req.body; handle string too, just in case.
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { system, user } = body;
    if (!user) return res.status(400).json({ error: "Missing 'user'" });
 
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.7,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
 
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Gemini error" });
    }
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}