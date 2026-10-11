// ============================================================
//  ADMIN CONFIGURATION: edit this file before distributing.
// ============================================================
export const CONFIG = {
  // The Apps Script Web App URL (ends in /exec). See README, step "Backend".
  WEBHOOK_URL: "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE",

  // Must match the SHARED_SECRET script property in Apps Script.
  // NOTE: anyone who can read the extension files can read this value. It only
  // stops casual spam; it is not a strong credential.
  SHARED_SECRET: "change-this-secret",

  // Only proctor forms whose URL contains one of these strings
  // (e.g. the ID from your responder link: ".../forms/d/e/<ID>/viewform").
  // Leave EMPTY to proctor every Google Form the student opens.
  PROCTORED_URL_PATTERNS: [],

  // URL prefixes the quiz tab may legitimately visit besides Google Forms itself
  // (sign-in redirects, short links).
  QUIZ_TAB_ALLOWED_PREFIXES: [
    "https://accounts.google.com/",
    "https://forms.gle/",
    "https://forms.google.com/"
  ],

  // Hosts (suffix match) or host/path-prefix entries treated as AI sites.
  AI_DOMAINS: [
    "chatgpt.com",
    "openai.com",
    "gemini.google.com",
    "bard.google.com",
    "aistudio.google.com",
    "notebooklm.google.com",
    "claude.ai",
    "copilot.microsoft.com",
    "bing.com/chat",
    "perplexity.ai",
    "poe.com",
    "character.ai",
    "deepseek.com",
    "grok.com",
    "x.ai",
    "you.com",
    "meta.ai",
    "mistral.ai",
    "huggingface.co/chat",
    "phind.com",
    "blackbox.ai",
    "kimi.com",
    "qwen.ai",
    "writesonic.com",
    "quillbot.com",
    "jasper.ai",
    "monica.im"
  ]
};
