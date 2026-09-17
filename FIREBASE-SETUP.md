# Firebase Setup (already completed)

The Firebase side is **done**. This file records what exists so the implementation
can target it, and so it can be rebuilt if the project is ever lost.

## Project

| | |
|---|---|
| Project name | `dnd-scheduler` |
| Project ID | `dnd-scheduler-6d2eb` |
| Project number | `914447220713` |
| Plan | Spark (free, no billing account attached) |
| Database | Cloud Firestore, `(default)`, Standard edition |
| Services in use | Firestore only |

Authentication, Cloud Functions, and Cloud Storage are **not** enabled and are not
needed. Cloud Storage requires the paid Blaze plan as of February 2026; the design
avoids it deliberately.

A Firebase Hosting site (`dnd-scheduler-6d2eb`) was auto-created during web app
registration. It is unused and costs nothing. **Do not deploy to it** — GitHub Pages
is the host. Do not add `firebase.json`, `.firebaserc`, or the Firebase CLI to the repo.

## Config

See `firebase-config.js` in this directory — drop it into the repo as-is.

It is safe to commit publicly. `apiKey` is a project identifier, not a secret, and
Google documents it as such. Security rules are the actual access control. Do not
introduce a build step, `.env` file, or secret-injection scheme to hide it.

## Data model

**`roster/{playerId}`** — seeded by hand in the console, read-only to the page.
`playerId` is the lowercased name.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `order` | number | 1-6, controls display order |
| `veto` | boolean | `true` for exactly one player |

**`slots/{slotId}`** — `slotId` is `${date}-${startMinutes}-${endMinutes}`.

```js
{ label: "Fri, Oct 3 • 6:00 PM – 9:00 PM",
  order: 1759536000000,      // date epoch ms + startMinutes*60000
  date: "2026-10-03",
  month: "2026-10",
  start: 1080,               // minutes since midnight
  end: 1260 }
```

**`responses/{playerId}`**

```js
{ name: "Breckon",
  votes: { "<slotId>": 0 | 1 | 2 },   // 0 = Can't, 1 = Can make it work, 2 = Works
  updatedAt: 1759536000000 }
```

## Security rules (published)

These are live on the project. If they need to change, edit here and re-publish from
the Firestore console's Rules tab.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /roster/{playerId} {
      allow read: if true;
      allow write: if false;
    }

    match /slots/{slotId} {
      allow read: if true;
      allow create, update: if request.resource.data.keys().hasAll(
            ['label','order','date','month','start','end'])
        && request.resource.data.label is string
        && request.resource.data.label.size() < 200
        && request.resource.data.order is number
        && request.resource.data.date is string
        && request.resource.data.month is string
        && request.resource.data.start is number
        && request.resource.data.end is number;
      allow delete: if true;
    }

    match /responses/{playerId} {
      allow read: if true;
      allow write: if exists(/databases/$(database)/documents/roster/$(playerId))
        && request.resource.data.votes is map
        && request.resource.data.votes.values().hasOnly([0, 1, 2]);
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Never replace these with `allow read, write: if true;`. A public URL with open rules
invites quota-burning abuse.

## Quota headroom

Spark allows 50,000 Firestore reads and 20,000 writes per day. Six players voting on
a few dozen slots runs in the low hundreds of reads per day. Exceeding a Spark cap
suspends service until the daily reset rather than generating a bill.

Implementations should still avoid gratuitous reads — use `onSnapshot` listeners
rather than polling, and do not re-fetch collections the listener already provides.

## Known limitation, accepted

Without Firebase Auth, rules validate the *shape* of a write, not the identity of the
writer. Anyone with the URL could, using devtools, write votes as any roster member.

This is accepted. Adding real auth would require six Google sign-ins, which defeats
the no-accounts requirement that motivated this port. Do not "fix" this by adding an
auth provider.
