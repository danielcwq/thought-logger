// deno-lint-ignore-file no-explicit-any
/**
 * Required env vars in Supabase project Secrets:
 * - SERVICE_ROLE_KEY
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_WEBHOOK_SECRET
 * - INTERNAL_FUNCTION_SECRET
 *
 * Auto-injected by Supabase:
 * - SUPABASE_URL
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const INTERNAL_FUNCTION_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET")!;

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
const TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
const FUNCTIONS_BASE = `https://${projectRef}.functions.supabase.co`;

function ok(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sendText(chatId: number, text: string, replyMarkup?: any) {
  const chunks = chunkByLength(text, 3800); // headroom below 4096
  for (const c of chunks) {
    const r = await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: c,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
        disable_web_page_preview: true,
      }),
    });
    await r.text();
  }
}

function chunkByLength(s: string, max = 3800) {
  const out: string[] = [];
  let cur = "";
  for (const line of (s ?? "").split("\n")) {
    const candidate = cur ? cur + "\n" + line : line;
    if (candidate.length > max) {
      if (cur) out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseCommand(text: string) {
  const [cmd, ...rest] = (text ?? "").trim().split(/\s+/);
  const name = cmd?.startsWith("/") ? cmd.slice(1) : null;
  return { name, args: rest.join(" ") };
}

async function callInternal(path: string, payload: unknown) {
  const res = await fetch(`${FUNCTIONS_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_FUNCTION_SECRET,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Internal call failed: ${res.status}`);
  return res.json();
}

async function upsertUser(telegramUser: any) {
  const { id, first_name, username } = telegramUser ?? {};
  const display = username ?? first_name ?? `tg_${id}`;
  const { data, error } = await sb
    .from("users")
    .upsert(
      { telegram_user_id: id, display_name: display },
      { onConflict: "telegram_user_id" },
    )
    .select("id, telegram_user_id")
    .single();
  if (error) throw error;
  return data;
}

async function insertMessage(
  update: any,
  chatId: number,
  fromUserId: string,
  text: string,
  createdAt: Date,
) {
  const telegram_update_id = update.update_id ?? null;
  const telegram_message_id = update.message?.message_id ??
    update.edited_message?.message_id ?? null;
  const payload = update;

  const { data, error } = await sb
    .from("messages")
    .insert({
      telegram_update_id,
      telegram_message_id,
      chat_id: chatId,
      from_user_id: fromUserId,
      text,
      created_at: createdAt.toISOString(),
      payload,
    })
    .select("id")
    .maybeSingle();

  // ignore unique violation (duplicate)
  if (error && error.code !== "23505") throw error;
  return data?.id ?? null;
}

async function handleReview(chatId: number, days: number) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await sb
    .from("messages")
    .select("id, text, created_at, is_question, followup, urgency_score, replied")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw error;

  const scored = (data ?? [])
    .map((m) => {
      const ageDays = Math.max(
        0,
        (Date.now() - new Date(m.created_at).getTime()) / 86400000,
      );
      const score =
        3 * Number(!!m.is_question) +
        2 * Number(!!m.followup) +
        1.5 * (m.urgency_score ?? 0) +
        2 * Number(!m.replied) +
        1 * Math.exp(-ageDays);
      return { ...m, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (!scored.length) {
    return sendText(chatId, `No items to review for the last *${days}* days.`);
  }

  const lines = scored.map((m, i) => {
    const t = new Date(m.created_at).toLocaleString();
    const short = (m.text || "").replace(/\s+/g, " ").slice(0, 120);
    return `*${i + 1}.* ${t} — ${short}
Q:${!!m.is_question}  FUP:${!!m.followup}  U:${m.urgency_score ?? 0}  R:${m.replied ? "y" : "n"}
_id: ${m.id}_`;
  });

  const kb = {
    inline_keyboard: [[
      { text: "✅ Done (top)", callback_data: `done:${scored[0].id}` },
      { text: "😴 Snooze 24h (top)", callback_data: `snooze:${scored[0].id}:24` },
    ]],
  };

  await sendText(chatId, `*Review (${days}d)*\n\n${lines.join("\n")}`, kb);
}

async function handleSummary(chatId: number, n: number) {
  const res = await callInternal("ai-summarize-range", { days: n });
  const md = res?.summary_md ?? "_No summary available._";
  await sendText(chatId, `*Summary (last ${n} days)*\n\n${md}`);
}

async function handleDtg(chatId: number, phrase: string) {
  const { data, error } = await sb.rpc("search_dtg", { q: phrase, k: 3 });
  if (error) throw error;
  if (!data || !data.length) return sendText(chatId, `No matches for: \`${phrase}\``);
  const lines = data.map(
    (r: any) => `${new Date(r.created_at).toLocaleString()} — ${r.snippet}`,
  );
  await sendText(chatId, `*DTG matches*\n${lines.join("\n")}`);
}

async function handleDone(
  messageId: string,
  chatId: number,
  callbackQueryId?: string,
) {
  await sb.from("followups").update({
    status: "done",
    resolved_at: new Date().toISOString(),
  }).eq("message_id", messageId);
  await sb.from("messages").update({ replied: true }).eq("id", messageId);

  if (callbackQueryId) {
    await fetch(`${TG}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: "Marked done ✅",
      }),
    });
  } else {
    await sendText(chatId, "Marked done ✅");
  }
}

async function handleSnooze(
  messageId: string,
  hours: number,
  chatId: number,
  callbackQueryId?: string,
) {
  const due = new Date(Date.now() + hours * 3600_000).toISOString();
  await sb.from("followups").upsert(
    { message_id: messageId, status: "open", due_at: due },
    { onConflict: "message_id" },
  );

  if (callbackQueryId) {
    await fetch(`${TG}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: `Snoozed ${hours}h 😴`,
      }),
    });
  } else {
    await sendText(chatId, `Snoozed ${hours}h 😴`);
  }
}

Deno.serve(async (req) => {
  // Verify Telegram secret header (shared during setWebhook)
  const tgHeader = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (tgHeader !== TELEGRAM_WEBHOOK_SECRET) return ok({ error: "forbidden" }, 403);

  const update = await req.json().catch(() => ({}));

  // Handle callback query (inline buttons)
  if (update?.callback_query) {
    const cq = update.callback_query;
    const data = String(cq.data || "");
    const chatId = cq.message?.chat?.id;
    const [action, id, hours] = data.split(":");
    if (action === "done") {
      await handleDone(id, chatId, cq.id);
    } else if (action === "snooze") {
      await handleSnooze(id, Number(hours || 24), chatId, cq.id);
    }
    return ok({ ok: true });
  }

  // Handle messages/commands
  const msg = update.message ?? update.edited_message;
  if (!msg || typeof msg.text !== "string") return ok({ ok: true });

  const chatId = msg.chat.id;
  const text = msg.text as string;
  const createdAt = new Date((msg.date ?? Math.floor(Date.now() / 1000)) * 1000);

  // Upsert user + insert message (passive)
  const user = await upsertUser(msg.from);
  const insertedId = await insertMessage(update, chatId, user.id, text, createdAt);

  // Commands
  const { name, args } = parseCommand(text);
  if (name) {
    if (name === "review") {
      const days = Math.max(1, Math.min(30, Number(args) || 3));
      await handleReview(chatId, days);
    } else if (name === "summary") {
      const n = Math.max(1, Math.min(30, Number(args) || 7));
      await handleSummary(chatId, n);
    } else if (name === "dtg") {
      const phrase = args?.trim().replace(/^"|"$/g, "") || "";
      if (!phrase) await sendText(chatId, "Usage: `/dtg <phrase>`");
      else await handleDtg(chatId, phrase);
    } else if (name === "done") {
      const id = args.trim();
      await handleDone(id, chatId);
    } else if (name === "snooze") {
      const [id, h] = args.split(/\s+/);
      await handleSnooze(id, Number(h || 24), chatId);
    } else {
      await sendText(
        chatId,
        "Commands: /review [days], /summary [n], /dtg <phrase>, /done <id>, /snooze <id> [h]",
      );
    }
    return ok({ ok: true });
  }

  // Non-command: be passive; trigger classifier only if a fresh row was inserted
  if (insertedId) {
    await callInternal("ai-classify", { messageId: insertedId });
  }
  return ok({ ok: true });
});
