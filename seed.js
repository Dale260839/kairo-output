import "dotenv/config";

import { openai, getIndex } from "./lib/clients.js";

// IMPORTANT: This MUST be the same embedding model used by server.js (and any
// other ingestion pipeline). text-embedding-3-small => 1536 dims. Verify your
// Pinecone index's dimension is also 1536, or upserts/queries will fail or
// return meaningless results.
const EMBEDDING_MODEL = "text-embedding-3-small";

// A few sample construction knowledge chunks so the RAG pipeline can be
// exercised while the real index is still empty.
const SAMPLE_CHUNKS = [
  {
    id: "kb-roofing-001",
    text:
      "Roofing proposals should specify material (asphalt shingle, metal, TPO), " +
      "tear-off vs. overlay, underlayment type, flashing details, and a workmanship " +
      "warranty (typically 5-10 years). Always note disposal of old materials and " +
      "any decking replacement as a unit-price allowance since hidden rot is common.",
  },
  {
    id: "kb-concrete-001",
    text:
      "Concrete flatwork proposals should call out PSI rating (3000-4000 PSI for " +
      "driveways), thickness (4\" residential, 6\" for heavy loads), reinforcement " +
      "(rebar or fiber mesh), control joint spacing, and cure time before use. " +
      "Include subgrade prep and note that pours are weather-dependent.",
  },
  {
    id: "kb-general-001",
    text:
      "Every construction proposal should include: a clear scope of work, exclusions, " +
      "payment schedule tied to milestones, estimated start and completion dates, " +
      "change-order policy, and licensing/insurance information. Clarity on exclusions " +
      "prevents the majority of client disputes.",
  },
];

async function seed() {
  const index = await getIndex();

  console.log(`Embedding ${SAMPLE_CHUNKS.length} sample chunks...`);
  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: SAMPLE_CHUNKS.map((c) => c.text),
  });

  const vectors = SAMPLE_CHUNKS.map((chunk, i) => ({
    id: chunk.id,
    values: embeddingResponse.data[i].embedding,
    metadata: { text: chunk.text },
  }));

  console.log("Upserting vectors to Pinecone...");
  await index.upsert(vectors);

  console.log(`Seeded ${vectors.length} vectors successfully.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
