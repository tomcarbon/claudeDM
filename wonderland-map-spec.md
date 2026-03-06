# Wonderland Map — Art Specification for AI Image Generation

## Overview

This is a fantasy world map for the D&D 5e campaign **"Madness in Wonderland"** — a dark whimsical reimagining of Alice in Wonderland as a Feywild demiplane. The map should feel like a hand-illustrated storybook map crossed with a classic fantasy RPG overworld, rendered in a vivid, slightly unsettling art style that balances beauty with menace. Think Arthur Rackham meets classic D&D cartography, with saturated colors and surreal geography.

The map dimensions should be roughly **1200×800 pixels** (landscape orientation, 3:2 aspect ratio), matching the existing maps in the application.

---

## Overall Composition & Geography

The map depicts **Wonderland from above** — a self-contained demiplane with no ocean edges or conventional borders. Instead, the edges of the map dissolve into swirling, kaleidoscopic mist in playing-card suit patterns (hearts, diamonds, clubs, spades) — suggesting that Wonderland simply *ends* where logic gives up. The sky above (visible in background washes) shifts between a chess-board pattern of pale blue and lavender squares, with faint playing-card suits drifting like clouds.

The geography flows **from top to bottom** in a loose progression that mirrors the campaign's narrative arc:

**Top third — The Rabbit Warren & Pool of Tears (entry zone):**
The upper portion of the map shows the underground-turned-overground entry to Wonderland. A massive rabbit hole spirals downward from the top-center edge of the map like a whirlpool in the earth, surrounded by scattered oversized playing cards and tiny doors half-buried in hillsides. Below the rabbit hole, a network of winding tunnels and impossible corridors is depicted in cross-section (a classic storybook cutaway), showing the Hall of Doors — a corridor lined with doors of wildly different sizes, with a tiny glass table visible inside. To the left of the warren, the **Pool of Tears** spreads as an irregularly-shaped saltwater lake with a pale blue-green surface, its shores dotted with strange creatures running in circles (the Caucus Race). A giant mushroom — easily the size of a house — rises from the near shore, with a hookah-smoking caterpillar silhouette perched atop it, wreathed in curling blue-purple smoke. Scattered "DRINK ME" bottles and "EAT ME" cakes are illustrated as tiny decorative elements around the warren entrance.

**Left-center — The Tulgey Wood & Cheshire Reaches:**
A vast, dark forest dominates the left and center-left of the map. The trees are enormous, gnarled, and clearly *alive* — their trunks have bark patterns that suggest faces (eyes, mouths, furrowed brows), and their branches reach and twist like grasping fingers. The canopy is dense and dark, rendered in deep greens, teals, and shadow-purples, with shafts of eerie golden-green light breaking through in places. Paths wind through the wood but visibly fork, loop back on themselves, and contradict — some paths are drawn as dotted lines that simply stop or reverse direction, emphasizing the impossible navigation. Deep in the forest (toward the lower-left), the trees grow darker and more menacing, with broken branches and claw marks visible on trunks — this is Jabberwock territory, and a faint dragon-like silhouette with wings and burning eyes can be glimpsed between the deepest trees. Near the center of the wood, the **Cheshire Cat's grin** floats disembodied among the branches — just the wide, crescent-moon smile with gleaming teeth, no body, hovering in midair with faint purple-pink luminescence. A crossroads near the wood's edge has a signpost with arms pointing in every direction, labeled with contradictory destinations.

**Right-center — The Mad Tea Quarter:**
To the right of the Tulgey Wood, the landscape shifts to a surreal township frozen in amber-gold light. The entire quarter is bathed in the warm, honeyed glow of perpetual 6 o'clock teatime. A massive **Broken Clock Tower** rises as the district's landmark — a tall brass-and-mahogany structure with an enormous clock face frozen at exactly 6:00, its hands visibly fused in place by growths of amber crystal. Around the tower, a long tea table stretches improbably far — far longer than any table should be — laden with teacups, teapots, and crumbling scones, with tiny figures seated along its length (the Hatter's tall top hat, the March Hare's ears, the sleeping Dormouse). Clocks are *everywhere* in this quarter — embedded in cobblestones, growing from flower beds like mechanical flowers, mounted on lampposts and trees — all frozen at six. The buildings have a tilted, slightly off-kilter quality, like a town drawn by someone who almost remembers what buildings look like. Translucent, ghost-like figures (temporal echoes) drift through the streets. The color palette here is warm amber, gold, dusty rose, and aged cream — beautiful but static, like a photograph of a moment that will never end.

**Bottom third — The Queen's Domain:**
The lower portion of the map is dominated by the **Palace of Hearts** — a grand, imposing structure of crimson stone with heart-shaped battlements, towers topped with heart finials, and walls of deep red that seem to pulse with authority. The palace sits at the center of meticulously manicured grounds: geometric hedge mazes with paths so precise they look ruler-drawn, croquet lawns of impossible emerald green, and rose gardens where some bushes clearly show white roses being painted red (tiny card-soldier figures with paintbrushes can be spotted). Card-soldier patrols march in rigid formation along the paths — depicted as playing cards with arms and legs, carrying halberds and spears. The **croquet ground** is visible as a flat green expanse with flamingo-shaped mallets and hedgehog-shaped balls scattered about. Leading up to the palace, a grand red-carpeted avenue is flanked by rows of card-soldiers standing at attention. Beneath the palace (shown in subtle cross-section or suggested by a glowing crack in the earth), the **Looking Glass Chamber** glimmers — a shattered mirror radiating fracture-lines of silver-white light, hinting at the gateway between Wonderland and the material plane. The Queen herself is not depicted, but her presence is felt in every rigid line, every too-perfect hedge, and the palpable atmosphere of fear.

---

## Color Palette

- **Rabbit Warren / Pool of Tears:** Earthy browns, pale blue-green water, purple-blue mushroom/smoke accents, golden key highlights
- **Tulgey Wood:** Deep forest greens, teal shadows, golden-green light shafts, purple-pink Cheshire glow, dark crimson in Jabberwock territory
- **Mad Tea Quarter:** Warm amber, burnished gold, dusty rose, aged cream, brass metallic accents on clocks
- **Queen's Domain:** Dominant crimson red, stark white (roses), emerald green (lawns), black and gold (card-soldier livery), silver-white (Looking Glass glow)
- **Map borders/edges:** Swirling kaleidoscope mist in muted versions of the four suit colors (red hearts, red diamonds, black clubs, black spades)

---

## Style Notes

- The map should have a **parchment or aged paper texture** as a base, consistent with the existing Shattered Coast and Underdark maps in the application
- Illustrated in a **hand-drawn fantasy cartography** style with ink linework and watercolor-style fills
- Small decorative elements scattered throughout: tiny playing cards, chess pieces, pocket watches, tea cups, keys, mushrooms
- A decorative title cartouche in one corner reading **"Wonderland"** in an ornate, slightly mad font — letters of different sizes, some upside down or tilted
- A compass rose, but *wrong* — the cardinal directions are labeled with Wonderland logic (e.g., "This Way," "That Way," "The Other Way," "Back Again")
- The overall feeling should be **beautiful but deeply unsettling** — a place you'd want to explore but wouldn't want to be trapped in

---

## Clickable Location Markers (x,y as percentages)

These four locations need to be visually prominent landmarks on the map. The coordinates are given as percentage positions (0,0 = top-left, 100,100 = bottom-right) for placing interactive click targets in the web UI:

| # | Location ID | Label | Subtitle | x% | y% | Marker Color | Associated Scenario |
|---|-------------|-------|----------|----|----|-------------|-------------------|
| 1 | rabbit-warren | The Rabbit Warren | Pool of Tears | 30 | 20 | #a855f7 (purple) | Down the Rabbit Hole |
| 2 | tulgey-wood | The Tulgey Wood | Cheshire Reaches | 22 | 52 | #22c55e (green) | The Tulgey Wood |
| 3 | tea-quarter | The Mad Tea Quarter | Broken Clock Tower | 70 | 40 | #f59e0b (amber) | A Mad Tea Party |
| 4 | queens-domain | The Queen's Domain | Palace of Hearts | 55 | 80 | #ef4444 (red) | The Queen's Croquet Ground |

### Coordinate Rationale

- **Rabbit Warren (30, 20):** Upper-left area, near the Pool of Tears — the entry point, positioned high on the map to represent the starting zone. Offset left to make room for the mushroom and caterpillar and to leave the top-center for the rabbit hole visual element.
- **Tulgey Wood (22, 52):** Left-center, deep in the forest — positioned to feel remote and wild, anchoring the large forested region on the left side of the map.
- **Mad Tea Quarter (70, 40):** Right-center, representing the township district — positioned on the opposite side from the wood to create clear visual separation between the wilderness and the urban zone.
- **Queen's Domain (55, 80):** Lower-center, the climactic destination — positioned at the bottom of the map to represent the campaign's narrative endpoint, slightly right of center where the palace sits.

---

## Wilderness Start Points (for random encounter placement)

These are secondary points between the main locations where the party might begin wilderness travel:

| Label | x% | y% |
|-------|----|----|
| The Rabbit Hole Entrance | 50 | 10 |
| Pool of Tears Shore | 20 | 30 |
| Tulgey Wood Edge | 30 | 42 |
| Mad Tea Quarter Gates | 58 | 50 |
| Queen's Garden Walls | 50 | 70 |
