// ============================================================
//  Quiz Proctor: content script (runs on docs.google.com/forms/*)
//
//  1. Tells the background worker a quiz page has loaded; the worker decides
//     whether this form is proctored (and starts the session).
//  2. Reports page-level focus/visibility changes the background APIs can miss.
//  3. Shows a visible "this quiz is monitored" banner with a live flag count,
//     and lets the student enter their name / student ID.
//
//  DOM is built with createElement (no innerHTML) so it works even under
//  Trusted Types policies.
// ============================================================
(() => {
  "use strict";
  if (window.top !== window || window.__quizProctorLoaded) return;
  window.__quizProctorLoaded = true;

  // Only the respondent view; never the form editor (/edit) used by teachers.
  if (!/\/viewform/.test(location.pathname)) return;

  const send = (msg) => {
    try { return chrome.runtime.sendMessage(msg).catch(() => null); }
    catch { return Promise.resolve(null); } // extension was reloaded/updated
  };

  send({ type: "QUIZ_PAGE_READY", url: location.href, title: document.title })
    .then((res) => { if (res && res.proctored) { watchFocus(); mountBanner(); } });

  /* ------------------------------------------------ focus / visibility */
  function watchFocus() {
    let state = "gained";
    const signal = (next, reason) => {
      if (state === next) return;
      state = next;
      send({ type: "FOCUS_SIGNAL", state: next, reason });
    };

    // Tab hidden: switched tab, minimised window, locked screen.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) signal("lost", "page_hidden");
      else if (document.hasFocus()) signal("gained", "page_visible");
    });

    // Window lost focus: alt-tab to another app, clicked into devtools, etc.
    // Not using capture, and checking e.target, so field-level blur events are ignored.
    window.addEventListener("blur", (e) => {
      if (e.target !== window) return;
      // Small delay + hasFocus() ignores focus moving into an embedded iframe
      // (e.g. a YouTube video inside a question), which is not a violation.
      setTimeout(() => { if (!document.hasFocus()) signal("lost", document.hidden ? "page_hidden" : "window_blur"); }, 300);
    });
    window.addEventListener("focus", (e) => {
      if (e.target === window) signal("gained", "window_focus");
    });
  }

  /* ------------------------------------------------------------ banner */
  function mountBanner() {
    const h = (tag, attrs = {}, ...kids) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) k === "class" ? (el.className = v) : el.setAttribute(k, v);
      el.append(...kids);
      return el;
    };

    const css = `
      .wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;
            font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .panel{display:none;width:290px;box-sizing:border-box;background:#fff;color:#111827;
             border:1px solid #d1d5db;border-radius:12px;padding:12px 14px;
             box-shadow:0 8px 24px rgba(0,0,0,.22)}
      .panel.open{display:block}
      .panel p{margin:0 0 8px}
      .panel label{display:block;font-size:12px;color:#374151;margin:6px 0 2px}
      .panel input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #9ca3af;
                   border-radius:6px;font:inherit;color:#111827;background:#fff}
      .panel button{margin-top:10px;padding:6px 12px;border:0;border-radius:6px;
                    background:#2563eb;color:#fff;font:inherit;cursor:pointer}
      .ok{color:#15803d;margin-left:8px;font-size:12px}
      .pill{display:flex;align-items:center;gap:8px;background:#111827;color:#fff;
            padding:7px 13px;border-radius:999px;cursor:pointer;user-select:none;
            box-shadow:0 4px 14px rgba(0,0,0,.28)}
      .pill.warn{background:#b91c1c}`;

    const pillTxt = h("span");
    const pill = h("div", { class: "pill", title: "Click for details" }, h("span", {}, "🔒"), pillTxt);
    const nameIn = h("input", { type: "text", placeholder: "Full name", maxlength: "80" });
    const idIn = h("input", { type: "text", placeholder: "Student ID", maxlength: "40" });
    const saveBtn = h("button", { type: "button" }, "Save");
    const savedMsg = h("span", { class: "ok" });
    const panel = h("div", { class: "panel" },
      h("p", {}, "This quiz is monitored. Leaving this tab, opening new tabs or windows, visiting AI sites, " +
                 "or opening local files is logged with the date and time and sent to your instructor."),
      h("label", {}, "Full name"), nameIn,
      h("label", {}, "Student ID"), idIn,
      h("div", {}, saveBtn, savedMsg));

    for (const el of [nameIn, idIn]) el.addEventListener("keydown", (e) => e.stopPropagation());

    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;right:14px;bottom:14px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style, h("div", { class: "wrap" }, panel, pill));
    document.documentElement.appendChild(host);

    pill.addEventListener("click", () => panel.classList.toggle("open"));
    saveBtn.addEventListener("click", async () => {
      const student = { name: nameIn.value.trim(), id: idIn.value.trim() };
      await chrome.storage.local.set({ student });
      savedMsg.textContent = "Saved ✓";
      setTimeout(() => (savedMsg.textContent = ""), 2500);
    });

    let shownFlag = 0, timer = null;
    const render = (session) => {
      const n = (session && session.count) || 0;
      const base = `Proctored · ${n} flag${n === 1 ? "" : "s"}`;
      const f = session && session.lastFlag;
      if (f && f.ts !== shownFlag && Date.now() - f.ts < 8000) {
        shownFlag = f.ts;
        pillTxt.textContent = `⚠ Logged: ${f.type.replace(/_/g, " ").toLowerCase()}`;
        pill.classList.add("warn");
        clearTimeout(timer);
        timer = setTimeout(() => { pill.classList.remove("warn"); pillTxt.textContent = base; }, 6000);
      } else if (!pill.classList.contains("warn")) {
        pillTxt.textContent = base;
      }
    };

    chrome.storage.local.get(["session", "student"]).then(({ session, student }) => {
      render(session);
      if (student) { nameIn.value = student.name || ""; idIn.value = student.id || ""; }
      if (!student || !student.name) panel.classList.add("open"); // ask for identity first
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.session) render(changes.session.newValue);
    });
  }
})();
