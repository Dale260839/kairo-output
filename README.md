# Kairo

A Node.js + Express API that generates construction job proposals using RAG
(Retrieval-Augmented Generation). This is the serving layer only — no frontend.

**Flow:** A contractor's job details come in via `POST /generate` → the
descriptive fields are embedded into a query vector → Pinecone is queried for
relevant knowledge chunks → a prompt is assembled with that context + the job
details → OpenAI writes a full proposal → it's returned as JSON.

## Endpoints

| Method | Path           | Description                                          |
| ------ | -------------- | ---------------------------------------------------- |
| GET    | `/health`      | Health check → `{ ok: true }`                        |
| POST   | `/generate`    | Generate a proposal → `{ proposal, sources_used }`   |
| POST   | `/send-email`  | Email a proposal PDF via GoHighLevel → `{ ok, contactId, messageId, conversationId }` |

`POST /generate` and `POST /send-email` carry no client credential. They are
secured server-side by the same two middlewares: a rate limiter (30 req / 10
min per IP → 429) and an origin allowlist checked against `FRONTEND_ORIGIN`
(→ 403). See `.env.example` for details.

## Send-to-Email (`POST /send-email`)

Takes a generated proposal as a base64 PDF and sends it to the client via the
GoHighLevel (LeadConnector) Conversations API, so the email logs into the
contact's GHL Conversations thread. Flow: upsert the contact by email → upload
the PDF to GHL → send an Email message with the cover-note HTML + the PDF
attached.

**Request body:**
```json
{
  "clientName": "Jane Doe",
  "clientEmail": "jane@example.com",
  "subject": "Your roofing proposal",
  "coverNoteHtml": "<p>Hi Jane, please find your proposal attached.</p>",
  "pdfBase64": "<base64-encoded PDF>",
  "pdfFilename": "proposal.pdf"
}
```

**Extra env vars** (read from `process.env`; only required when `/send-email`
is actually called — the server boots fine without them):

| Var | Where to find it |
| --- | ---------------- |
| `GHL_PIT` | A **Private Integration Token** — GHL sub-account → **Settings → Private Integrations**. |
| `GHL_LOCATION_ID` | The sub-account (location) ID — from the sub-account URL or **Settings → Business Profile**. |

**Required PIT scopes:** `contacts.write`, `conversations.write`,
`conversations/message.write`.

> ⚠️ GoHighLevel caps email attachments at **5 MB**. PDFs larger than that are
> rejected with `413` before upload.

## Requirements

- Node.js >= 18
- An OpenAI API key
- A Pinecone index with **dimension 1536** (to match `text-embedding-3-small`)

> ⚠️ **Dimension must match.** The embedding model (`text-embedding-3-small`,
> 1536 dims) must match your Pinecone index dimension, and you must query with
> the **same** embedding model you ingested with. Mismatches cause errors or
> meaningless results.

## Run locally

```bash
npm install

# Create your env file from the template and fill in real values
cp .env.example .env

npm start
```

The server listens on `http://localhost:3000` (or `$PORT`).

Check it's up:

```bash
curl http://localhost:3000/health
# => {"ok":true}
```

## Seed sample knowledge

The index starts empty. This script embeds a few sample construction knowledge
strings and upserts them so the pipeline can be tested:

```bash
npm run seed
```

## Test `/generate`

```bash
curl -X POST http://localhost:3000/generate \
  -H "Content-Type: application/json" \
  -H "x-api-key: $APP_SECRET" \
  -d '{
    "trade": "Roofing",
    "scope": "Full tear-off and replacement of a 2,400 sq ft asphalt shingle roof",
    "clientName": "Jane Doe",
    "location": "Austin, TX",
    "budget": "$18,000",
    "notes": "Two-story home, steep pitch, needs completion before rainy season"
  }'
```

Response shape:

```json
{
  "proposal": "....full generated proposal text....",
  "sources_used": 3
}
```

If the index has no matches, the API still generates a proposal using
`context = "no matches yet"` and returns `"sources_used": 0`.

## Deploy to Railway

1. **Push to GitHub** — commit this repo and push it to a GitHub repository.
2. **Deploy from repo** — in Railway, create a new project →
   *Deploy from GitHub repo* → select this repository. Railway detects Node and
   runs `npm install` then `npm start`.
3. **Set environment variables** — in the service's *Variables* tab, add:
   - `OPENAI_API_KEY`
   - `PINECONE_API_KEY`
   - `PINECONE_INDEX`
   - `APP_SECRET` (recommended)
   - `ALLOWED_ORIGIN` (recommended — your frontend origin)
   - Do **not** set `PORT`; Railway injects it automatically.
4. **Generate a public domain** — in *Settings → Networking*, click
   *Generate Domain* to get a public URL. Test it with the same curl commands
   above, swapping `localhost:3000` for your Railway domain.

## Environment variables

See [`.env.example`](./.env.example) for the full list and descriptions.
