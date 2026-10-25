// campaignPalettes.js — the authored palettes. DATA ONLY: numbers, the eight fixed mood keys,
// and comments. Every value is an integer; there is not one string in the exported object, and
// `validatePalette` in ../utils/palette.js enforces that (§3.1 rule 3).
//
// WO-0037 phase 1. Design: records/reports/2026-09-23-art-director-ceo-campaign-palette-and-
// dm-lighting.md revision 2, §3.1.
//
// ============================================================================================
// WHERE THIS OUGHT TO LIVE, AND WHY IT DOES NOT YET — read this before adding a palette.
//
// The design puts a palette in `data/campaigns/<id>/campaign.json` under an optional top-level
// `palette` key, because it is campaign content and should travel with the campaign. That is
// still the right home. This file is NOT a disagreement with it; it is where phase 1 could
// legally put the numbers.
//
// WO-0037's tree discipline confines this work order to `client/src/**` — nothing under
// `server/` (WO-0034/WO-0036 are in flight there) and nothing under `projects/claudeDM/data/`.
// Both of the steps needed for the designed home are outside that fence:
//   1. writing a `palette` key into ten campaign.json files, which is `data/`; and
//   2. adding `palette` to `summarizeCampaign` in `server/routes/campaigns.js`, because the
//      campaign LIST endpoint allowlists its keys and the client reads the campaign from that
//      list (CampaignContext). GET /api/campaigns/:id already returns the whole record, so only
//      the list summary is missing.
// Each is one line. Neither is this work order's to write.
//
// THE MIGRATION IS THEREFORE ALREADY BUILT: `paletteForCampaign()` below prefers a `palette` key
// found on the campaign record and only falls back to this table. The day those two lines land,
// campaign-authored palettes work with NO further change here, and this table becomes a
// fallback that can be emptied file by file.
// ============================================================================================
//
// HOW THESE WERE AUTHORED, so that revising them is cheap — and expect them to be revised. The
// Art Director is a named reviewer on WO-0037 precisely because it said, correctly, that it
// "cannot pass a palette I have not seen", and nobody who has not looked at these on a screen
// should claim they are good.
//
// Each family was solved, not picked: choose a hue and a saturation for the mood, then solve the
// LIGHTNESS so that the token's WCAG relative luminance hits a fixed per-token target —
//   bgDark 0.01280   bgCard 0.01800   bgSidebar 0.03000   border 0.02650
// — and round to integers in a way that preserves the hue. Every one of the 24 families below is
// therefore luminance-identical to every other, and to the shipped Forest family, to within
// 0.00006. That is stronger than the windows in §4.2 require and it is the whole trick: a
// campaign may change the page's COLOUR but not its BRIGHTNESS.
//
// The bgSidebar target of 0.03000 is chosen BELOW Forest's shipped 0.031454 on purpose: it puts
// `--text-muted` on every authored sidebar at 5.65:1, against Forest's own 5.55:1, so the feature
// does not eat into the app's tightest contrast case.
//
// THESE 24 FAMILIES WERE AUTHORED UNDER THE OLD bgSidebar CEILING OF 0.0318 AND THERE IS NOW MORE
// ROOM THAN THEY USE. VP Marketing & Art Direction's 2026-09-23 ruling fixed `--text-muted` to
// `#aaa` and raised that ceiling to 0.035 (rule H-1: >= 5.3:1), about 55% more span on the token
// that carries the most saturation. Raising the sidebar target is therefore the obvious first
// revision, and it is ONE LINE in the solver recorded in the WO-0037 deliverable: change the
// bgSidebar target from 0.03000 to anything up to about 0.0330 and re-emit. It was left at 0.03000
// here because the Art Director has not seen these on a screen yet and a reviewer should be
// judging colours, not a change made on their behalf while they were not looking. 0.0330 keeps
// H-1 at 5.51:1 with quantisation, which the test suite checks.
//
// The per-token saturation profile (bgDark .23, bgCard .27, bgSidebar .44, border .25, scaled by
// a per-mood multiplier) is lifted from the relationship the Forest family already has between
// its own four tokens, so a new family sits in the layout the way the old one did.
//
// TO REVISE A COLOUR: edit the triple. The test suite re-checks the window, the no-strings rule
// and the §4.3 convexity property over whatever is here, so a bad edit fails `npm test` rather
// than shipping. To revise a WHOLE FAMILY at a new hue, the solver is recorded in the WO-0037
// deliverable report; it is twenty lines of arithmetic and does not need to live in the app.
//
// `calm` is the campaign's resting family and is spelled `base`. It is not repeatable under
// `moods` — the validator rejects `moods.calm` — because two places to state the resting family
// is two places to disagree.
//
// A campaign with no entry here and no `palette` key gets NOTHING: the app renders exactly as it
// does today, Forest, and the whole feature is inert for it. There is deliberately no shared
// default family for palette-less campaigns; a default that applies across campaigns is
// precisely how the fire campaign ends up green (§3.1).

export const CAMPAIGN_PALETTES = {
  // ---------------------------------------------------------------------------
  // campaign5 — Realm of Eternal Flame
  campaign5: {
    version: 1,
    // calm === base. The resting family: banked embers, warm and low — the resting state.
    base: {
      bgDark:    [ 36, 28, 25],   // #241c19  L 0.01276
      bgCard:    [ 46, 34, 27],   // #2e221b  L 0.01804
      bgSidebar: [ 66, 43, 32],   // #422b20  L 0.02990
      border:    [ 57, 42, 35],   // #392a23  L 0.02647
    },
    moods: {
      // travel: an ash plain under a brass sky
      travel: {
        bgDark:    [ 34, 29, 23],   // #221d17  L 0.01281
        bgCard:    [ 43, 35, 28],   // #2b231c  L 0.01799
        bgSidebar: [ 60, 46, 29],   // #3c2e1d  L 0.03003
        border:    [ 52, 44, 35],   // #342c23  L 0.02653
      },
      // court: the efreeti court: violet-black, cold formality inside the heat
      court: {
        bgDark:    [ 35, 27, 38],   // #231b26  L 0.01281
        bgCard:    [ 42, 33, 49],   // #2a2131  L 0.01802
        bgSidebar: [ 63, 39, 74],   // #3f274a  L 0.03002
        border:    [ 53, 41, 58],   // #35293a  L 0.02648
      },
      // levity: firelight amber, generous
      levity: {
        bgDark:    [ 34, 29, 22],   // #221d16  L 0.01277
        bgCard:    [ 41, 36, 24],   // #292418  L 0.01799
        bgSidebar: [ 58, 47, 23],   // #3a2f17  L 0.02994
        border:    [ 50, 45, 30],   // #322d1e  L 0.02649
      },
      // mystery: smoke-violet, unreadable
      mystery: {
        bgDark:    [ 36, 27, 35],   // #241b23  L 0.01280
        bgCard:    [ 46, 32, 45],   // #2e202d  L 0.01803
        bgSidebar: [ 66, 39, 66],   // #422742  L 0.03003
        border:    [ 54, 41, 55],   // #362937  L 0.02646
      },
      // stark: cooling basalt and black obsidian — near-neutral by design
      stark: {
        bgDark:    [ 31, 29, 33],   // #1f1d21  L 0.01280
        bgCard:    [ 37, 36, 39],   // #252427  L 0.01802
        bgSidebar: [ 50, 47, 56],   // #322f38  L 0.02997
        border:    [ 45, 45, 48],   // #2d2d30  L 0.02648
      },
      // dread: dried blood, desaturated
      dread: {
        bgDark:    [ 35, 28, 29],   // #231c1d  L 0.01277
        bgCard:    [ 44, 34, 34],   // #2c2222  L 0.01795
        bgSidebar: [ 65, 43, 40],   // #412b28  L 0.03005
        border:    [ 53, 43, 42],   // #352b2a  L 0.02652
      },
      // combat: oxblood — the deepest red the window allows
      combat: {
        bgDark:    [ 41, 26, 25],   // #291a19  L 0.01280
        bgCard:    [ 52, 31, 30],   // #341f1e  L 0.01804
        bgSidebar: [ 82, 33, 35],   // #522123  L 0.03003
        border:    [ 65, 38, 38],   // #412626  L 0.02650
      },
    },
  },
  // ---------------------------------------------------------------------------
  // wonderland — Madness in Wonderland
  wonderland: {
    version: 1,
    // calm === base. The resting family: treacle rose.
    base: {
      bgDark:    [ 39, 26, 33],   // #271a21  L 0.01280
      bgCard:    [ 49, 31, 42],   // #311f2a  L 0.01800
      bgSidebar: [ 73, 36, 60],   // #49243c  L 0.03004
      border:    [ 60, 39, 51],   // #3c2733  L 0.02651
    },
    moods: {
      // travel: a too-green hedgerow
      travel: {
        bgDark:    [ 24, 32, 21],   // #182015  L 0.01281
        bgCard:    [ 30, 39, 25],   // #1e2719  L 0.01797
        bgSidebar: [ 37, 53, 23],   // #253517  L 0.03001
        border:    [ 39, 48, 32],   // #273020  L 0.02650
      },
      // court: the Queen's red: hearts and painted roses
      court: {
        bgDark:    [ 40, 26, 29],   // #281a1d  L 0.01279
        bgCard:    [ 53, 30, 34],   // #351e22  L 0.01801
        bgSidebar: [ 81, 33, 41],   // #512129  L 0.02997
        border:    [ 64, 38, 43],   // #40262b  L 0.02651
      },
      // levity: tea-party yellow
      levity: {
        bgDark:    [ 32, 30, 19],   // #201e13  L 0.01283
        bgCard:    [ 38, 37, 24],   // #262518  L 0.01801
        bgSidebar: [ 53, 49, 20],   // #353114  L 0.03004
        border:    [ 50, 45, 30],   // #322d1e  L 0.02649
      },
      // mystery: cheshire teal
      mystery: {
        bgDark:    [ 23, 31, 34],   // #171f22  L 0.01278
        bgCard:    [ 25, 39, 40],   // #192728  L 0.01811
        bgSidebar: [ 27, 52, 58],   // #1b343a  L 0.02994
        border:    [ 32, 48, 50],   // #203032  L 0.02651
      },
      // stark: checkerboard slate, blue-grey
      stark: {
        bgDark:    [ 28, 30, 32],   // #1c1e20  L 0.01280
        bgCard:    [ 34, 37, 38],   // #222526  L 0.01803
        bgSidebar: [ 44, 49, 54],   // #2c3136  L 0.02998
        border:    [ 42, 46, 47],   // #2a2e2f  L 0.02651
      },
      // dread: jabberwock violet
      dread: {
        bgDark:    [ 32, 28, 38],   // #201c26  L 0.01278
        bgCard:    [ 42, 33, 49],   // #2a2131  L 0.01802
        bgSidebar: [ 59, 40, 78],   // #3b284e  L 0.02997
        border:    [ 52, 41, 61],   // #34293d  L 0.02653
      },
      // combat: off with their heads
      combat: {
        bgDark:    [ 39, 27, 24],   // #271b18  L 0.01281
        bgCard:    [ 48, 33, 28],   // #30211c  L 0.01800
        bgSidebar: [ 74, 39, 30],   // #4a271e  L 0.03001
        border:    [ 59, 41, 37],   // #3b2925  L 0.02649
      },
    },
  },
  // ---------------------------------------------------------------------------
  // reckoning — A Winter at the Reckoning House
  reckoning: {
    version: 1,
    // calm === base. The resting family: lamplight on wet wool.
    base: {
      bgDark:    [ 33, 29, 26],   // #211d1a  L 0.01277
      bgCard:    [ 40, 36, 29],   // #28241d  L 0.01802
      bgSidebar: [ 56, 47, 35],   // #382f23  L 0.02995
      border:    [ 48, 45, 38],   // #302d26  L 0.02645
    },
    moods: {
      // travel: snow-light, blue shadow
      travel: {
        bgDark:    [ 28, 30, 32],   // #1c1e20  L 0.01280
        bgCard:    [ 33, 37, 40],   // #212528  L 0.01800
        bgSidebar: [ 38, 50, 58],   // #26323a  L 0.02999
        border:    [ 40, 46, 52],   // #282e34  L 0.02653
      },
      // court: the drawing room: dark mahogany
      court: {
        bgDark:    [ 33, 29, 27],   // #211d1b  L 0.01281
        bgCard:    [ 39, 36, 32],   // #272420  L 0.01797
        bgSidebar: [ 58, 46, 39],   // #3a2e27  L 0.03000
        border:    [ 51, 44, 39],   // #332c27  L 0.02652
      },
      // levity: the kitchen, the fire lit
      levity: {
        bgDark:    [ 31, 30, 23],   // #1f1e17  L 0.01282
        bgCard:    [ 40, 36, 28],   // #28241c  L 0.01797
        bgSidebar: [ 55, 48, 27],   // #37301b  L 0.03005
        border:    [ 49, 45, 35],   // #312d23  L 0.02651
      },
      // mystery: dusk through a window
      mystery: {
        bgDark:    [ 27, 30, 35],   // #1b1e23  L 0.01283
        bgCard:    [ 34, 36, 46],   // #22242e  L 0.01799
        bgSidebar: [ 41, 48, 68],   // #293044  L 0.03003
        border:    [ 42, 45, 56],   // #2a2d38  L 0.02655
      },
      // stark: the cold end of the house: bare plaster, warm-neutral
      stark: {
        bgDark:    [ 29, 30, 29],   // #1d1e1d  L 0.01278
        bgCard:    [ 38, 36, 36],   // #262424  L 0.01801
        bgSidebar: [ 50, 48, 47],   // #32302f  L 0.02997
        border:    [ 46, 45, 45],   // #2e2d2d  L 0.02647
      },
      // dread: the dread here is social — barely there, and red
      dread: {
        bgDark:    [ 32, 29, 30],   // #201d1e  L 0.01280
        bgCard:    [ 41, 35, 36],   // #292324  L 0.01801
        bgSidebar: [ 58, 45, 49],   // #3a2d31  L 0.02998
        border:    [ 52, 43, 45],   // #342b2d  L 0.02647
      },
      // combat: it has become physical
      combat: {
        bgDark:    [ 38, 27, 28],   // #261b1c  L 0.01280
        bgCard:    [ 49, 32, 33],   // #312021  L 0.01796
        bgSidebar: [ 75, 38, 35],   // #4b2623  L 0.03003
        border:    [ 61, 40, 39],   // #3d2827  L 0.02656
      },
    },
  },
};

// The campaign's palette, if it has one. Prefers a `palette` key on the campaign record — the
// designed home (§3.1) — and falls back to the table above. Returns null when the campaign has
// neither, which is the inert case.
//
// `campaign` is whatever CampaignContext holds: today the summary from GET /api/campaigns, which
// does not carry `palette`. Passing it costs nothing and is what makes the migration a two-line
// change elsewhere rather than a change here.
export function paletteForCampaign(campaignId, campaign = null) {
  if (campaign && campaign.palette) return campaign.palette;
  if (!campaignId) return null;
  return Object.prototype.hasOwnProperty.call(CAMPAIGN_PALETTES, campaignId)
    ? CAMPAIGN_PALETTES[campaignId]
    : null;
}
