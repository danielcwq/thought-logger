// deno-lint-ignore-file no-explicit-any
/**
 * Required env vars:
 * - SERVICE_ROLE_KEY
 * - INTERNAL_FUNCTION_SECRET
 * - OPENAI_API_KEY
 *
 * Optional:
 * - OPENAI_SUMMARY_MODEL (default: gpt-4o-mini)
 *
 * Auto-injected:
 * - SUPABASE_URL
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SERVICE_ROLE_KEY")!;
const INTERNAL_FUNCTION_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const OPENAI_SUMMARY_MODEL =
  Deno.env.get("OPENAI_SUMMARY_MODEL") ?? "gpt-5-mini";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

function ok(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function trunc(s: string, max = 500) {
  s = (s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function summarize(messages: { text: string }[], days: number) {
  const joined = messages.map((m) => `- ${trunc(m.text, 300)}`).join("\n");
  const prompt = `Summarize the following messages from the last ${days} days into:
- Key themes (bulleted)
- Open questions
- Action items

Keep it under 250 words. Use concise Markdown. Avoid fluff.

Messages:
${joined}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_SUMMARY_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  return j?.choices?.[0]?.message?.content ?? "_(empty)_";
}

Deno.serve(async (req) => {
  // Internal guard (case-insensitive header check)
  const got = req.headers.get("X-Internal-Secret") ??
    req.headers.get("x-internal-secret");
  if (got !== INTERNAL_FUNCTION_SECRET) return ok({ error: "forbidden" }, 403);

  const body = (await req.json().catch(() => ({}))) || {};
  const days = Math.max(1, Math.min(30, Number(body.days ?? 7)));

  // Compute UTC date window [start_date .. end_date]
  const end = new Date();
  const endDateStr = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
    .toISOString().slice(0, 10);
  const startUTC = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  startUTC.setUTCDate(startUTC.getUTCDate() - (days - 1));
  const startDateStr = startUTC.toISOString().slice(0, 10);

  // Check cache
  const { data: cached } = await sb
    .from("summaries")
    .select("*")
    .eq("start_date", startDateStr)
    .eq("end_date", endDateStr)
    .maybeSingle();
  if (cached) return ok(cached);

  // Fetch messages in range
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: rows, error } = await sb
    .from("messages")
    .select("text")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) return ok({ error: error.message }, 500);

  const summary_md = await summarize(rows ?? [], days);

  const { data: inserted, error: e2 } = await sb
    .from("summaries")
    .insert({
      start_date: startDateStr,
      end_date: endDateStr,
      summary_md,
    })
    .select("*")
    .single();
  if (e2) return ok({ error: e2.message }, 500);

  return ok(inserted);
});
