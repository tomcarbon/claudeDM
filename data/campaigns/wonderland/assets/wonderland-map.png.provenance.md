---
asset: wonderland-map.png
role: unknown
provider: unrecorded
model: unrecorded
prompt: unrecorded
seed: unrecorded
license: UNRESOLVED — see body
reviewed_by: []
---

# Provenance — `wonderland-map.png`

**This note records the absence of provenance, not the provenance.** It exists because
`docs/handoff-format.md` requires a sibling note for every generated asset and
`projects/claudeDM-company/LICENSES.md` §3.5 records that not one asset in this project has one.

## What is known

- This file is a byte-identical copy of `client/src/assets/wonderland-map.png`, made on 2026-09-01
  under work order WO-0004.3 so that the scene-imagery asset route could serve it. The original was
  **copied, not moved**: `client/src/components/WonderlandMap.jsx` still imports it and the
  `/world-map` page is unchanged.
- The original was present in the repository before the company began work on it.

## What is not known

Who or what produced the image, under which provider's terms, with which model, from which prompt,
and who owns the output. `LICENSES.md` §3.5 states this plainly and §A.3 records the provenance of
the project's generated images as **"unrecoverable from the repository. It was never recorded."**

## Who owns the question

**Compliance & Licensing.** `LICENSES.md` recommendation 10 asks for either provenance notes for
these assets or an explicit record that the provenance is lost and they are being kept anyway. This
note is the second of those two, written for one asset by the developer who copied it; it is not a
licensing determination and the Software Developer is not competent to make one.

ADR 0002 §9c routes provenance for the eight maps to Compliance & Licensing as part of the
migration that WO-0004.3 deliberately does not perform.

## Why it matters more here than it did before

`LICENSES.md` §3.5 was written when this image appeared only on the `/world-map` page. Under
ADR 0002 the same image can now be placed by the DM into a shared, persisted session transcript
that other people read. `ETHICS.md` Review 2 §R6.3 calls that "a difference of degree, not of kind"
and notes that exposure to other people is already permitted under decision `0005` — while asking
that a migration not quietly ship images with no provenance note *because* it is a migration.
This note is the answer to that ask for this one file.
