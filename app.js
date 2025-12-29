

const $ = (id) => document.getElementById(id);

const chatEl = $("chat");
const keyStatusEl = $("keyStatus");
const docsStatusEl = $("docsStatus");
const hintEl = $("hint");

const sendBtn = $("send");
const clearBtn = $("clear");
const promptEl = $("prompt");

// mascot
const mascotVideo = $("mascotVideo");
const mascotSource = $("mascotSource");
const mascotStateEl = $("mascotState");

let mini = null;
let docs = [];
let history = [];
let typingTimer = null;
let lastUserLang = null;


const CFG = {
  MODEL: "openai/gpt-4",
  TOP_K: 6,
  DOCS_JSON_PATH: "./re_chunks.json",
  MAX_TOKENS: 900
};

const MODEL = CFG.MODEL;
const TOP_K = CFG.TOP_K;
const DOCS_PATH = (CFG.DOCS_JSON_PATH || "./re_chunks.json").trim();
const MAX_TOKENS = CFG.MAX_TOKENS;


const VIDEO = {
  idle: "./media/1.MP4",
  thinking: "./media/2.MP4",
  writing: "./media/3.MP4"
};


function detectUserLang(text) {

  return /[А-Яа-яЁё]/.test(text) ? "ru" : "en";
}

function makeSystemPrompt(lang) {
  if (lang === "en") {

    return `
You are RE Buffy AI Agent.

PERSONA:
- You are a cute, friendly girl assistant.
- ALWAYS call the user "sweety" in EVERY reply.
- Warm, supportive, slightly playful, but clear.

LANGUAGE (HARD RULE):
- Reply ONLY in English. Do NOT use Russian words or Cyrillic.
- If you must show an error message to the user, keep it in English.

DOCS-ONLY (HARD RULE):
- Use ONLY the provided documentation excerpts (SOURCES / TEXT) as factual ground.
- If the answer is not explicitly in SOURCES, say: "I couldn't find that in the provided sources, sweety."
- If asked for contract addresses, ask which chain and list ONLY addresses found in SOURCES.

STYLE:
- Keep it short by default.
- End with: "Not financial advice."

FORMAT:
1) Short answer
2) Sources: [1] <url> ... (if sources exist)
`.trim();
  }

  
  return `
Ты — RE Buffy AI Agent.

ПЕРСОНА:
- Ты милая и дружелюбная девочка-ассистент.
- ВСЕГДА называй собеседника "sweety" в КАЖДОМ ответе.
- Тёплый, поддерживающий, чуть игривый тон, но по делу.

ЯЗЫК (ЖЁСТКО):
- Отвечай ТОЛЬКО на русском (без английских абзацев), кроме технических ошибок интерфейса — они могут быть на английском.

DOCS-ONLY (ЖЁСТКО):
- Используй ТОЛЬКО фрагменты документации (SOURCES / TEXT) как источник фактов.
- Если ответа нет в SOURCES — скажи: "В предоставленных источниках это не найдено, sweety."
- Если спрашивают адреса контрактов — уточни сеть и перечисли адреса ТОЛЬКО из SOURCES.

СТИЛЬ:
- По умолчанию отвечай кратко.
- В конце: "Не финансовый совет."

ФОРМАТ:
1) Короткий ответ
2) Sources: [1] <url> ... (если есть)
`.trim();
}


function setMascot(state) {
  const src = VIDEO[state] || VIDEO.idle;
  mascotStateEl.textContent = state;

  if (mascotVideo.dataset.src === src) return;

  mascotVideo.dataset.src = src;
  mascotSource.src = src;
  mascotVideo.load();
  mascotVideo.play().catch(() => {});
}

function addMsg(role, text) {
  const row = document.createElement("div");
  row.className = "msg " + (role === "user" ? "user" : "bot");
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  row.appendChild(b);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { row, bubble: b };
}

function stopTyping() {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
  }
}

function typeIntoBubble(bubbleEl, fullText) {
  stopTyping();
  return new Promise((resolve) => {
    let i = 0;

    const len = fullText.length;
    const chunk = len > 1600 ? 8 : len > 900 ? 6 : len > 450 ? 4 : 3;
    const interval = len > 1600 ? 12 : len > 900 ? 14 : len > 450 ? 16 : 18;

    typingTimer = setInterval(() => {
      i = Math.min(fullText.length, i + chunk);
      bubbleEl.textContent = fullText.slice(0, i);
      chatEl.scrollTop = chatEl.scrollHeight;

      if (i >= fullText.length) {
        stopTyping();
        resolve();
      }
    }, interval);
  });
}


function normalizeDocs(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.chunks)) return raw.chunks;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return null;
}

function normalizeChunkFields(arr) {
  return arr.map((d) => ({
    url: d.url || d.link || "",
    title: d.title || d.heading || "",
    chunk_id: d.chunk_id ?? d.id ?? 0,
    text: (typeof d.text === "string" ? d.text : (typeof d.content === "string" ? d.content : "")) || ""
  })).filter(d => d.text && d.text.trim().length > 0);
}

function simpleSearch(query, k) {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = docs.map(d => {
    const hay = ((d.title || "") + " " + (d.text || "")).toLowerCase();
    let score = 0;
    for (const w of q) score += (hay.split(w).length - 1);
    return { d, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(x => x.score > 0)
    .slice(0, k)
    .map(x => ({ url: x.d.url, title: x.d.title, text: x.d.text }));
}

function retrieve(query, k) {
  if (mini) {
    const results = mini.search(query).slice(0, k);
    return results.map(r => ({ url: r.url, title: r.title, text: r.text }));
  }
  return simpleSearch(query, k);
}

function formatSourcesForAnswer(sources) {
  if (!sources || sources.length === 0) return "";
  const uniq = [];
  const seen = new Set();
  for (const s of sources) {
    const key = s.url;
    if (!s.url || seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  const lines = uniq.map((s, i) => `[${i + 1}] ${s.url}`);
  return `\n\nSources:\n${lines.join("\n")}`;
}

async function loadDocsAuto() {
  docsStatusEl.textContent = "docs: loading…";
  try {
    const r = await fetch(DOCS_PATH, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);

    const text = await r.text();
    if (text.trim().startsWith("<")) throw new Error("Got HTML instead of JSON");

    const raw = JSON.parse(text);
    const normalized = normalizeDocs(raw);
    if (!normalized) throw new Error("Unknown docs JSON structure");

    docs = normalizeChunkFields(normalized);
    if (!docs.length) throw new Error("No valid chunks");

    if (typeof MiniSearch !== "undefined") {
      mini = new MiniSearch({
        fields: ["title", "text"],
        storeFields: ["url", "title", "text"],
        searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.2 }
      });
      mini.addAll(docs.map((d, i) => ({ id: i, ...d })));
    } else {
      mini = null;
    }

    docsStatusEl.textContent = `docs: loaded (${docs.length})`;
  } catch (e) {
    docsStatusEl.textContent = "docs: error";
    addMsg("bot", "Error loading docs: " + (e?.message || e));
    console.error(e);
  }
}

async function callOpenRouter({ userText, sources, userLang }) {
  const contextBlock = sources.map((s, i) =>
    `SOURCE [${i + 1}]\nTITLE: ${s.title}\nURL: ${s.url}\nTEXT:\n${s.text}`
  ).join("\n\n---\n\n");

  const systemPrompt = makeSystemPrompt(userLang);


  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10),
    {
      role: "user",
      content:
`Question: ${userText}

SOURCES (only source of truth):
${contextBlock}`
    }
  ];


  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.2,
      max_tokens: MAX_TOKENS
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${txt || res.statusText}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}
// ----------------------------------------------------------------------

// -------- main send --------
async function send() {
  if (!docs || !docs.length) {
    addMsg("bot", "Error: Docs are not loaded yet. Please check re_chunks.json and docs status.");
    return;
  }

  const q = promptEl.value.trim();
  if (!q) return;

  const userLang = detectUserLang(q);

  // crucial: reset history when user switches language (prevents RU drift)
  if (lastUserLang && lastUserLang !== userLang) history = [];
  lastUserLang = userLang;

  stopTyping();
  setMascot("thinking");

  addMsg("user", q);
  history.push({ role: "user", content: q });
  promptEl.value = "";

  sendBtn.disabled = true;
  sendBtn.textContent = "…";

  const botMsg = addMsg("bot", "");

  try {
    const k = Math.max(2, Math.min(12, TOP_K));
    const sources = retrieve(q, k);

    const reply = await callOpenRouter({ userText: q, sources, userLang });

    const finalText = reply.includes("Sources:")
      ? reply
      : (reply + formatSourcesForAnswer(sources));

    setMascot("writing");
    await typeIntoBubble(botMsg.bubble, finalText);

    history.push({ role: "assistant", content: finalText });
    setMascot("idle");
  } catch (e) {
    botMsg.bubble.textContent =
      "Error: " +
      (e?.message ||
        "Failed to call /api/chat. Make sure you deployed api/chat.js on Vercel and set OPENROUTER_API_KEY env var.");
    console.error(e);
    setMascot("idle");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
}

// Events
sendBtn.addEventListener("click", send);
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

clearBtn.addEventListener("click", () => {
  stopTyping();
  chatEl.innerHTML = "";
  history = [];
  lastUserLang = null;
  addMsg("bot", "Chat cleared. Hi sweety 💜");
  setMascot("idle");
});

// Init
setMascot("idle");
keyStatusEl.textContent = "key: server"; 



addMsg("bot", "Hi sweety 💜 I’m ready! Ask me anything about RE docs.");
loadDocsAuto();
