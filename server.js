import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { openai, getIndex } from "./lib/clients.js";
import { upsertContact, uploadAttachment, sendEmail } from "./lib/ghl.js";

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

const PORT = process.env.PORT || 3000;

// Allowed frontend origin(s). The frontend is a static index.html on Netlify,
// embedded in a GHL iframe, calling this API cross-origin and sending NO
// credential. FRONTEND_ORIGIN is comma-separated to allow more than one value
// (falls back to legacy ALLOWED_ORIGIN). Used for BOTH the CORS config and the
// server-side origin allowlist check below.
const ALLOWED_ORIGINS = (
  process.env.FRONTEND_ORIGIN ||
  process.env.ALLOWED_ORIGIN ||
  ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Express is behind Railway's reverse proxy; trust the first hop so the client
// IP (X-Forwarded-For) is used for rate limiting rather than the proxy's IP.
const app = express();
app.set("trust proxy", 1);

// CORS: allow the configured origin(s) (or any, if none configured), POST +
// OPTIONS, and the Content-Type request header. The cors middleware also
// answers the OPTIONS preflight automatically. No cookies/credentials.
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json({ limit: "10mb" }));

// ---------------------------------------------------------------------------
// Server-side origin allowlist (separate from CORS)
// ---------------------------------------------------------------------------
// CORS only governs browsers; it does NOT stop non-browser clients (curl,
// scripts) from calling the API. This middleware enforces the allowlist on the
// server for every /generate request. If FRONTEND_ORIGIN is unset there is
// nothing to check against, so it allows through (set it in production!).
function requireAllowedOrigin(req, res, next) {
  if (ALLOWED_ORIGINS.length === 0) return next();

  // Prefer the Origin header; fall back to the origin parsed from Referer.
  let origin = req.get("origin");
  if (!origin) {
    const referer = req.get("referer");
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        origin = null;
      }
    }
  }

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiting for /generate
// ---------------------------------------------------------------------------
// Cap each client IP to 30 requests per 10-minute window; 429 when exceeded.
const generateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 30, // 30 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------
// Secured server-side via the origin allowlist + rate limiter (no client
// credential). The request carries no auth header.
app.post("/generate", generateLimiter, requireAllowedOrigin, async (req, res) => {
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

// ---------------------------------------------------------------------------
// Send proposal via email (GoHighLevel Conversations API)
// ---------------------------------------------------------------------------
// Takes a generated proposal PDF (base64) and emails it to the client through
// GHL so the message logs into the contact's Conversations thread. Sits behind
// the same two middlewares as /generate (rate limiter, then origin allowlist).
app.post("/send-email", generateLimiter, requireAllowedOrigin, async (req, res) => {
  try {
    const {
      clientName,
      clientEmail,
      subject,
      coverNoteHtml,
      pdfBase64,
      pdfFilename,
    } = req.body || {};

    if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return res.status(400).json({ error: "Valid clientEmail is required" });
    }
    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject is required" });
    }
    if (!coverNoteHtml || typeof coverNoteHtml !== "string") {
      return res.status(400).json({ error: "coverNoteHtml is required" });
    }
    if (!pdfBase64 || typeof pdfBase64 !== "string") {
      return res.status(400).json({ error: "pdfBase64 is required" });
    }

    const trimmedName = (clientName || "").trim();
    const spaceIdx = trimmedName.indexOf(" ");
    const firstName = spaceIdx === -1 ? trimmedName : trimmedName.slice(0, spaceIdx);
    const lastName  = spaceIdx === -1 ? ""           : trimmedName.slice(spaceIdx + 1);

    const contactId = await upsertContact({
      email: clientEmail, firstName, lastName,
    });

    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    if (pdfBuffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "PDF exceeds GHL's 5 MB attachment limit" });
    }
    if (pdfBuffer.length < 100) {
      return res.status(400).json({ error: "PDF appears to be empty or malformed" });
    }
    const attachmentUrl = await uploadAttachment({
      contactId,
      buffer: pdfBuffer,
      filename: pdfFilename || "proposal.pdf",
      contentType: "application/pdf",
    });

    const result = await sendEmail({
      contactId,
      subject,
      html: coverNoteHtml,
      attachments: [attachmentUrl],
      emailTo: clientEmail,
    });

    res.json({
      ok: true,
      contactId,
      messageId: result?.messageId || result?.id || null,
      conversationId: result?.conversationId || null,
    });
  } catch (err) {
    console.error("[/send-email] error:", err);
    res.status(500).json({ error: err.message || "Failed to send email" });
  }
});

app.listen(PORT, () => {
  console.log(`Kairo API listening on port ${PORT}`);
});
