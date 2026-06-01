import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// --- OpenAI -----------------------------------------------------------------
// Instantiated once and reused across requests.
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Pinecone ---------------------------------------------------------------
// Instantiated once. In v7 the client targets an index by its HOST, which we
// resolve at runtime via describeIndex() and then cache.
export const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

let cachedIndex = null;

/**
 * Resolve the target index's host via describeIndex and return a cached,
 * host-targeted index handle.
 *
 * NOTE: we deliberately use pc.index({ host }) (the v7 host form), NOT the
 * legacy pc.index(name) string form.
 */
export async function getIndex() {
  if (cachedIndex) return cachedIndex;

  const indexName = process.env.PINECONE_INDEX;
  if (!indexName) {
    throw new Error("PINECONE_INDEX env var is not set");
  }

  const description = await pinecone.describeIndex(indexName);
  const host = description.host;
  if (!host) {
    throw new Error(`Could not resolve host for Pinecone index "${indexName}"`);
  }

  cachedIndex = pinecone.index({ host });
  return cachedIndex;
}
