// Client feature switches.

// "Scenarios (spoilers!)" links — the card on Home and the sidebar link. Hidden at the chair's
// direction, 2026-10-28 (WO-0050): "Just hiding it will be fine." The /scenarios and
// /scenarios/:id routes and their pages are kept and still load if the URL is typed.
// To bring the links back, set this to true. Nothing else needs to change.
export const SHOW_SCENARIO_LINKS = false;
