# Brief: Port D&D Scheduler to GitHub Pages + Firestore

## Objective

Port an existing single-file scheduling poll from Anthropic's artifact runtime to a
statically-hosted page on GitHub Pages, backed by Cloud Firestore. The current version
only works for signed-in members of a single Claude organization; the ported version must
be openable by six people with a plain URL and no accounts.

This directory contains:

- `BRIEF.md` — this file
- `FIREBASE-SETUP.md` — the provisioned backend: project IDs, data model, live rules
- `firebase-config.js` — drop into the repo unchanged
- `reference-current-version.html` — the working current version

The reference file's UI,
scoring, and ranking logic are correct and should be preserved. **Only the persistence
layer changes.** Do not redesign the interface.

## Non-negotiable requirements

1. Six named players vote on candidate time slots; results aggregate live across viewers.
2. No login, no accounts, no email invites. A URL is the only access mechanism.
3. Works on mobile browsers (most voting will happen on phones).
4. Free to run at this scale, and must not go offline during idle periods.
5. Player names must not appear in the repository source.

## Platform decision (already made — implement, don't relitigate)

**Firestore on the Firebase Spark (free) plan, page served from GitHub Pages.**

Rationale, since the obvious alternative will come up:

| | Firestore (Spark) | Supabase (Free) |
|---|---|---|
| Idle behavior | No inactivity pause | Project pauses after 7 days without DB activity; manual restore required |
| Free quota | 50k reads / 20k writes per day | 500 MB DB, 5 GB egress |
| Realtime | `onSnapshot`, native | Realtime channels |
| Fit here | Good | Requires a keepalive cron to stay reachable |

The workload is a poll that may sit untouched for two weeks between sessions. Supabase's
pause is disqualifying without a keepalive job, which is infrastructure this project
should not need. Usage here is on the order of tens of reads per day against a 50k
daily allowance.

## Architecture

```
GitHub repo (public)          Firebase project (free)
├── index.html          ──▶   Firestore
├── app.js                    ├── roster/{playerId}
├── styles.css                ├── slots/{slotId}
└── firebase-config.js        └── responses/{playerId}
     (supplied, commit as-is)
```

Project ID `dnd-scheduler-6d2eb`, already provisioned and seeded — see
`FIREBASE-SETUP.md`. Served at `https://<user>.github.io/<repo>/`. No build step, no
bundler, no framework. Import the Firebase SDK via ES module CDN imports, pinned to an
explicit version. Keep it a static site.

## Data model

Preserve the current shapes so the logic ports cleanly.

**`roster/{playerId}`** — seeded once by hand, never written by the page.
```js
{ name: "Breckon", order: 2, veto: false }   // exactly one player has veto: true
```
`playerId` is the lowercased, slugified name.

**`slots/{slotId}`** — `slotId` is `${date}-${startMinutes}-${endMinutes}`.
```js
{ label: "Fri, Oct 3 • 6:00 PM – 9:00 PM",
  order: 1759536000000,   // date epoch ms + startMinutes*60000, used for sorting
  date: "2026-10-03", month: "2026-10", start: 1080, end: 1260 }
```

**`responses/{playerId}`**
```js
{ name: "Breckon", votes: { "<slotId>": 0 | 1 | 2 }, updatedAt: 1759536000000 }
```
Vote scale: 0 = Can't, 1 = Can make it work, 2 = Works.

## Logic to preserve exactly

Port these verbatim in behavior. They are settled; do not "improve" them.

**Scoring.** A slot's average is the sum of all six players' scores divided by 6. A player
who has not voted on a slot contributes 1 (neutral). The denominator is always the roster
size, never the number of respondents — this is deliberate, so a slot with one
enthusiastic vote cannot outrank a fully-voted slot.

**Ranking**, in strict order of precedence:
1. Any slot where the veto player voted 0 sinks to the absolute bottom, regardless of score.
2. Otherwise tier by count of explicit 0 votes, ascending: all slots with zero 0s, then
   those with exactly one, then two, and so on. A non-vote is not a 0 and never moves a
   slot into a worse tier.
3. Within a tier, sort by average descending.
4. Chronological (`slot.order` ascending) as final tiebreak.

**Results display.** Per slot: the label, a tier badge, the average to two decimals, the
vote count as `n/6`, and four named groups — Works / Can make it work / Can't / No vote —
each listing player names. Every roster member appears in exactly one group on every slot,
whether or not they have ever opened the page.

**Slot deletion.** Confirm via an in-page modal (not `window.confirm`), warn how many
people have already voted, and on confirm strip that `slotId` from every `responses`
document before deleting the slot document.

**Month scoping.** A month picker filters slot management, voting, and results to the
selected month. Persist the selection in `localStorage`.

## Name gate

Same behavior as the current version, ported as-is:

- A landing screen takes a name and admits only the six roster names, case-insensitively.
- The repo must not contain the names in plaintext. Store SHA-256 hashes of the lowercased
  names and compare using `crypto.subtle.digest`.
- Display names come from the `roster` collection at runtime, not from the source.
- Successful login persists to `localStorage` so returning players skip the gate.

The six SHA-256 hashes (of the lowercased, trimmed names) are already computed — use
these rather than regenerating them:

```js
const ALLOWED_HASHES = [
  "119fc49dcf5baba49278e04e8848055ac5ba1ef0e1fca7a72ba00ee24af7e228",
  "05aaf453cf1427269096562fd46c9a059d6894fc5971d11b7d5173dc99f65e12",
  "40806e90f61210afdd7e0fc10f59e43c7a85c27bbe14edccc636bb4e2994489e",
  "5c95c28cc040c651514ec16451b60fe668c8ffbcb82127a3f7a0885598c39414",
  "4d30c878c44ec3d52deb0318ae71d9a9b7a91391a46a9d704697570af06426f0",
  "f89767726a7827c6f785b40aee1ca2ade74d951d6a2d50e27cc0f0e5072a12b2"
];
```

To regenerate one for a new player:
`printf '%s' "newname" | tr 'A-Z' 'a-z' | shasum -a 256`

**State this plainly in the README:** this is not authentication. It keeps the party
roster out of the repo and stops a stranger with the URL from casually voting. Anyone
determined can read the Firestore data directly. That is an accepted tradeoff — do not
add auth to "fix" it, and do not overstate the protection in comments or UI copy.

## Firestore security rules

The page has no authenticated users, so rules are the only control. Lock writes to the
known shape rather than leaving the database open:

- `roster/*` — read: true, write: false (seeded from the console only).
- `slots/*` — read: true; create/delete allowed; validate that the document has the
  expected fields and correct types.
- `responses/*` — read: true; write allowed only for a document ID already present in
  `roster`, with `votes` values constrained to 0, 1, or 2.

Do not ship `allow read, write: if true;`. Reject any suggestion to leave it open because
"it's just a small group" — open rules on a public URL invite quota-burning abuse.

## Firebase: already provisioned

**Do not create a Firebase project.** It exists, the database is live, the roster is
seeded, and the security rules are published. See `FIREBASE-SETUP.md` for the project
details, data model, and the exact rules in force.

Use `firebase-config.js` from this directory verbatim. It is safe to commit publicly —
`apiKey` is a project identifier, not a secret, and the security rules are the real
access control. Do not add a build step, `.env` file, or secret-injection scheme to
hide it, and do not add the Firebase CLI, `firebase.json`, or `.firebaserc` to the repo.

Import the Firebase SDK via ES module CDN imports (`firebase/app` and
`firebase/firestore` from gstatic), pinned to an explicit version.

What remains for the README, written for someone returning in a year:

1. How to run the site locally (any static file server; note that ES modules will not
   load from `file://`).
2. How to add or change a player: create a `roster` document in the console, then
   regenerate the name hash and add it to the gate list. Include the exact hashing
   command.
3. How to enable GitHub Pages: repository settings, Pages, deploy from the default
   branch, root directory.
4. A plain statement of what the name gate is and is not (see below).

## Explicit non-goals

- No build tooling, package.json, bundler, or framework.
- No authentication provider.
- No calendar integration, email, or notifications.
- No visual redesign. Carry over the existing stylesheet, including its light/dark
  handling via `prefers-color-scheme`.

## Verification before declaring done

- Two browsers open simultaneously: a vote in one appears in the other without reload.
- A player who has never opened the page still appears under "No vote" on every slot.
- A slot where the veto player voted 0 ranks last even when everyone else voted 2.
- A slot with one lone "Works" vote scores 1.17, not 2.00.
- Deleting a slot removes it from every player's stored votes.
- Firestore rules reject a write to `responses/notaplayer` and a `votes` value of 5.
- Renders correctly on a phone-width viewport.
