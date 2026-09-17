// D&D Party Scheduler — static page, Cloud Firestore backend.
//
// Ported from an Anthropic artifact (spec in docs/BRIEF.md; the pre-port original is
// in this repository's git history). The UI, scoring, and ranking behaviour are
// unchanged from that version; only the persistence layer differs:
// `claude.use("db")` is replaced with the Firestore web SDK, loaded straight from
// the gstatic CDN at a pinned version. No build step, no bundler, no framework.
//
// The name gate below is NOT authentication. It keeps the party roster out of this
// public repository and stops a stranger with the URL from casually voting. Firestore
// data is world-readable by design and anyone determined can read or write it with
// devtools. That is an accepted tradeoff — see README.md.

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// SHA-256 hashes of allowed player names (lowercased, trimmed) -- not stored as plaintext.
const ALLOWED_HASHES = [
  "119fc49dcf5baba49278e04e8848055ac5ba1ef0e1fca7a72ba00ee24af7e228",
  "05aaf453cf1427269096562fd46c9a059d6894fc5971d11b7d5173dc99f65e12",
  "40806e90f61210afdd7e0fc10f59e43c7a85c27bbe14edccc636bb4e2994489e",
  "5c95c28cc040c651514ec16451b60fe668c8ffbcb82127a3f7a0885598c39414",
  "4d30c878c44ec3d52deb0318ae71d9a9b7a91391a46a9d704697570af06426f0",
  "f89767726a7827c6f785b40aee1ca2ade74d951d6a2d50e27cc0f0e5072a12b2"
];

const NAME_KEY = "dnd_scheduler_name";
const MONTH_KEY = "dnd_scheduler_month";

let db = null;
let slots = [];
let roster = [];
let responses = {};
let currentVotes = {};
let currentName = "";
let selectedMonth = "";
let unsavedVotes = false;   // guards in-progress votes against live snapshots
let unsubscribes = [];      // live Firestore listeners, dropped on sign-out
let wired = false;          // one-time DOM listener wiring

const VOTE_LEVELS = [
  { key: "cant", label: "Can't", score: 0, cls: "active-cant" },
  { key: "maybe", label: "Can make it work", score: 1, cls: "active-maybe" },
  { key: "works", label: "Works!", score: 2, cls: "active-works" }
];

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function slugName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeOptions() {
  const opts = [];
  for (let mins = 0; mins < 24 * 60; mins += 30) {
    let h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h < 12 ? "AM" : "PM";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    const label = `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
    opts.push({ value: mins, label });
  }
  return opts;
}
const TIME_OPTS = timeOptions();

function populateTimeSelects() {
  const startSel = document.getElementById("newSlotStart");
  const endSel = document.getElementById("newSlotEnd");
  startSel.innerHTML = TIME_OPTS.map(o => `<option value="${o.value}">${o.label}</option>`).join("");
  endSel.innerHTML = TIME_OPTS.map(o => `<option value="${o.value}">${o.label}</option>`).join("");
  startSel.value = 18 * 60;       // default 6:00 PM
  endSel.value = 21 * 60;         // default 9:00 PM
}

function minsToLabel(mins) {
  return TIME_OPTS.find(o => o.value === Number(mins))?.label || "";
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- Gate ----------
async function tryLogin(name) {
  const errEl = document.getElementById("gateError");
  const trimmed = (name || "").trim();
  if (!trimmed) { errEl.textContent = "Enter a name."; return; }
  const hash = await sha256Hex(trimmed.toLowerCase());
  if (!ALLOWED_HASHES.includes(hash)) {
    errEl.textContent = "That name isn't recognized.";
    return;
  }
  currentName = trimmed;
  localStorage.setItem(NAME_KEY, trimmed);
  showApp();
}

function showApp() {
  document.getElementById("gateError").textContent = "";
  document.getElementById("gateScreen").classList.add("hidden");
  document.getElementById("appScreen").classList.remove("hidden");
  document.getElementById("whoLine").textContent = currentName;
  init();
}

// Sign out: drop the live listeners, forget the name, and go back to the gate.
// Everything here is local — no Firestore write, so saved votes stay saved.
function signOut() {
  unsubscribes.forEach(unsub => unsub());
  unsubscribes = [];
  localStorage.removeItem(NAME_KEY);
  currentName = "";
  currentVotes = {};
  unsavedVotes = false;
  slots = [];
  roster = [];
  responses = {};

  document.getElementById("appScreen").classList.add("hidden");
  document.getElementById("gateScreen").classList.remove("hidden");
  document.getElementById("whoLine").textContent = "";
  document.getElementById("gateNameInput").value = "";
  document.getElementById("gateError").textContent = "";
  document.getElementById("slotStatus").textContent = "";
  document.getElementById("saveStatus").textContent = "";
  document.getElementById("gateNameInput").focus();
}

function fatal(message) {
  document.getElementById("appScreen").innerHTML = `<p>${message}</p>`;
}

// ---------- App ----------
function init() {
  if (!db) {
    try {
      db = getFirestore(initializeApp(firebaseConfig));
    } catch (e) {
      console.error("Firestore init failed", e);
      fatal("Couldn't reach the shared schedule. Check your connection and reload.");
      return;
    }
  }

  populateTimeSelects();

  selectedMonth = localStorage.getItem(MONTH_KEY) || currentMonthStr();
  const monthPicker = document.getElementById("monthPicker");
  monthPicker.value = selectedMonth;
  if (!wired) monthPicker.addEventListener("change", () => {
    selectedMonth = monthPicker.value;
    localStorage.setItem(MONTH_KEY, selectedMonth);
    setDateBoundsForMonth();
    renderSlotList();
    renderVoteSlots();
    renderResults();
  });
  setDateBoundsForMonth();

  unsubscribes.push(onSnapshot(collection(db, "roster"), (snap) => {
    roster = snap.docs
      .map(d => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    // Display names live in the roster, never in this repository. Once the roster
    // arrives, prefer its spelling of the signed-in player's name over what they typed.
    const me = roster.find(m => m.id === slugName(currentName));
    if (me && me.name && me.name !== currentName) {
      currentName = me.name;
      localStorage.setItem(NAME_KEY, currentName);
      document.getElementById("whoLine").textContent = currentName;
    }
    renderResults();
  }, (e) => {
    console.error("roster subscription error", e);
  }));

  unsubscribes.push(onSnapshot(collection(db, "slots"), (snap) => {
    slots = snap.docs
      .map(d => ({ id: d.id, ...(d.data() || {}) }))
      .sort((a, b) => a.order - b.order);
    renderSlotList();
    renderVoteSlots();
    renderResults();
  }, (e) => {
    console.error("slots subscription error", e);
    document.getElementById("slotList").innerHTML =
      '<div class="empty">Couldn\'t load slots. Reload the page.</div>';
  }));

  unsubscribes.push(onSnapshot(collection(db, "responses"), (snap) => {
    responses = {};
    snap.docs.forEach(d => { responses[d.id] = d.data() || {}; });
    const myId = slugName(currentName);
    // Don't let someone else's save overwrite votes this player hasn't saved yet.
    if (responses[myId] && !unsavedVotes) currentVotes = { ...(responses[myId].votes || {}) };
    renderVoteSlots();
    renderResults();
  }, (e) => {
    console.error("responses subscription error", e);
  }));

  if (!wired) {
    document.getElementById("addSlotBtn").addEventListener("click", addSlot);
    document.getElementById("saveBtn").addEventListener("click", saveVotes);
    wired = true;
  }
}

function setDateBoundsForMonth() {
  const [y, m] = selectedMonth.split("-").map(Number);
  const first = `${selectedMonth}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const last = `${selectedMonth}-${String(lastDay).padStart(2, "0")}`;
  const dateInput = document.getElementById("newSlotDate");
  dateInput.min = first;
  dateInput.max = last;
  dateInput.value = first;
}

function slotsInSelectedMonth() {
  return slots.filter(s => s.month === selectedMonth);
}

async function addSlot() {
  const statusEl = document.getElementById("slotStatus");
  const dateVal = document.getElementById("newSlotDate").value;
  const startVal = Number(document.getElementById("newSlotStart").value);
  const endVal = Number(document.getElementById("newSlotEnd").value);
  statusEl.textContent = "";

  if (!dateVal) { statusEl.textContent = "Pick a date first."; return; }
  if (!dateVal.startsWith(selectedMonth)) {
    statusEl.textContent = "That date isn't in the selected month.";
    return;
  }
  if (endVal <= startVal) {
    statusEl.textContent = "End time must be after start time.";
    return;
  }

  const label = `${fmtDateShort(dateVal)} • ${minsToLabel(startVal)} – ${minsToLabel(endVal)}`;
  const id = `${dateVal}-${startVal}-${endVal}`;
  const order = new Date(dateVal).getTime() + startVal * 60000;
  try {
    await setDoc(doc(db, "slots", id), {
      label, order, date: dateVal, month: selectedMonth, start: startVal, end: endVal
    });
    statusEl.textContent = "Slot added.";
  } catch (e) {
    console.error("add slot failed", e);
    statusEl.textContent = "Couldn't add slot — try again.";
  }
}

function confirmDialog(title, message) {
  return new Promise(resolve => {
    const overlay = document.getElementById("modalOverlay");
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalMessage").textContent = message;
    overlay.classList.remove("hidden");

    const okBtn = document.getElementById("modalOk");
    const cancelBtn = document.getElementById("modalCancel");

    function cleanup(result) {
      overlay.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) { if (e.key === "Escape") cleanup(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

async function removeSlot(id) {
  const slot = slots.find(s => s.id === id);
  const label = slot ? slot.label : "this slot";
  const voters = Object.values(responses).filter(r => r.votes && id in r.votes);
  const warning = voters.length > 0
    ? ` ${voters.length} ${voters.length === 1 ? "person has" : "people have"} already voted on it; those votes will be deleted.`
    : "";

  const ok = await confirmDialog("Remove this slot?", `${label}.${warning}`);
  if (!ok) return;

  const statusEl = document.getElementById("slotStatus");
  try {
    // Strip this slot from every stored response and delete the slot itself. One
    // batch, so a dropped connection can't leave orphaned votes behind.
    const batch = writeBatch(db);
    for (const [docId, r] of Object.entries(responses)) {
      if (!r.votes || !(id in r.votes)) continue;
      const cleaned = { ...r.votes };
      delete cleaned[id];
      batch.set(doc(db, "responses", docId), {
        name: r.name, votes: cleaned, updatedAt: Date.now()
      });
    }
    batch.delete(doc(db, "slots", id));
    await batch.commit();
    delete currentVotes[id];
    statusEl.textContent = "Slot removed.";
  } catch (e) {
    console.error("remove slot failed", e);
    statusEl.textContent = "Couldn't remove slot — try again.";
  }
}

function renderSlotList() {
  const el = document.getElementById("slotList");
  const monthSlots = slotsInSelectedMonth();
  if (monthSlots.length === 0) {
    el.innerHTML = '<div class="empty">No slots yet this month — add one below.</div>';
    return;
  }
  el.innerHTML = "";
  monthSlots.forEach(s => {
    const row = document.createElement("div");
    row.className = "slot-row";
    const labelDiv = document.createElement("div");
    labelDiv.className = "slot-row-label";
    labelDiv.textContent = s.label;
    row.appendChild(labelDiv);
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => removeSlot(s.id));
    row.appendChild(btn);
    el.appendChild(row);
  });
}

function renderVoteSlots() {
  const el = document.getElementById("voteSlots");
  const monthSlots = slotsInSelectedMonth();
  if (monthSlots.length === 0) {
    el.innerHTML = '<div class="empty">Add slots above first.</div>';
    return;
  }
  el.innerHTML = "";
  monthSlots.forEach(s => {
    const wrap = document.createElement("div");
    wrap.className = "vote-slot";
    const labelDiv = document.createElement("div");
    labelDiv.className = "vote-slot-label";
    labelDiv.textContent = s.label;
    wrap.appendChild(labelDiv);

    const btnRow = document.createElement("div");
    btnRow.className = "vote-buttons";
    VOTE_LEVELS.forEach(level => {
      const b = document.createElement("div");
      b.className = "vote-btn" + (currentVotes[s.id] === level.score ? " " + level.cls : "");
      b.textContent = level.label;
      b.addEventListener("click", () => {
        currentVotes[s.id] = level.score;
        unsavedVotes = true;
        renderVoteSlots();
      });
      btnRow.appendChild(b);
    });
    wrap.appendChild(btnRow);
    el.appendChild(wrap);
  });
}

async function saveVotes() {
  const statusEl = document.getElementById("saveStatus");
  const monthSlots = slotsInSelectedMonth();
  if (monthSlots.length === 0) {
    statusEl.textContent = "No slots to vote on this month.";
    return;
  }
  const missing = monthSlots.filter(s => !(s.id in currentVotes));
  if (missing.length > 0) {
    statusEl.textContent = `Please vote on all slots this month (${missing.length} left).`;
    return;
  }
  const id = slugName(currentName);
  try {
    await setDoc(doc(db, "responses", id), {
      name: currentName, votes: currentVotes, updatedAt: Date.now()
    });
    unsavedVotes = false;
    statusEl.textContent = "Saved.";
  } catch (e) {
    statusEl.textContent = "Couldn't save — try again.";
    console.error(e);
  }
}

// Veto players are flagged in the roster collection, not hardcoded here.

// Scoring: a slot's average is the sum of all roster members' scores over the roster
// size. A player who hasn't voted contributes 1 (neutral), so the denominator never
// shrinks to the number of respondents — one keen vote can't outrank a full house.
function scoreSlots(monthSlots, players) {
  return monthSlots.map(s => {
    const works = [], maybe = [], cant = [], novote = [];
    let total = 0, answered = 0, vetoed = false;

    players.forEach(p => {
      const r = responses[p.id];
      const v = r && r.votes ? r.votes[s.id] : undefined;
      if (v === undefined) {
        novote.push(p.name);
        total += 1;
        return;
      }
      answered++;
      total += v;
      if (v === 2) works.push(p.name);
      else if (v === 1) maybe.push(p.name);
      else {
        cant.push(p.name);
        if (p.veto) vetoed = true;
      }
    });

    const avg = players.length > 0 ? total / players.length : 0;
    return { slot: s, works, maybe, cant, novote, answered, avg,
             players: players.length, zeros: cant.length, vetoed };
  });
}

// Ranking: veto slots to the absolute bottom; otherwise tier by number of
// "Can't" votes (0 zeros first, then 1, then 2, ...), and within each tier
// sort by average score descending, then chronologically.
function rankRows(rows) {
  return rows.sort((a, b) => {
    if (a.vetoed !== b.vetoed) return a.vetoed ? 1 : -1;
    if (a.zeros !== b.zeros) return a.zeros - b.zeros;
    if (b.avg !== a.avg) return b.avg - a.avg;
    return a.slot.order - b.slot.order;
  });
}

function renderResults() {
  const el = document.getElementById("resultsTable");
  const respLine = document.getElementById("respondentsLine");
  const monthSlots = slotsInSelectedMonth();

  // Every roster member is counted, whether or not they've ever opened the page.
  const players = roster.length > 0
    ? roster.map(m => ({ id: m.id, name: m.name, veto: !!m.veto }))
    : Object.entries(responses).map(([id, r]) => ({ id, name: r.name, veto: false }));

  const votedNames = players
    .filter(p => responses[p.id] && responses[p.id].votes
      && monthSlots.some(s => s.id in responses[p.id].votes))
    .map(p => p.name);
  respLine.textContent = votedNames.length
    ? `Voted this month: ${votedNames.join(", ")} (${votedNames.length}/${players.length})`
    : `No votes yet this month (0/${players.length}).`;

  if (monthSlots.length === 0) {
    el.innerHTML = '<div class="empty">Add slots and get votes to see results.</div>';
    return;
  }

  const rows = rankRows(scoreSlots(monthSlots, players));

  let html = "";
  rows.forEach((r, i) => {
    const isTop = i === 0 && r.answered > 0 && !r.vetoed;
    const tierLabel = r.vetoed
      ? "Vetoed"
      : r.zeros === 0
        ? "All clear"
        : `${r.zeros} can't`;
    const tierCls = r.vetoed ? "tier-veto" : r.zeros === 0 ? "tier-clear" : "tier-partial";

    html += `<div class="result-card${isTop ? " top" : ""}">
      <div class="result-head">
        <div class="result-title">${escapeHtml(r.slot.label)}</div>
        <span class="tier ${tierCls}">${tierLabel}</span>
      </div>
      <div class="result-avg">Avg ${r.avg.toFixed(2)} / 2.00
        <span class="result-count">(${r.answered}/${r.players} voted)</span>
      </div>
      ${voterGroup("Works", r.works, "g-works")}
      ${voterGroup("Can make it work", r.maybe, "g-maybe")}
      ${voterGroup("Can't", r.cant, "g-cant")}
      ${voterGroup("No vote", r.novote, "g-novote")}
    </div>`;
  });
  el.innerHTML = html;
}

function voterGroup(label, names, cls) {
  if (names.length === 0) return "";
  return `<div class="vgroup">
    <span class="vlabel ${cls}">${label}</span>
    <span class="vnames">${escapeHtml(names.join(", "))}</span>
  </div>`;
}

// Labels and names come from Firestore, which anyone with the URL can write to.
// Escape them rather than trusting them in innerHTML.
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------- Boot ----------
document.getElementById("gateSubmitBtn").addEventListener("click", () => {
  tryLogin(document.getElementById("gateNameInput").value);
});
document.getElementById("signOutBtn").addEventListener("click", signOut);
document.getElementById("gateNameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryLogin(document.getElementById("gateNameInput").value);
});

const savedName = localStorage.getItem(NAME_KEY);
if (savedName) {
  sha256Hex(savedName.trim().toLowerCase()).then(h => {
    if (ALLOWED_HASHES.includes(h)) {
      currentName = savedName;
      showApp();
    }
  });
}
