// ============================================================
//  Quiz Proctor: background service worker (Manifest V3)
//
//  Responsibilities
//   1. Start/end a proctoring SESSION when a Google Form quiz is opened/submitted.
//   2. While a session is active, listen to browser-level events and turn them
//      into infraction log entries.
//   3. Persist entries in a queue (chrome.storage.local) and POST them to the
//      Google Apps Script webhook, retrying until delivered.
//
//  MV3 service workers are killed when idle, so NOTHING lives in global
//  variables: all state is in chrome.storage.local, and every handler re-reads
//  it. Handlers run through serial() so read-modify-write cycles never overlap.
// ============================================================
import { CONFIG } from "./config.js";

const COOLDOWN_MS = 30_000;
const MAX_QUEUE = 2000;
const MAX_RECENT = 25;

const DOCS_FORMS_RE = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?forms\//;
const VIEWFORM_RE = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?forms\/.*\/viewform/;
const SUBMITTED_RE = /^https:\/\/docs\.google\.com\/(?:u\/\d+\/)?forms\/.*\/formResponse/;

const FILE_CATEGORIES = {
  pdf: "PDF", doc: "Word document", docx: "Word document", odt: "Word document",
  rtf: "Word document", txt: "text note", md: "text note", log: "text note",
  ppt: "presentation", pptx: "presentation", xls: "spreadsheet", xlsx: "spreadsheet",
  csv: "spreadsheet", png: "image", jpg: "image", jpeg: "image", gif: "image",
  webp: "image", htm: "HTML file", html: "HTML file"
};

/* ---------------------------------------------------------- storage + lock */

const get = async (key) => (await chrome.storage.local.get(key))[key];
const set = (obj) => chrome.storage.local.set(obj);

let chain = Promise.resolve();
/** Run fn after all previously queued handlers finished. Never rejects. */
function serial(fn) {
  const p = chain.then(fn).catch((e) => console.error("[proctor]", e));
  chain = p;
  return p;
}

async function getSession() {
  const s = await get("session");
  return s && s.active ? s : null;
}
const saveSession = (s) => set({ session: s });

/* ------------------------------------------------------------ URL helpers */

function matchHost(host, pathname, rule) {
  const slash = rule.indexOf("/");
  const h = slash === -1 ? rule : rule.slice(0, slash);
  const p = slash === -1 ? "" : rule.slice(slash);
  const hostOk = host === h || host.endsWith("." + h);
  return hostOk && (!p || pathname.startsWith(p));
}

/** Classify any tab URL. Returns { kind, key, ...details }. */
function classifyUrl(raw) {
  if (!raw) return { kind: "PENDING" };
  let u;
  try { u = new URL(raw); } catch { return { kind: "UNKNOWN" }; }

  if (u.protocol === "file:") {
    const name = decodeURIComponent(u.pathname.split("/").pop() || "");
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    return { kind: "LOCAL_FILE", key: name || "(folder)", name, ext,
             category: name ? (FILE_CATEGORIES[ext] || "file") : "folder view" };
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    const host = u.hostname.toLowerCase();
    if (CONFIG.AI_DOMAINS.some((r) => matchHost(host, u.pathname, r))) {
      return { kind: "AI_SITE", key: host, host };
    }
    return { kind: "WEBPAGE", key: host, host };
  }
  // chrome://, chrome-extension://, about:, chrome-error:, devtools: ...
  const ignore = /^(chrome:\/\/(newtab|new-tab-page)|about:blank|chrome-error:)/.test(raw);
  return { kind: "BROWSER_PAGE", key: u.protocol + u.host, label: `${u.protocol}//${u.host}`, ignore };
}

/** Strip query/hash (may contain tokens) and local directory paths (usernames). */
function sanitizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "file:") return "file:///…/" + decodeURIComponent(u.pathname.split("/").pop() || "");
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return ""; }
}

function describeTarget(raw) {
  const c = classifyUrl(raw);
  switch (c.kind) {
    case "AI_SITE": return `AI site (${c.host})`;
    case "LOCAL_FILE": return `local file (${c.name || "folder view"})`;
    case "WEBPAGE": return c.host;
    case "BROWSER_PAGE": return "browser page";
    default: return "unknown page";
  }
}

const isAllowedQuizUrl = (url) =>
  !!url && (DOCS_FORMS_RE.test(url) || CONFIG.QUIZ_TAB_ALLOWED_PREFIXES.some((p) => url.startsWith(p)));

function isProctoredFormUrl(url) {
  if (!VIEWFORM_RE.test(url || "")) return false;
  const pats = CONFIG.PROCTORED_URL_PATTERNS || [];
  return pats.length === 0 || pats.some((p) => url.includes(p));
}

/* ----------------------------------------------------------------- logging */

/**
 * Build a log entry, store it in the upload queue and update session counters.
 * severity "INFO" = lifecycle event (not counted as an infraction).
 */
async function addLog(session, type, severity, details, extra = {}) {
  const now = new Date();
  const student = (await get("student")) || {};

  const entry = {
    id: crypto.randomUUID(),
    timestampISO: now.toISOString(),
    date: now.toLocaleDateString("en-CA"),                       // 2026-10-11
    time: now.toLocaleTimeString("en-GB", { hourCycle: "h23" }), // 14:03:22
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    studentName: student.name || "",
    studentId: student.id || "",
    profileEmail: session.profileEmail || "",
    sessionId: session.id,
    formTitle: session.formTitle || "",
    formUrl: sanitizeUrl(session.formUrl),
    type,
    severity,
    details,
    url: extra.url ? sanitizeUrl(extra.url) : "",
    tabId: extra.tabId ?? null
  };

  const isFlag = severity !== "INFO";
  if (isFlag) {
    session.count = (session.count || 0) + 1;
    session.lastFlag = { type, ts: Date.now() };
  }
  await saveSession(session);

  const { queue = [], recent = [] } = await chrome.storage.local.get(["queue", "recent"]);
  queue.push(entry);
  while (queue.length > MAX_QUEUE) queue.shift();
  if (type !== "HEARTBEAT") {
    recent.unshift({ date: entry.date, time: entry.time, type, details });
    recent.length = Math.min(recent.length, MAX_RECENT);
  }
  await set({ queue, recent });

  if (isFlag) updateBadge(session.count);
  flushQueue().catch(() => {});
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count ? String(count) : "ON" });
  chrome.action.setBadgeBackgroundColor({ color: count ? "#b91c1c" : "#15803d" });
}

function cooldownPassed(s, key, ms = COOLDOWN_MS) {
  const now = Date.now();
  s.cooldowns ||= {};
  if (s.cooldowns[key] && now - s.cooldowns[key] < ms) return false;
  s.cooldowns[key] = now;
  const keys = Object.keys(s.cooldowns);
  if (keys.length > 200) for (const k of keys) if (now - s.cooldowns[k] > ms) delete s.cooldowns[k];
  return true;
}

/* ---------------------------------------------------------------- uploader */

let flushing = false;

async function postBatch(entries) {
  if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.includes("PASTE_YOUR")) return false;
  try {
    // text/plain avoids a CORS preflight, which Apps Script can't answer.
    const res = await fetch(CONFIG.WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: CONFIG.SHARED_SECRET, entries })
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return !!(data && data.ok);
  } catch {
    return false; // offline etc.: keep entries queued and retry on the next tick
  }
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const queue = (await get("queue")) || [];
      if (!queue.length) break;
      const batch = queue.slice(0, 25);
      if (!(await postBatch(batch))) break;
      const sent = new Set(batch.map((e) => e.id));
      // Remove sent entries inside the lock so we don't clobber concurrent appends.
      await serial(async () => {
        const current = (await get("queue")) || [];
        await set({ queue: current.filter((e) => !sent.has(e.id)) });
      });
    }
  } finally {
    flushing = false;
  }
}

/* ---------------------------------------------------------------- sessions */

async function startSession(tab, info) {
  let profileEmail = "";
  try {
    const p = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    profileEmail = p.email || "";
  } catch { /* not signed in to Chrome */ }

  let fileAccess = false, incognitoAccess = false;
  try { fileAccess = await chrome.extension.isAllowedFileSchemeAccess(); } catch {}
  try { incognitoAccess = await chrome.extension.isAllowedIncognitoAccess(); } catch {}

  // Baseline: how many other tabs were already open (counts only, no URLs).
  const tabs = await chrome.tabs.query({});
  let ai = 0, files = 0;
  for (const t of tabs) {
    if (t.id === tab.id) continue;
    const k = classifyUrl(t.url).kind;
    if (k === "AI_SITE") ai++;
    else if (k === "LOCAL_FILE") files++;
  }

  const session = {
    active: true,
    id: crypto.randomUUID(),
    tabId: tab.id,
    windowId: tab.windowId,
    formUrl: tab.url,
    formTitle: info.title || "",
    profileEmail,
    startedAt: Date.now(),
    count: 0,
    awayAt: null,
    cooldowns: {}
  };
  await saveSession(session);
  updateBadge(0);

  await addLog(
    session, "SESSION_START", "INFO",
    `Proctoring started (v${chrome.runtime.getManifest().version}). Other tabs open: ${tabs.length - 1} ` +
    `(AI sites: ${ai}, local files: ${files}). File-URL access: ${fileAccess}. Incognito monitoring: ${incognitoAccess}.`,
    { url: tab.url, tabId: tab.id }
  );
}

async function endSession(s, reason) {
  const durationSec = Math.round((Date.now() - s.startedAt) / 1000);
  await addLog(s, "SESSION_END", "INFO",
    `Session ended (${reason}). Duration: ${durationSec}s. Total flags: ${s.count || 0}.`);
  s.active = false;
  s.awayAt = null;
  s.endedAt = Date.now();
  s.endReason = reason;
  await saveSession(s);
  chrome.action.setBadgeText({ text: "" });
  flushQueue().catch(() => {});
}

/* ----------------------------------------------- "away from quiz" episodes */

const AWAY_INFO = {
  tab_switch:   ["LEFT_QUIZ_TAB",      "MEDIUM", "Student switched away from the quiz tab"],
  window_switch:["SWITCHED_WINDOW",    "MEDIUM", "Student switched to a different browser window"],
  app_focus:    ["BROWSER_LOST_FOCUS", "MEDIUM", "Browser lost focus (student switched to another application)"],
  page_hidden:  ["QUIZ_TAB_HIDDEN",    "MEDIUM", "Quiz tab was hidden (tab switched or window minimised)"],
  window_blur:  ["QUIZ_WINDOW_BLUR",   "LOW",    "Quiz window lost focus (devtools, address bar or another window)"]
};

/** Log the START of an away episode once; later away-signals are ignored until the student returns. */
async function markAway(s, reason, targetUrl) {
  if (s.awayAt) return;
  const [type, sev, msg] = AWAY_INFO[reason];
  s.awayAt = Date.now();
  await addLog(s, type, sev, targetUrl ? `${msg} → ${describeTarget(targetUrl)}` : msg, { url: targetUrl });
}

async function markReturn(s) {
  if (!s.awayAt) return;
  const sec = Math.round((Date.now() - s.awayAt) / 1000);
  s.awayAt = null;
  await addLog(s, "RETURNED_TO_QUIZ", "INFO", `Student returned to the quiz after ${sec}s away.`);
}

/** Classify a URL seen in a non-quiz tab and log the specific infraction. */
async function inspectUrl(s, tabId, rawUrl, { skipGeneric = false } = {}) {
  if (!rawUrl || rawUrl.startsWith(chrome.runtime.getURL(""))) return;
  const c = classifyUrl(rawUrl);
  let spec;
  switch (c.kind) {
    case "AI_SITE":
      spec = ["AI_SITE_ACCESSED", "HIGH", `AI site accessed: ${c.host}`]; break;
    case "LOCAL_FILE":
      spec = ["LOCAL_FILE_OPENED", "HIGH", `Local ${c.category} opened in browser: ${c.name || "(folder view)"}`]; break;
    case "WEBPAGE":
      if (skipGeneric) return;
      spec = ["WEBPAGE_VISITED", "MEDIUM", `Webpage visited: ${c.host}`]; break;
    case "BROWSER_PAGE":
      if (skipGeneric || c.ignore) return;
      spec = ["BROWSER_PAGE_OPENED", "LOW", `Browser page opened: ${c.label}`]; break;
    default: return;
  }
  if (!cooldownPassed(s, `${tabId}|${c.kind}|${c.key}`)) return;
  await addLog(s, spec[0], spec[1], spec[2], { url: rawUrl, tabId });
}

/* --------------------------------------------------------- message handler */

async function onQuizPageReady(msg, tab) {
  if (!tab || !isProctoredFormUrl(tab.url || msg.url)) return { proctored: false };

  let s = await getSession();
  if (s) {
    if (s.tabId === tab.id) {                       // reload of the same quiz tab
      s.formTitle = msg.title || s.formTitle;
      await saveSession(s);
      return { proctored: true };
    }
    const stillThere = await chrome.tabs.get(s.tabId).then(() => true, () => false);
    if (stillThere) {                               // a SECOND quiz tab while one is active
      await addLog(s, "DUPLICATE_QUIZ_TAB", "MEDIUM",
        "A quiz page was opened in a second tab during an active session", { url: tab.url, tabId: tab.id });
      return { proctored: false };
    }
    await endSession(s, "STALE_SESSION");           // old quiz tab vanished without an event
  }
  await startSession(tab, msg);
  return { proctored: true };
}

async function onFocusSignal(msg, tab) {
  const s = await getSession();
  if (!s || !tab || tab.id !== s.tabId) return;
  if (msg.state === "lost") await markAway(s, msg.reason === "page_hidden" ? "page_hidden" : "window_blur");
  else await markReturn(s);
}

async function handleMessage(msg, sender) {
  switch (msg && msg.type) {
    case "QUIZ_PAGE_READY": return serial(() => onQuizPageReady(msg, sender.tab));
    case "FOCUS_SIGNAL":    return serial(() => onFocusSignal(msg, sender.tab));
    case "FLUSH":           await flushQueue(); return { ok: true };
    default:                return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, () => sendResponse(null));
  return true; // async response
});

/* ------------------------------------------------- browser event listeners */
// Listeners must be registered synchronously at top level so a sleeping
// service worker is woken up by the event.

// 1) Student activates a different tab (or comes back to the quiz tab).
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => serial(async () => {
  const s = await getSession(); if (!s) return;
  if (tabId === s.tabId) { s.windowId = windowId; await markReturn(s); return; }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab && (tab.url || tab.pendingUrl);
  await markAway(s, "tab_switch", url);
  if (tab) await inspectUrl(s, tabId, url);
}));

// 2) Browser window focus changed (other app, or another Chrome window).
chrome.windows.onFocusChanged.addListener((windowId) => serial(async () => {
  const s = await getSession(); if (!s) return;
  if (windowId === chrome.windows.WINDOW_ID_NONE) { await markAway(s, "app_focus"); return; }

  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (windowId === s.windowId) {
    if (active && active.id === s.tabId) await markReturn(s);
    return;
  }
  await markAway(s, "window_switch", active && active.url);
  if (active) await inspectUrl(s, active.id, active.url);
}));

// 3) A brand-new tab was opened.
chrome.tabs.onCreated.addListener((tab) => serial(async () => {
  const s = await getSession(); if (!s || tab.id === s.tabId) return;
  const url = tab.pendingUrl || tab.url || "";
  await addLog(s, "NEW_TAB_OPENED", "MEDIUM",
    url ? `A new tab was opened → ${describeTarget(url)}` : "A new tab was opened",
    { url, tabId: tab.id });
}));

// 4) A tab navigated (new URL). Covers both the quiz tab and every other tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => serial(async () => {
  const s = await getSession(); if (!s) return;
  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
  if (!url) return;

  if (tabId === s.tabId) {
    if (isSubmittedUrl(url)) { await endSession(s, "SUBMITTED"); return; }
    if (!isAllowedQuizUrl(url)) {
      await addLog(s, "NAVIGATED_AWAY_FROM_QUIZ", "HIGH",
        `The quiz tab navigated to ${describeTarget(url)}`, { url, tabId });
      await inspectUrl(s, tabId, url, { skipGeneric: true });
    }
    return;
  }
  await inspectUrl(s, tabId, url);
}));

function isSubmittedUrl(url) { return SUBMITTED_RE.test(url || ""); }

// 5) Quiz tab closed before submitting.
chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  const s = await getSession(); if (!s || tabId !== s.tabId) return;
  await addLog(s, "QUIZ_TAB_CLOSED", "MEDIUM", "The quiz tab was closed before the form was submitted");
  await endSession(s, "QUIZ_TAB_CLOSED");
}));

// 6) Keep tracking the quiz tab if Chrome swaps it or the student drags it to another window.
chrome.tabs.onReplaced.addListener((addedId, removedId) => serial(async () => {
  const s = await getSession();
  if (s && s.tabId === removedId) { s.tabId = addedId; await saveSession(s); }
}));
chrome.tabs.onAttached.addListener((tabId, info) => serial(async () => {
  const s = await getSession();
  if (s && s.tabId === tabId) { s.windowId = info.newWindowId; await saveSession(s); }
}));

// 7) Incognito window opened (only visible if "Allow in Incognito" is ON).
chrome.windows.onCreated.addListener((w) => serial(async () => {
  const s = await getSession(); if (!s || !w.incognito) return;
  await addLog(s, "INCOGNITO_WINDOW_OPENED", "HIGH", "An incognito window was opened during the quiz");
}));

/* ------------------------------------------------- lifecycle + heartbeat */

function ensureAlarm() {
  chrome.alarms.get("tick").then((a) => { if (!a) chrome.alarms.create("tick", { periodInMinutes: 1 }); });
}
ensureAlarm();

// Every minute: heartbeat (lets the admin detect an extension that was disabled
// mid-quiz) and retry any entries that failed to upload.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "tick") return;
  serial(async () => {
    const s = await getSession();
    if (s) await addLog(s, "HEARTBEAT", "INFO", "alive");
  }).then(() => flushQueue()).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => ensureAlarm());

chrome.runtime.onStartup.addListener(() => serial(async () => {
  ensureAlarm();
  const s = await getSession();
  if (s) {
    await addLog(s, "BROWSER_RESTARTED", "MEDIUM", "The browser was restarted during an active session");
    await endSession(s, "BROWSER_RESTARTED");
  }
  flushQueue().catch(() => {});
}));
