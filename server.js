import "dotenv/config";
import express from "express";
import cors from "cors";

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

const PORT = process.env.PORT || 3000;

// CORS: the frontend is a static index.html on Netlify, embedded in a GHL
// iframe, calling this API cross-origin. Allow that origin (FRONTEND_ORIGIN),
// falling back to the legacy ALLOWED_ORIGIN, then "*" only if neither is set.
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || process.env.ALLOWED_ORIGIN || "*";

const app = express();

// Allow POST + OPTIONS and the Content-Type/x-api-key request headers. The
// cors middleware also answers the OPTIONS preflight automatically. No cookies
// are used, so credentials are not enabled.
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);
app.use(express.json());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------
app.post("/generate", async (req, res) => {
  // Shared-secret check. Require a matching x-api-key header.
  const appSecret = process.env.APP_SECRET;
  if (appSecret && req.get("x-api-key") !== appSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

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
