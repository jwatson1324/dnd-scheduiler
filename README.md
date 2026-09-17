# D&D Party Scheduler

A single-page availability poll for a six-person D&D party. Players open a URL, type
their name, and rate each candidate time slot **Can't / Can make it work / Works**.
Results aggregate live across everyone viewing the page. The name is remembered on that
device until **Sign out** in the top corner, which returns to the name entry screen —
useful on a shared laptop, or when someone typed the wrong name.

Static page on GitHub Pages, Cloud Firestore for storage. No build step, no bundler,
no framework, no package manager — the files in this repository are the deployed site.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup: name gate, month picker, slot management, voting, results |
| `app.js` | All behaviour — ES module, imports the Firebase SDK from the gstatic CDN |
| `styles.css` | Stylesheet, light/dark via `prefers-color-scheme` |
| `firebase-config.js` | Firebase web config. Safe to commit — see below |
| `docs/FIREBASE-SETUP.md` | The provisioned backend: project details, data model, live security rules |
| `docs/BRIEF.md` | The spec this was built to |

## Running locally

ES modules do not load over `file://`, so opening `index.html` by double-clicking will
not work. Serve the directory over HTTP from the repository root:

```sh
python3 -m http.server 8000
# or: npx http-server -p 8000
```

Then open <http://localhost:8000/>. It talks to the same live Firestore project as the
deployed site, so votes you cast locally are real votes.

## Deploying (GitHub Pages)

Repository **Settings → Pages → Build and deployment**: source *Deploy from a branch*,
branch the default branch, folder `/ (root)` — not `/docs`, which holds the spec and
backend notes rather than the site. Save. The site appears at
`https://<user>.github.io/<repo>/` within a minute or two; every push to that branch
redeploys it.

Nothing else is needed — no Firebase CLI, no `firebase.json`, no GitHub Actions workflow.
The Firebase Hosting site that was auto-created with the project is unused; do not
deploy to it.

## Adding or changing a player

Two steps, both required. The roster lives in Firestore; the name gate lives in `app.js`.

1. **Create the roster document.** Firebase console → Firestore Database → `roster`
   collection → Add document. The document ID is the lowercased, hyphen-slugified name
   (`"Mary Ann"` → `mary-ann`), and it has three fields:

   | Field | Type | Value |
   |---|---|---|
   | `name` | string | Display name, spelled as it should appear |
   | `order` | number | Display order |
   | `veto` | boolean | `true` for exactly one player, `false` for everyone else |

   The page writes `roster` never — it is console-only, and the security rules enforce
   that. Scoring divides by the number of roster documents, so adding a seventh player
   changes every average.

2. **Add the name hash to the gate.** Hash the lowercased, trimmed name and paste the
   result into `ALLOWED_HASHES` at the top of `app.js`:

   ```sh
   printf '%s' "newname" | tr 'A-Z' 'a-z' | shasum -a 256
   ```

   (On Linux, `sha256sum` instead of `shasum -a 256`.)

To remove a player, delete their `roster` document, delete their `responses` document,
and remove their hash from `ALLOWED_HASHES`.

Display names are read from `roster` at runtime and are deliberately absent from this
repository — the source carries only hashes.

## What the name gate is, and is not

**It is not authentication.** It does two things: it keeps the party's names out of a
public repository, and it stops a stranger who stumbles onto the URL from casually
voting. That is all.

Firestore data here is world-readable by design, and the security rules validate the
*shape* of a write, not who is making it. Anyone with the URL and browser devtools can
read every vote and write votes as any roster member. That is an accepted tradeoff:
real auth would mean six sign-ins, which defeats the no-accounts requirement the whole
design exists to satisfy. Don't add an auth provider to "fix" it.

`firebase-config.js` is committed on purpose. `apiKey` is a project identifier, not a
credential — Google documents it as such — and the security rules are the actual access
control. Hiding it behind a build step or an environment variable would add tooling for
no security benefit. The hardening that *does* help is restricting the key to the
GitHub Pages origin: Google Cloud Console → APIs & Services → Credentials →
Application restrictions → HTTP referrers.

## How scoring works

Deliberate, and easy to misread as a bug:

- **Average** = sum of all six players' scores ÷ 6 (Can't = 0, Can make it work = 1,
  Works = 2). A player who has not voted on a slot counts as **1**, neutral. The
  denominator is always the roster size, never the number of respondents — so a slot
  with a single enthusiastic vote scores 1.17, not 2.00, and cannot outrank a
  fully-voted slot.
- **Ranking**, in strict order of precedence:
  1. Any slot the veto player marked Can't sinks to the absolute bottom, whatever it scored.
  2. Otherwise tier by number of explicit Can't votes, fewest first. A non-vote is not a
     Can't and never pushes a slot into a worse tier.
  3. Within a tier, higher average first.
  4. Ties break chronologically.

Every roster member appears in exactly one of Works / Can make it work / Can't / No vote
on every slot, whether or not they have ever opened the page.

Deleting a slot strips that slot from every stored response and deletes the slot in a
single batched write, so no orphaned votes can be left behind.

## Firebase

The project is provisioned, seeded, and its rules are published — see `docs/FIREBASE-SETUP.md`
for the project details, the data model, and the exact rules in force. Rules are edited
and published from the Firestore console's Rules tab; keep the copy in that file in step.

The Firebase SDK is pinned to an explicit version in the import URLs at the top of
`app.js`. To upgrade, change the version in both import lines (`firebase-app.js` and
`firebase-firestore.js`) and re-test — there is no lockfile, and an unpinned CDN URL
would let a remote change break the page without a commit.

Quota on the free Spark plan is 50,000 reads and 20,000 writes per day; six players on a
few dozen slots uses the low hundreds of reads. The page uses `onSnapshot` listeners
rather than polling, and never re-fetches a collection a listener already provides.
