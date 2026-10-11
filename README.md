# PROJECT_1_SIA
DIGITAL EXAM PROCTOR

Quiz Proctor (Google Forms): Chrome Extension + Google Sheet backend
Files
File	Purpose
manifest.json	MV3 manifest: permissions, service worker, content script, popup
config.js	Admin settings: webhook URL, secret, proctored form IDs, AI-domain list
background.js	Service worker: sessions, all browser event listeners, logging, upload queue
content.js	Runs on the Google Form: focus/visibility signals + visible "monitored" banner
popup.html / popup.js	Student-facing status, identity entry, setup checks, recent flags
Code.gs	Google Apps Script backend (kept outside the extension folder) that writes rows to a Sheet
1. Backend (Google Sheet)
Create a Google Sheet → Extensions → Apps Script, paste Code.gs.
Project Settings → Script properties → add SHARED_SECRET (any long random string).
Deploy → New deployment → Web app → Execute as Me, access Anyone → copy the /exec URL.
In the extension's config.js, set WEBHOOK_URL and the same SHARED_SECRET. Optionally put your form's ID in PROCTORED_URL_PATTERNS so only your quiz is proctored.

Tabs are created automatically on first upload: Infractions, Sessions, Heartbeats.

Quick summary tab (paste into a new sheet cell):

=QUERY(Infractions!A2:O, "select E, F, count(J) where K <> 'INFO' group by E, F order by count(J) desc label E 'Student', F 'ID', count(J) 'Flags'", 0)
2. Install & test locally
Put the extension files (everything except Code.gs) in a folder named QuizProctor_Extension.
Open chrome://extensions/.
Turn on Developer mode (top right).
Click Load unpacked → select QuizProctor_Extension.
On the extension's Details page, switch on Allow access to file URLs (and Allow in Incognito if you want incognito detection).
Open your Google Form's responder link (…/viewform). A dark 🔒 Proctored pill appears bottom-right; enter name + ID.
Trigger each infraction and watch the Infractions tab (rows appear within seconds):
Do this	Expected Violation type
Switch to another tab	LEFT_QUIZ_TAB (+ RETURNED_TO_QUIZ with seconds away)
Alt-tab to another app	BROWSER_LOST_FOCUS
Press Ctrl+T	NEW_TAB_OPENED
Open https://chatgpt.com	AI_SITE_ACCESSED (HIGH)
Drag a PDF/.txt into Chrome (or open file:///…)	LOCAL_FILE_OPENED (HIGH)
Visit any other site in a new tab	WEBPAGE_VISITED
Type another URL in the quiz tab	NAVIGATED_AWAY_FROM_QUIZ (HIGH)
Close the quiz tab before submitting	QUIZ_TAB_CLOSED
Submit the form	SESSION_END (reason SUBMITTED)

If nothing arrives: open chrome://extensions → service worker link on the extension card to see console errors, and check the popup's "waiting to upload" counter.

3. How the event logic works
Session starts when content.js loads on a /viewform URL and the worker confirms the URL is proctored. It ends on submission (/formResponse), quiz-tab close, or browser restart. Nothing is monitored outside a session.
State lives in chrome.storage.local, never in globals, because MV3 service workers are killed when idle. Every listener re-reads state, and serial() queues handlers so read-modify-write cycles never interleave.
Away episodes. Several signals fire at once when a student leaves (tab activation, window focus change, visibilitychange, blur). The first one opens an "away episode" and is logged; the rest are ignored until the student returns, when RETURNED_TO_QUIZ records the duration. This prevents 3–4 duplicate rows per switch.
Classification. Every URL seen in a non-quiz tab goes through classifyUrl(): file: → local file (category from extension), host matches AI_DOMAINS → AI site, other http(s) → webpage, chrome:// → browser page. A 30-second per-tab/host cooldown stops SPA sites like ChatGPT from flooding the log, while genuine return visits are logged again.
Upload queue. Each entry is appended to a persisted queue, POSTed in batches to the Apps Script web app, and removed only after the server confirms. A 1-minute alarm retries failures (offline, etc.). Entry IDs make retries idempotent on the server.
Timestamps. Each entry has the student's local date/time/timezone plus ISO time; the Sheet adds a server-side received time that cannot be tampered with.
4. Limitations (be upfront with your students/admins)
A student can disable or uninstall the extension. The 1-minute Heartbeats tab lets you spot gaps; for real enforcement, force-install via Chrome Enterprise policy on managed devices.
It can't see other devices (phone) or activity in other apps; it only sees that the browser lost focus. Word documents are not rendered by Chrome (they download), so opening one in Word shows up as BROWSER_LOST_FOCUS.
The shared secret is readable by anyone with the extension files. Treat webhook data as indicative, not tamper-proof.
Focus-based flags can false-positive (notifications stealing focus, Google Forms file-upload picker windows, clicking the address bar). Review flags with human judgment rather than auto-penalising.
Incognito and file:// detection require the per-extension toggles in step 5.
5. Privacy

This is designed to be transparent and minimal: monitoring only runs during a quiz session; a visible banner and the popup show students exactly what is logged; URLs are stored without query strings, local files by filename only (no folder paths); the contents of other tabs and pages are never read. Tell students (and, where required, get consent / follow your institution's policy) before using it.
