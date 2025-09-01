// deno-lint-ignore-file no-explicit-any
/**
 * Edge Function: ai-classify
 *
 * Required project Secrets:
 * - SERVICE_ROLE_KEY           (DB server key)
 * - INTERNAL_FUNCTION_SECRET   (header guard for internal calls)
 * - OPENAI_API_KEY             (for OpenAI requests)
 *
 * Optional (env overrides):
 * - OPENAI_CLASSIFY_MODEL      (default: gpt-4o-mini)
 * - OPENAI_EMBED_MODEL         (default: text-embedding-3-large)
 * - OPENAI_EMBED_DIMENSIONS    (default: 3072)  // must match embeddings.vector(N)
 *
 * Auto-injected by Supabase:
 * - SUPABASE_URL
 *
 * Returns: { ok: true, cls: {…}, embed_len: number }
 * (embed_len is handy for debugging; remove if you want quieter logs)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SERVICE_ROLE_KEY")!;
const INTERNAL_FUNCTION_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

const OPENAI_CLASSIFY_MODEL =
  Deno.env.get("OPENAI_CLASSIFY_MODEL") ?? "gpt-5-mini";
const OPENAI_EMBED_MODEL =
  Deno.env.get("OPENAI_EMBED_MODEL") ?? "text-embedding-3-large";
const OPENAI_EMBED_DIMENSIONS = (() => {
  const n = Number(Deno.env.get("OPENAI_EMBED_DIMENSIONS") ?? "3072");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3072;
})();

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

function ok(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function openaiJSON(content: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_CLASSIFY_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a passive sorter. Classify the message. Reply with strict JSON only:
{
  "is_question": boolean,
  "needs_reply": boolean,
  "followup": boolean,
  "urgency_score": number,
  "topics": string[],
  "entities": object,
  "sentiment": number
}
Rules:
- Mark "needs_reply" only if an immediate, helpful answer is essential.
- "followup" means it should appear in a review queue for later action.
- Be conservative; prefer not to flag unless clear.`,
        },
        { role: "user", content },
      ],
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("OpenAI classify failed", r.status, t);
    return {};
  }

  const j = await r.json();
  const raw = j?.choices?.[0]?.message?.content ?? "{}";
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Classify JSON parse failed", raw);
    return {};
  }
}

async function openaiEmbed(input: string) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input,
      dimensions: OPENAI_EMBED_DIMENSIONS, // ensure it matches DB vector(N)
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("OpenAI embed failed", r.status, t);
    return null;
  }

  const j = await r.json();
  return j?.data?.[0]?.embedding ?? null;
}

Deno.serve(async (req) => {
  // ---- Internal secret guard (case-insensitive header) ----
  const got =
    req.headers.get("X-Internal-Secret") ??
    req.headers.get("x-internal-secret");
  if (got !== INTERNAL_FUNCTION_SECRET) {
    return ok({ error: "forbidden" }, 403);
  }

  // ---- Parse input ----
  const body = await req.json().catch(() => ({} as any));
  const messageId: string | undefined = body?.messageId;
  if (!messageId) return ok({ error: "missing messageId" }, 400);

  // ---- Load message ----
  const { data: m, error: eMsg } = await sb
    .from("messages")
    .select("id, text")
    .eq("id", messageId)
    .single();
  if (eMsg || !m) return ok({ error: "not_found" }, 404);

  // ---- Classify ----
  const cls = await openaiJSON(m.text ?? "");
  const upd = {
    is_question: !!cls.is_question,
    needs_reply: !!cls.needs_reply,
    followup: !!cls.followup,
    urgency_score:
      typeof cls.urgency_score === "number" ? cls.urgency_score : 0,
    topics: Array.isArray(cls.topics) ? cls.topics : null,
    entities:
      cls.entities && typeof cls.entities === "object" ? cls.entities : null,
    sentiment: typeof cls.sentiment === "number" ? cls.sentiment : null,
  };

  const { error: eUpdate } = await sb
    .from("messages")
    .update(upd)
    .eq("id", messageId);
  if (eUpdate) console.error("messages.update error", eUpdate);

  // ---- Embedding (3072 by default) ----
  let embedLen = 0;
  const vec = await openaiEmbed(m.text ?? "");
  const arr = Array.isArray(vec) ? vec.map((x: any) => Number(x)) : [];
  embedLen = arr.length;

  if (
    arr.length === OPENAI_EMBED_DIMENSIONS &&
    arr.every((x) => Number.isFinite(x))
  ) {
    const { error: eEmb } = await sb
      .from("embeddings")
      .upsert(
        { message_id: messageId, embedding: arr },
        { onConflict: "message_id" },
      );
    if (eEmb) console.error("embeddings.upsert error", eEmb);
  } else {
    console.error("Invalid embedding", {
      expected: OPENAI_EMBED_DIMENSIONS,
      len: arr.length,
      sample: arr.slice(0, 5),
    });
  }

  // ---- Follow-up row if needed ----
  if (upd.followup || upd.is_question) {
    const { error: eF } = await sb
      .from("followups")
      .upsert({ message_id: messageId, status: "open" }, {
        onConflict: "message_id",
      });
    if (eF) console.error("followups.upsert error", eF);
  }

  // Temporary visibility to help you confirm dimension:
  console.log("ai-classify done", { messageId, embed_len: embedLen });

  return ok({ ok: true, cls: upd, embed_len: embedLen });
});
