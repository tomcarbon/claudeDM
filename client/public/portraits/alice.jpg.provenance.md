---
asset: alice.jpg
role: chair-human-tom          # NOT image-creation — see Authorship below
provider: UNKNOWN — chair to fill
model: UNKNOWN — chair to fill
prompt: |
  UNKNOWN — chair to fill, or record "not retained" if it wasn't kept.
seed: unknown
license: BLOCKED ON `provider` — see Why this matters
reviewed_by: [ethics-safety-officer, compliance-licensing]
status: incomplete
created: 2026-08-31 (file mtime; chair to confirm)
---

# Provenance — `alice.jpg`

## Authorship

**Made by Tom, human chair, who ran the prompts himself** (stated 2026-09-20). This note exists
because the file had **no provenance at all** until now, which is what Compliance & Licensing failed
it on under WO-0031 — not the picture, the absence of a record. `docs/handoff-format.md:118` requires
a sibling note for every generated asset; `wonderland-map.png` has one, this did not.

The `role:` field is the chair rather than `image-creation` on purpose. The company never generated
this: no image provider has ever been approved (`config/providers.yaml` — every entry is
`status: candidate`, every `selected:` is `null`), and the company's `new-provider` gate has never
been crossed. The chair made it personally, outside the company's tooling. **That is not a
violation** — the gate governs what the company may do, and it did nothing. It is recorded because
the output is now inside a product the company intends to sell (decision `0008`), which makes the
tool's terms the company's problem even though the tool was never the company's.

## Why this matters, in one line

**Whether this image may ship in a paid product depends on the terms of whichever tool produced it**,
and several common tools condition commercial use on the account tier rather than on the tool — the
same model on a free plan and a paid plan can carry different rights to the same output.

## Open — three facts only the chair has

1. **Which tool**, and the model if it is known.
2. **Which account tier** it was run on at the time, and whether that tier permitted commercial use.
3. **The prompt**, if it was kept. "Not retained" is a perfectly good answer and should be written
   down as one rather than left blank — a blank field reads as an oversight to the next auditor,
   and this note exists precisely because a blank was read that way.

Once those are filled, Compliance & Licensing can convert its **FAIL** into a ruling. It is a named
reviewer on WO-0031 and does not need re-dispatching for this.

## Not answered here, and deliberately

**The Ethics halt (E16) is untouched by any of the above.** It was never about provenance. The
finding is that the image is not the character on the sheet — golden-brown hair, a simple black
headband, a blue dress with white pinafore and a glass key pendant, against a blonde in a wolf-pelt
hood. `records/reports/2026-09-08-ethics-human-chair-alice-portrait-halt.md`. Authorship does not
resolve a mismatch, and only the chair can lift the halt — by accepting the image as it is, by
replacing it with one matching the sheet (WO-0031's route, and the Officer's recommendation), or by
removing the `portrait` field.

Compliance also flagged a resemblance to a live commercial game property and routed it without
ruling. Independent authorship weakens that concern but does not erase it; it stays with Compliance.

## Convention note

`CLAUDE.md:229` says generated assets are not committed and their provenance notes are. This asset
**is** committed and has to be: `client/public/` is build input, served to the browser at runtime,
not a marketing asset. Compliance recommends reconciling the convention rather than rewriting
history. Flagged, not resolved — and it will recur thirteen times if the Wonderland cast is filled.
