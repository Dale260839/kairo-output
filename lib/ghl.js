// lib/ghl.js — GoHighLevel (LeadConnector) API client, V2.
//
// Auth: Private Integration Token (PIT) from a GHL sub-account.
//   Settings → Private Integrations → token with scopes:
//     contacts.write, conversations.write, conversations/message.write

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function jsonHeaders() {
  return {
    Authorization: `Bearer ${requireEnv("GHL_PIT")}`,
    Version: GHL_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function multipartHeaders() {
  // Let fetch set Content-Type with the multipart boundary.
  return {
    Authorization: `Bearer ${requireEnv("GHL_PIT")}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

async function readErrorBody(res) {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}

export async function upsertContact({ email, firstName, lastName }) {
  const locationId = requireEnv("GHL_LOCATION_ID");
  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      email,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      locationId,
    }),
  });
  if (!res.ok) {
    throw new Error(`GHL upsertContact ${res.status}: ${await readErrorBody(res)}`);
  }
  const data = await res.json();
  const contactId = data?.contact?.id || data?.id;
  if (!contactId) {
    throw new Error(
      `GHL upsertContact returned no contactId: ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  return contactId;
}

export async function uploadAttachment({ contactId, buffer, filename, contentType }) {
  const locationId = requireEnv("GHL_LOCATION_ID");
  const form = new FormData();
  form.append("locationId", locationId);
  form.append("contactId", contactId);
  form.append(
    "fileAttachment",
    new Blob([buffer], { type: contentType || "application/octet-stream" }),
    filename
  );

  const res = await fetch(
    `${GHL_BASE}/conversations/messages/upload`,
    { method: "POST", headers: multipartHeaders(), body: form }
  );
  if (!res.ok) {
    throw new Error(`GHL uploadAttachment ${res.status}: ${await readErrorBody(res)}`);
  }
  const data = await res.json();
  const urls =
    (data?.uploadedFiles && Object.values(data.uploadedFiles)) ||
    data?.urls ||
    [];
  if (!urls.length) {
    throw new Error(
      `GHL uploadAttachment returned no URL: ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  return urls[0];
}

export async function sendEmail({
  contactId, subject, html, attachments = [], emailTo, emailFrom,
}) {
  const body = { type: "Email", contactId, subject, html };
  if (emailTo) body.emailTo = emailTo;
  if (emailFrom) body.emailFrom = emailFrom;
  if (attachments.length) body.attachments = attachments;

  const res = await fetch(`${GHL_BASE}/conversations/messages`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GHL sendEmail ${res.status}: ${await readErrorBody(res)}`);
  }
  return await res.json();
}
