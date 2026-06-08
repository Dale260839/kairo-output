import "dotenv/config";
import express from "express";
import cors from "cors";
import CryptoJS from "crypto-js";
import jwt from "jsonwebtoken";

import { openai, getIndex } from "./lib/clients.js";

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------
// Chat model — kept in a single constant so it's trivial to swap.
const CHAT_MODEL = "gpt-4o-mini";

// IMPORTANT: The embedding model MUST produce vectors whose dimension matches
// your Pinecone index's dimension. text-embedding-3-small => 1536 dims.
// Verify your index dimension equals 1536, AND make sure this is the SAME
// embedding model your ingestion/seeding pipeline uses — querying with a
// different model than you ingested with will silently return garbage matches.
const EMBEDDING_MODEL = "text-embedding-3-small";

// Session JWTs issued by /session are valid for this long.
const SESSION_TTL = "8h";

const PORT = process.env.PORT || 3000;

// CORS: the frontend is a static page embedded in a GHL iframe, served from a
// different origin than this API. Allow that origin (FRONTEND_ORIGIN), falling
// back to the legacy ALLOWED_ORIGIN, then "*" only if neither is set.
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || process.env.ALLOWED_ORIGIN || "*";

const app = express();

// Allow POST + OPTIONS and the Content-Type/Authorization headers. The cors
// middleware also answers the OPTIONS preflight automatically. No cookies are
// used, so credentials are not enabled.
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// ---------------------------------------------------------------------------
// GoHighLevel (GHL) SSO + session auth helpers
// ---------------------------------------------------------------------------

// Parse the optional ALLOWED_LOCATION_IDS allowlist. Returns null when unset
// (meaning "allow any sub-account"), otherwise an array of location ids.
function parseAllowedLocations() {
  const raw = process.env.ALLOWED_LOCATION_IDS;
  if (!raw || !raw.trim()) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Express middleware: require a valid session JWT in the Authorization header.
// On any problem respond 401 { error: "Unauthorized" } so the frontend re-gates.
function requireSession(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const payload = jwt.verify(match[1], process.env.SESSION_JWT_SECRET);
    // Attach verified identity for logging / per-location rate limiting.
    req.session = {
      userId: payload.sub,
      locationId: payload.locationId,
      companyId: payload.companyId,
      role: payload.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GHL SSO handshake -> session JWT
// ---------------------------------------------------------------------------
// The embedded frontend performs the GHL SSO handshake and relays the
// encrypted session blob here. We decrypt it with the GHL app shared secret,
// enforce that it's a sub-account (location) user, optionally check the
// location allowlist, then mint a short-lived JWT the frontend uses as a
// Bearer token on /generate.
app.post("/session", (req, res) => {
  const sharedSecret = process.env.GHL_APP_SHARED_SECRET;
  const jwtSecret = process.env.SESSION_JWT_SECRET;
  if (!sharedSecret || !jwtSecret) {
    // Server misconfiguration — don't leak which secret is missing.
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  const { ssoToken } = req.body || {};
  if (!ssoToken || typeof ssoToken !== "string") {
    return res.status(401).json({ ok: false, error: "Missing SSO token" });
  }

  // 1) Decrypt the GHL SSO token (AES via crypto-js).
  let user;
  try {
    const json = CryptoJS.AES.decrypt(ssoToken, sharedSecret).toString(
      CryptoJS.enc.Utf8
    );
    user = JSON.parse(json); // throws if the secret/token is wrong
  } catch {
    // Do not log the raw token or decrypted payload (contains PII).
    return res.status(401).json({ ok: false, error: "Invalid SSO token" });
  }

  // 2) Require a sub-account (location) user, not an agency-level user.
  if (!user || user.type !== "location") {
    return res
      .status(403)
      .json({ ok: false, error: "This tool is only available to sub-accounts" });
  }

  // 3) Optional per-location allowlist.
  const allowed = parseAllowedLocations();
  if (allowed && !allowed.includes(user.activeLocation)) {
    return res
      .status(403)
      .json({ ok: false, error: "This sub-account is not authorized" });
  }

  // 4) Issue a short-lived session JWT.
  const token = jwt.sign(
    {
      sub: user.userId,
      locationId: user.activeLocation,
      companyId: user.companyId,
      role: user.role,
    },
    jwtSecret,
    { expiresIn: SESSION_TTL }
  );

  return res.json({
    ok: true,
    token,
    user: {
      name: user.userName,
      locationId: user.activeLocation,
      type: user.type,
    },
  });
});

// ---------------------------------------------------------------------------
// Proposal generation (gated by a valid GHL session JWT)
// ---------------------------------------------------------------------------
app.post("/generate", requireSession, async (req, res) => {
  try {
    const job = req.body || {};
    const { trade, scope, clientName, location, budget, notes } = job;

    // Build a natural-language query string from the descriptive fields.
    // We only include fields that were actually provided.
    const queryParts = [];
    if (trade) queryParts.push(`Trade: ${trade}`);
    if (scope) queryParts.push(`Scope of work: ${scope}`);
    if (location) queryParts.push(`Location: ${location}`);
    if (budget) queryParts.push(`Budget: ${budget}`);
    if (notes) queryParts.push(`Notes: ${notes}`);
    const queryString =
      queryParts.join("\n") || "general construction job proposal";

    // Embed the query.
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: queryString,
    });
    const queryVector = embeddingResponse.data[0].embedding;

    // Query Pinecone for relevant knowledge chunks.
    const index = await getIndex();
    const queryResult = await index.query({
      vector: queryVector,
      topK: 5,
      includeMetadata: true,
    });

    const matches = queryResult.matches || [];
    const sources_used = matches.length;

    // Assemble the context block from match metadata text.
    const context =
      matches
        .map((m) => m.metadata?.text)
        .filter(Boolean)
        .join("\n\n---\n\n") || "no matches yet";

    // Build the chat messages.
    const systemMessage = {
      role: "system",
      content:
        "You are an expert construction estimator and proposal writer. " +
        "Using the provided reference knowledge and the contractor's job " +
        "details, write a clear, professional, client-ready job proposal. " +
        "Include sections such as an overview, scope of work, approach, " +
        "timeline, and a closing. Be specific and grounded in the job " +
        "details. If reference knowledge is provided, use it to inform best " +
        "practices, but do not fabricate prices or commitments that aren't " +
        "supported by the job details.",
    };

    const userMessage = {
      role: "user",
      content:
        `Reference knowledge:\n${context}\n\n` +
        `Job details:\n${JSON.stringify(job, null, 2)}\n\n` +
        (clientName ? `Client name: ${clientName}\n\n` : "") +
        "Write the full proposal now.",
    };

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [systemMessage, userMessage],
    });

    const proposal = completion.choices[0]?.message?.content || "";

    res.json({ proposal, sources_used });
  } catch (err) {
    console.error("Error generating proposal:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Kairo API listening on port ${PORT}`);
});
