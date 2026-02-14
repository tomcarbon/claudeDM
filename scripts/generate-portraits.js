/**
 * Generate 200x200 retro pixel-art profile pictures for all characters and NPCs.
 * Style: Apple IIe / Windows 3.1 era — 16-color EGA palette, 100x100 grid scaled 2x.
 * Writes profilePic into both data/ and data/defaults/ JSON files.
 *
 * Usage: node scripts/generate-portraits.js
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

// Classic 16-color EGA palette
const P = {
  black:     '#000000',
  darkBlue:  '#0000AA',
  darkGreen: '#00AA00',
  darkCyan:  '#00AAAA',
  darkRed:   '#AA0000',
  darkMag:   '#AA00AA',
  brown:     '#AA5500',
  lightGray: '#AAAAAA',
  darkGray:  '#555555',
  blue:      '#5555FF',
  green:     '#55FF55',
  cyan:      '#55FFFF',
  red:       '#FF5555',
  magenta:   '#FF55FF',
  yellow:    '#FFFF55',
  white:     '#FFFFFF',
};

const GRID = 100;
const SCALE = 2;
const SIZE = GRID * SCALE;

function createPortrait(drawFn) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = P.black;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const px = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
  };

  const rect = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE);
  };

  // Draw an ellipse of pixels
  const ellipse = (cx, cy, rx, ry, color) => {
    for (let y = -ry; y <= ry; y++) {
      for (let x = -rx; x <= rx; x++) {
        if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) {
          px(cx + x, cy + y, color);
        }
      }
    }
  };

  // Draw a line of pixels between two points
  const line = (x0, y0, x1, y1, color) => {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (true) {
      px(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  };

  // Dither pattern fill
  const dither = (x, y, w, h, c1, c2) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        px(x + dx, y + dy, (dx + dy) % 2 === 0 ? c1 : c2);
      }
    }
  };

  drawFn({ px, rect, ellipse, line, dither, P });

  // Retro border frame
  rect(0, 0, 100, 1, P.darkGray);
  rect(0, 99, 100, 1, P.darkGray);
  rect(0, 0, 1, 100, P.darkGray);
  rect(99, 0, 1, 100, P.darkGray);

  return 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
}

// ─────────────────────────────────────
// THORIN IRONFORGE — Dwarf Fighter
// ─────────────────────────────────────
function drawDwarfFighter({ px, rect, ellipse, line, dither, P }) {
  // Background — stone wall
  dither(1, 1, 98, 98, '#1a1a2e', '#222244');

  // === HELMET ===
  // Main dome
  ellipse(50, 14, 22, 12, P.darkGray);
  rect(28, 14, 44, 6, P.darkGray);
  // Helmet highlight ridge
  rect(38, 4, 24, 2, '#777777');
  rect(42, 3, 16, 2, '#777777');
  // Gold band across forehead
  rect(28, 18, 44, 3, P.yellow);
  rect(29, 19, 42, 1, P.brown);
  // Nose guard
  rect(48, 20, 4, 8, P.darkGray);
  rect(47, 21, 6, 2, P.darkGray);
  // Wing ornaments on sides
  for (let i = 0; i < 6; i++) {
    px(24 - i, 12 - i, P.yellow);
    px(25 - i, 12 - i, P.yellow);
    px(75 + i, 12 - i, P.yellow);
    px(76 + i, 12 - i, P.yellow);
  }
  // Rivets
  for (let x = 32; x < 68; x += 6) {
    px(x, 18, P.lightGray);
  }

  // === FACE ===
  rect(32, 22, 36, 28, '#CC8855');
  ellipse(50, 32, 17, 16, '#CC8855');
  // Cheek shadows
  rect(32, 30, 4, 10, '#BB7744');
  rect(64, 30, 4, 10, '#BB7744');
  // Forehead shadow under helmet
  rect(33, 22, 34, 3, '#BB7744');

  // === EYES ===
  // Sockets
  rect(36, 28, 10, 6, '#BB7744');
  rect(54, 28, 10, 6, '#BB7744');
  // Whites
  rect(37, 29, 8, 4, P.white);
  rect(55, 29, 8, 4, P.white);
  // Iris
  rect(40, 29, 4, 4, P.blue);
  rect(58, 29, 4, 4, P.blue);
  // Pupils
  rect(41, 30, 2, 2, P.black);
  rect(59, 30, 2, 2, P.black);
  // Highlights
  px(42, 29, P.white);
  px(60, 29, P.white);
  // Bushy eyebrows
  rect(35, 26, 12, 2, P.brown);
  rect(53, 26, 12, 2, P.brown);
  rect(34, 27, 3, 1, P.brown);
  rect(63, 27, 3, 1, P.brown);

  // === NOSE ===
  rect(47, 34, 6, 6, '#BB7744');
  rect(48, 34, 4, 5, '#CC8855');
  rect(46, 39, 8, 2, '#BB7744');
  px(46, 39, '#AA6633');
  px(53, 39, '#AA6633');

  // === BEARD ===
  // Main beard mass
  rect(30, 42, 40, 8, P.brown);
  rect(28, 46, 44, 12, P.brown);
  rect(32, 58, 36, 10, P.brown);
  rect(36, 68, 28, 8, P.brown);
  rect(40, 76, 20, 4, P.brown);
  // Beard braids
  rect(34, 58, 6, 14, '#CC7722');
  rect(60, 58, 6, 14, '#CC7722');
  rect(35, 72, 4, 4, '#CC7722');
  rect(61, 72, 4, 4, '#CC7722');
  // Braid rings
  rect(34, 64, 6, 2, P.yellow);
  rect(60, 64, 6, 2, P.yellow);
  // Beard highlight/texture
  for (let y = 48; y < 76; y += 3) {
    for (let x = 33; x < 67; x += 4) {
      if (x > 30 && x < 70) px(x, y, '#CC7722');
    }
  }
  // Mustache
  rect(40, 42, 8, 2, '#CC7722');
  rect(38, 43, 4, 2, P.brown);
  rect(56, 43, 4, 2, P.brown);
  rect(36, 44, 3, 3, P.brown);
  rect(59, 44, 3, 3, P.brown);
  // Mouth barely visible
  rect(45, 43, 10, 2, '#993322');

  // === ARMOR (shoulders) ===
  rect(10, 78, 80, 22, P.darkGray);
  rect(14, 78, 72, 22, P.lightGray);
  // Chainmail pattern
  for (let y = 80; y < 99; y += 2) {
    for (let x = 16; x < 84; x += 3) {
      px(x, y, P.darkGray);
      px(x + 1, y + 1, P.darkGray);
    }
  }
  // Shoulder plates
  rect(10, 78, 16, 10, P.darkGray);
  rect(74, 78, 16, 10, P.darkGray);
  rect(12, 79, 12, 8, '#777777');
  rect(76, 79, 12, 8, '#777777');
  // Gold collar
  rect(30, 78, 40, 3, P.yellow);
  rect(32, 79, 36, 1, P.brown);
}

// ─────────────────────────────────────
// BRAMBLE THORNFOOT — Halfling Rogue
// ─────────────────────────────────────
function drawHalflingRogue({ px, rect, ellipse, line, dither, P }) {
  // Background — shadowy alley
  dither(1, 1, 98, 98, '#111122', '#0a0a1a');

  // === HOOD ===
  ellipse(50, 18, 26, 18, P.darkGreen);
  rect(24, 18, 52, 16, P.darkGreen);
  rect(28, 8, 44, 12, P.darkGreen);
  // Hood highlight
  rect(40, 8, 20, 3, '#228822');
  // Hood shadow under brim
  rect(30, 28, 40, 3, '#004400');
  // Hood folds
  line(28, 12, 24, 34, '#005500');
  line(72, 12, 76, 34, '#005500');

  // === FACE (small, round, youthful) ===
  ellipse(50, 40, 16, 15, '#DDAA77');
  // Cheek blush
  ellipse(38, 44, 4, 3, '#DD8866');
  ellipse(62, 44, 4, 3, '#DD8866');
  // Freckles
  px(37, 42, '#CC8855'); px(39, 43, '#CC8855'); px(38, 44, '#CC8855');
  px(63, 42, '#CC8855'); px(61, 43, '#CC8855'); px(62, 44, '#CC8855');

  // === EYES (large, bright, mischievous) ===
  rect(39, 36, 8, 5, P.white);
  rect(53, 36, 8, 5, P.white);
  rect(42, 36, 4, 5, P.darkGreen);
  rect(56, 36, 4, 5, P.darkGreen);
  rect(43, 37, 2, 3, P.black);
  rect(57, 37, 2, 3, P.black);
  px(44, 37, P.white);
  px(58, 37, P.white);
  // Eyebrows (arched, mischievous)
  line(38, 34, 47, 33, P.brown);
  line(53, 33, 62, 34, P.brown);

  // === NOSE (button) ===
  rect(48, 42, 4, 3, '#CC9966');
  px(47, 44, '#BB8855');
  px(52, 44, '#BB8855');

  // === SMILE (wide, cheeky) ===
  line(40, 48, 44, 50, '#994433');
  rect(44, 50, 12, 2, '#994433');
  line(56, 50, 60, 48, '#994433');
  // Teeth peeking
  rect(46, 50, 8, 1, P.white);

  // Curly hair poking from hood
  for (let i = 0; i < 5; i++) {
    px(30 + i * 2, 29 - (i % 2), P.brown);
    px(62 + i * 2, 29 - (i % 2), P.brown);
  }
  ellipse(32, 30, 3, 2, '#996633');
  ellipse(68, 30, 3, 2, '#996633');

  // === LEATHER ARMOR ===
  rect(26, 56, 48, 44, P.brown);
  rect(30, 56, 40, 44, '#996633');
  // Stitching detail
  for (let y = 60; y < 96; y += 5) {
    px(34, y, '#664422'); px(34, y + 1, '#664422');
    px(66, y, '#664422'); px(66, y + 1, '#664422');
  }
  // Collar
  rect(34, 56, 32, 4, '#664422');
  rect(36, 57, 28, 2, '#775533');
  // Belt
  rect(30, 76, 40, 3, P.darkGray);
  rect(48, 76, 6, 3, P.yellow);
  // Buckle detail
  px(49, 77, P.brown); px(52, 77, P.brown);

  // Cloak edges
  rect(18, 56, 10, 38, P.darkGreen);
  rect(72, 56, 10, 38, P.darkGreen);
  // Cloak fold highlights
  rect(20, 58, 2, 34, '#228822');
  rect(78, 58, 2, 34, '#228822');

  // === DAGGERS ===
  // Left hip dagger
  rect(28, 78, 2, 10, P.lightGray);
  rect(27, 77, 4, 2, P.brown);
  px(28, 88, P.lightGray);
  // Right hip dagger
  rect(70, 78, 2, 10, P.lightGray);
  rect(69, 77, 4, 2, P.brown);
  px(70, 88, P.lightGray);
}

// ─────────────────────────────────────
// KAELARA BRIGHTFLAME — High Elf Wizard
// ─────────────────────────────────────
function drawHighElfWizard({ px, rect, ellipse, line, dither, P }) {
  // Background — arcane shimmer
  dither(1, 1, 98, 98, '#0a0a2e', '#111144');
  // Sparkles
  for (let i = 0; i < 12; i++) {
    const sx = 5 + (i * 37 + 13) % 88;
    const sy = 5 + (i * 23 + 7) % 88;
    px(sx, sy, P.cyan);
  }

  // === WIZARD HAT ===
  // Tall pointed hat
  for (let y = 2; y < 22; y++) {
    const w = Math.floor(2 + (y - 2) * 1.4);
    rect(50 - w, y, w * 2, 1, P.darkBlue);
  }
  // Hat band
  rect(24, 20, 52, 3, P.darkBlue);
  // Star on hat
  px(49, 6, P.yellow); px(50, 6, P.yellow);
  px(48, 7, P.yellow); px(49, 7, P.white); px(50, 7, P.white); px(51, 7, P.yellow);
  px(49, 8, P.yellow); px(50, 8, P.yellow);
  // Hat shimmer
  line(40, 15, 46, 5, '#3333CC');
  // Brim
  rect(20, 22, 60, 3, P.darkBlue);
  rect(22, 23, 56, 1, '#3333CC');

  // === FACE (narrow, elegant, pale) ===
  ellipse(50, 38, 14, 16, '#FFDDC0');
  // Slight cheek contour
  rect(36, 40, 3, 6, '#EECCAA');
  rect(61, 40, 3, 6, '#EECCAA');

  // === POINTED EARS ===
  // Left ear
  rect(33, 34, 3, 8, '#FFDDC0');
  rect(31, 35, 2, 5, '#FFDDC0');
  px(29, 36, '#FFDDC0'); px(28, 37, '#FFDDC0');
  // Right ear
  rect(64, 34, 3, 8, '#FFDDC0');
  rect(67, 35, 2, 5, '#FFDDC0');
  px(69, 36, '#FFDDC0'); px(70, 37, '#FFDDC0');
  // Ear jewels
  px(30, 38, P.cyan);
  px(69, 38, P.cyan);

  // === EYES (almond-shaped, luminous) ===
  // Left eye
  line(38, 35, 41, 34, P.white);
  rect(41, 34, 6, 5, P.white);
  line(47, 34, 49, 35, P.white);
  rect(43, 34, 3, 5, P.cyan);
  rect(44, 35, 2, 3, P.darkCyan);
  px(45, 35, P.white);
  // Right eye
  line(51, 35, 53, 34, P.white);
  rect(53, 34, 6, 5, P.white);
  line(59, 34, 62, 35, P.white);
  rect(55, 34, 3, 5, P.cyan);
  rect(56, 35, 2, 3, P.darkCyan);
  px(57, 35, P.white);
  // Elegant eyebrows
  line(37, 31, 49, 31, '#BBBBCC');
  line(51, 31, 63, 31, '#BBBBCC');

  // === NOSE (thin, refined) ===
  line(50, 38, 49, 44, '#EECCAA');
  rect(48, 44, 4, 1, '#EECCAA');

  // === LIPS (slight knowing smile) ===
  line(44, 48, 48, 49, '#CC8877');
  rect(48, 49, 4, 1, '#CC8877');
  line(52, 49, 56, 48, '#CC8877');

  // === LONG SILVER HAIR ===
  rect(32, 26, 5, 30, P.lightGray);
  rect(63, 26, 5, 30, P.lightGray);
  rect(30, 28, 4, 28, P.white);
  rect(66, 28, 4, 28, P.white);
  // Hair continuing down
  rect(30, 56, 5, 20, P.lightGray);
  rect(65, 56, 5, 20, P.lightGray);
  // Hair highlights
  line(31, 30, 31, 55, P.white);
  line(68, 30, 68, 55, P.white);

  // === ROBES ===
  rect(24, 58, 52, 42, P.darkBlue);
  rect(28, 58, 44, 42, '#3333AA');
  // V-neck collar
  line(40, 58, 50, 68, '#3333AA');
  line(60, 58, 50, 68, '#3333AA');
  // Gold trim at collar
  line(40, 58, 50, 67, P.yellow);
  line(60, 58, 50, 67, P.yellow);
  // Star patterns on robe
  px(36, 72, P.yellow); px(64, 78, P.yellow);
  px(42, 86, P.yellow); px(58, 70, P.yellow);
  px(50, 80, P.yellow); px(34, 90, P.yellow);
  // Robe bottom trim
  rect(24, 96, 52, 2, P.yellow);

  // === STAFF ===
  rect(74, 28, 3, 70, P.brown);
  rect(73, 30, 5, 2, '#664422');
  // Crystal orb on top
  ellipse(75, 24, 5, 5, P.cyan);
  ellipse(75, 24, 3, 3, P.white);
  px(74, 22, P.white);
  // Glow effect
  px(69, 22, P.darkCyan); px(81, 22, P.darkCyan);
  px(75, 17, P.darkCyan); px(75, 31, P.darkCyan);

  // Sleeves
  rect(20, 62, 8, 14, P.darkBlue);
  rect(72, 62, 8, 14, P.darkBlue);
}

// ─────────────────────────────────────
// GRIMJAW BONECRUSHER — Half-Orc Barbarian
// ─────────────────────────────────────
function drawHalfOrcBarbarian({ px, rect, ellipse, line, dither, P }) {
  // Background — blood red dusk
  dither(1, 1, 98, 98, '#1a0a0a', '#220e0e');

  // === WILD HAIR ===
  rect(24, 4, 52, 12, '#222222');
  rect(20, 8, 60, 10, '#222222');
  rect(18, 12, 64, 8, '#222222');
  // Wild spikes
  rect(26, 2, 6, 6, '#222222');
  rect(38, 1, 5, 5, '#222222');
  rect(56, 2, 6, 6, '#222222');
  rect(68, 3, 5, 5, '#222222');
  rect(18, 6, 6, 8, '#222222');
  rect(76, 6, 6, 8, '#222222');

  // === MASSIVE HEAD ===
  ellipse(50, 32, 22, 22, '#668844');
  // Brow ridge (heavy, pronounced)
  rect(28, 22, 44, 5, '#557733');
  rect(26, 24, 48, 4, '#557733');
  // Jaw (wide, square)
  rect(30, 48, 40, 8, '#668844');
  rect(34, 54, 32, 4, '#668844');
  // Cheek shadows
  rect(28, 34, 5, 12, '#557733');
  rect(67, 34, 5, 12, '#557733');

  // === EYES (deep-set, fierce) ===
  rect(34, 28, 10, 6, '#445522');
  rect(56, 28, 10, 6, '#445522');
  rect(35, 29, 8, 4, P.white);
  rect(57, 29, 8, 4, P.white);
  rect(38, 29, 4, 4, P.red);
  rect(60, 29, 4, 4, P.red);
  rect(39, 30, 2, 2, P.darkRed);
  rect(61, 30, 2, 2, P.darkRed);
  px(40, 29, P.white);
  px(62, 29, P.white);

  // === BROAD NOSE ===
  rect(45, 35, 10, 8, '#557733');
  rect(46, 36, 8, 6, '#668844');
  rect(44, 42, 12, 2, '#557733');
  // Nostrils
  px(46, 42, '#445522'); px(53, 42, '#445522');

  // === TUSKS AND MOUTH ===
  rect(38, 48, 24, 3, '#993322');
  // Lower tusks jutting up
  rect(34, 44, 4, 6, P.white);
  rect(62, 44, 4, 6, P.white);
  rect(35, 43, 2, 2, P.lightGray);
  rect(63, 43, 2, 2, P.lightGray);
  // Upper lip
  rect(40, 47, 20, 1, '#557733');

  // === WAR PAINT (red stripes) ===
  line(28, 28, 32, 40, P.red);
  line(29, 28, 33, 40, P.red);
  line(68, 28, 72, 40, P.red);
  line(69, 28, 73, 40, P.red);
  // Forehead paint
  line(40, 22, 50, 18, P.red);
  line(60, 22, 50, 18, P.red);

  // === SCAR across right cheek ===
  line(60, 34, 70, 46, '#445522');
  line(61, 34, 71, 46, '#445522');

  // === MASSIVE SHOULDERS (bare green skin + fur) ===
  rect(8, 60, 84, 40, '#557733');
  // Fur vest
  rect(22, 64, 56, 36, '#664422');
  rect(26, 64, 48, 36, '#884422');
  // Fur texture
  for (let y = 66; y < 98; y += 3) {
    for (let x = 28; x < 72; x += 4) {
      px(x, y, '#773311');
      px(x + 1, y + 1, '#995533');
    }
  }
  // Bare arm muscles
  rect(8, 62, 16, 20, '#668844');
  rect(76, 62, 16, 20, '#668844');
  // Muscle definition
  line(12, 64, 14, 78, '#557733');
  line(84, 64, 82, 78, '#557733');

  // === SKULL NECKLACE ===
  rect(38, 60, 24, 2, '#664422');
  // Skull 1
  rect(40, 62, 6, 6, P.white);
  rect(41, 63, 1, 2, P.black);
  rect(44, 63, 1, 2, P.black);
  rect(42, 66, 2, 1, P.black);
  // Skull 2
  rect(54, 62, 6, 6, P.white);
  rect(55, 63, 1, 2, P.black);
  rect(58, 63, 1, 2, P.black);
  rect(56, 66, 2, 1, P.black);
  // Bone beads between
  px(48, 62, P.white); px(50, 62, P.white); px(52, 62, P.white);
}

// ─────────────────────────────────────
// LYRALEI MOONWHISPER — Human Cleric
// ─────────────────────────────────────
function drawHumanCleric({ px, rect, ellipse, line, dither, P }) {
  // Background — warm light
  dither(1, 1, 98, 98, '#1a1522', '#221a2e');

  // === HAIR (long, flowing, golden-brown) ===
  ellipse(50, 16, 22, 14, '#AA7744');
  rect(28, 16, 44, 16, '#AA7744');
  rect(26, 22, 48, 16, '#AA7744');
  // Hair flowing past shoulders
  rect(26, 38, 8, 22, '#AA7744');
  rect(66, 38, 8, 22, '#AA7744');
  rect(28, 56, 6, 12, '#996633');
  rect(66, 56, 6, 12, '#996633');
  // Hair highlights
  line(34, 12, 36, 36, '#CC9966');
  line(64, 12, 62, 36, '#CC9966');
  line(42, 8, 44, 28, '#CCAA77');

  // === CIRCLET WITH GEM ===
  rect(30, 18, 40, 2, P.yellow);
  rect(32, 17, 36, 1, P.yellow);
  // Central gem
  rect(47, 15, 6, 4, P.cyan);
  rect(48, 14, 4, 6, P.cyan);
  px(49, 15, P.white); px(50, 15, P.white);
  // Side gems
  px(36, 18, P.cyan); px(64, 18, P.cyan);

  // === FACE ===
  ellipse(50, 34, 16, 16, '#EEBB99');
  // Forehead visible under circlet
  rect(34, 20, 32, 6, '#EEBB99');
  // Cheek contour
  rect(34, 38, 3, 6, '#DDAA88');
  rect(63, 38, 3, 6, '#DDAA88');

  // === EYES (kind, blue) ===
  rect(39, 30, 8, 5, P.white);
  rect(53, 30, 8, 5, P.white);
  rect(42, 30, 4, 5, P.blue);
  rect(56, 30, 4, 5, P.blue);
  rect(43, 31, 2, 3, P.darkBlue);
  rect(57, 31, 2, 3, P.darkBlue);
  px(44, 31, P.white);
  px(58, 31, P.white);
  // Eyelashes / soft brows
  line(38, 28, 48, 28, '#AA7744');
  line(52, 28, 62, 28, '#AA7744');

  // === NOSE ===
  line(50, 34, 49, 40, '#DDAA88');
  rect(47, 40, 6, 2, '#DDAA88');

  // === GENTLE SMILE ===
  line(42, 44, 46, 46, '#CC7766');
  rect(46, 46, 8, 2, '#CC7766');
  line(54, 46, 58, 44, '#CC7766');
  // Lip highlight
  rect(47, 46, 6, 1, '#DD8877');

  // === WHITE ROBES ===
  rect(20, 56, 60, 44, P.white);
  rect(24, 56, 52, 44, P.lightGray);
  // Robe folds
  line(36, 60, 34, 98, '#999999');
  line(64, 60, 66, 98, '#999999');
  // Gold trim at collar
  rect(34, 56, 32, 3, P.yellow);
  rect(36, 57, 28, 1, '#CCAA33');
  // V-neck
  line(42, 56, 50, 64, P.lightGray);
  line(58, 56, 50, 64, P.lightGray);

  // === HOLY SYMBOL (golden sun on chest) ===
  ellipse(50, 76, 7, 7, P.yellow);
  ellipse(50, 76, 4, 4, P.white);
  // Sun rays
  line(50, 66, 50, 68, P.yellow);
  line(50, 84, 50, 86, P.yellow);
  line(40, 76, 42, 76, P.yellow);
  line(58, 76, 60, 76, P.yellow);
  line(43, 69, 45, 71, P.yellow);
  line(55, 71, 57, 69, P.yellow);
  line(43, 83, 45, 81, P.yellow);
  line(55, 81, 57, 83, P.yellow);

  // Sleeves
  rect(16, 58, 10, 20, P.white);
  rect(74, 58, 10, 20, P.white);
  // Sleeve gold trim
  rect(16, 58, 10, 2, P.yellow);
  rect(74, 58, 10, 2, P.yellow);
}

// ─────────────────────────────────────
// ZEPHYR SHADOWMEND — Tiefling Warlock
// ─────────────────────────────────────
function drawTieflingWarlock({ px, rect, ellipse, line, dither, P }) {
  // Background — eldritch dark
  dither(1, 1, 98, 98, '#0a0515', '#110822');
  // Eldritch wisps
  for (let i = 0; i < 8; i++) {
    const wx = 10 + (i * 41 + 17) % 78;
    const wy = 10 + (i * 29 + 11) % 78;
    px(wx, wy, P.darkMag);
    px(wx + 1, wy, '#330033');
  }

  // === HORNS (curving upward and back) ===
  // Left horn
  rect(24, 8, 4, 14, P.darkRed);
  rect(22, 6, 4, 6, P.darkRed);
  rect(20, 4, 4, 4, '#881111');
  rect(18, 2, 4, 4, '#881111');
  rect(16, 1, 4, 3, '#661111');
  // Horn ridges
  px(25, 10, '#CC3333'); px(25, 14, '#CC3333'); px(23, 8, '#CC3333');
  // Right horn
  rect(72, 8, 4, 14, P.darkRed);
  rect(74, 6, 4, 6, P.darkRed);
  rect(76, 4, 4, 4, '#881111');
  rect(78, 2, 4, 4, '#881111');
  rect(80, 1, 4, 3, '#661111');
  px(73, 10, '#CC3333'); px(73, 14, '#CC3333'); px(75, 8, '#CC3333');

  // === DARK HAIR (slicked back between horns) ===
  rect(28, 8, 44, 10, '#111111');
  rect(30, 6, 40, 6, '#111111');
  // Hair sheen
  line(40, 7, 56, 7, '#222222');

  // === FACE (reddish-purple skin) ===
  ellipse(50, 32, 18, 18, '#883355');
  // Lighter center face
  ellipse(50, 34, 12, 12, '#993366');
  // Chin
  rect(44, 48, 12, 4, '#883355');
  // Cheekbones (sharp)
  rect(32, 32, 4, 6, '#772244');
  rect(64, 32, 4, 6, '#772244');

  // === EYES (solid glowing yellow — no whites) ===
  rect(38, 30, 8, 5, P.yellow);
  rect(54, 30, 8, 5, P.yellow);
  // Inner glow
  rect(40, 31, 4, 3, '#FFFF99');
  rect(56, 31, 4, 3, '#FFFF99');
  // Slit pupils
  rect(41, 30, 2, 5, '#AAAA00');
  rect(57, 30, 2, 5, '#AAAA00');
  // Glow halos
  px(36, 31, '#666600'); px(46, 31, '#666600');
  px(52, 31, '#666600'); px(62, 31, '#666600');
  // Sharp angular brows
  line(36, 27, 46, 28, '#662244');
  line(54, 28, 64, 27, '#662244');

  // === NOSE (sharp, angular) ===
  line(50, 36, 49, 42, '#772244');
  rect(48, 42, 4, 1, '#772244');

  // === THIN SMIRK ===
  line(42, 46, 48, 47, '#661133');
  rect(48, 47, 4, 1, '#661133');
  line(52, 47, 58, 45, '#661133');
  // One corner raised higher (smirk)
  px(58, 44, '#661133');

  // === DARK ROBES ===
  rect(18, 54, 64, 46, '#221133');
  rect(22, 54, 56, 46, '#331144');
  // High collar
  rect(30, 52, 40, 6, '#110022');
  rect(32, 52, 6, 8, P.darkMag);
  rect(62, 52, 6, 8, P.darkMag);
  // Collar points
  rect(33, 50, 4, 2, P.darkMag);
  rect(63, 50, 4, 2, P.darkMag);

  // === ELDRITCH ENERGY PATTERNS ===
  for (let y = 62; y < 96; y += 6) {
    line(30, y, 36, y + 4, P.darkMag);
    line(64, y, 70, y + 4, P.darkMag);
    px(33, y + 2, P.magenta);
    px(67, y + 2, P.magenta);
  }
  // Central rune on chest
  rect(47, 66, 6, 6, P.darkMag);
  rect(48, 64, 4, 2, P.darkMag);
  rect(48, 72, 4, 2, P.darkMag);
  px(49, 68, P.magenta); px(50, 68, P.magenta);

  // === GLOWING GREEN PENDANT ===
  rect(48, 58, 4, 4, P.green);
  ellipse(50, 60, 2, 2, P.green);
  px(49, 59, '#88FF88');
  // Chain
  line(46, 54, 48, 58, P.darkGray);
  line(54, 54, 52, 58, P.darkGray);
}

// ─────────────────────────────────────
// DRAK "COPPERHAND" VOSS — Human Ranger
// ─────────────────────────────────────
function drawHumanRanger({ px, rect, ellipse, line, dither, P }) {
  // Background — forest canopy
  dither(1, 1, 98, 98, '#0a1a0a', '#112211');

  // === HOOD / COWL ===
  ellipse(50, 16, 24, 14, '#336633');
  rect(26, 16, 48, 18, '#336633');
  rect(30, 8, 40, 12, '#336633');
  // Hood texture
  line(36, 10, 34, 30, '#2a552a');
  line(64, 10, 66, 30, '#2a552a');
  // Hood shadow
  rect(32, 30, 36, 3, '#224422');
  // Hood peak
  rect(44, 6, 12, 4, '#336633');

  // === FACE (weathered, tanned) ===
  ellipse(50, 42, 15, 15, '#CC9977');
  rect(36, 44, 28, 10, '#CC9977');
  // Shadow under hood
  rect(36, 32, 28, 3, '#BB8866');
  // Stubble
  dither(38, 48, 24, 6, '#CC9977', '#BB8866');

  // === EYES (sharp, hunter's gaze) ===
  rect(39, 38, 8, 4, P.white);
  rect(53, 38, 8, 4, P.white);
  rect(42, 38, 4, 4, P.darkGreen);
  rect(56, 38, 4, 4, P.darkGreen);
  rect(43, 39, 2, 2, P.black);
  rect(57, 39, 2, 2, P.black);
  px(43, 38, P.white);
  px(57, 38, P.white);
  // Brows (furrowed)
  line(37, 35, 48, 36, '#AA7755');
  line(52, 36, 63, 35, '#AA7755');
  px(37, 36, '#AA7755'); px(63, 36, '#AA7755');

  // === NOSE (strong) ===
  rect(48, 42, 4, 5, '#BB8866');
  rect(47, 46, 6, 2, '#BB8866');

  // === MOUTH (set, determined) ===
  rect(44, 50, 12, 2, '#994433');
  rect(43, 50, 1, 1, '#BB8866');
  rect(56, 50, 1, 1, '#BB8866');

  // === SCAR (across left cheek) ===
  line(58, 38, 66, 50, '#AA6644');
  line(59, 38, 67, 50, '#996644');

  // === CLOAK ===
  rect(14, 56, 72, 44, '#336633');
  rect(18, 56, 64, 44, '#447744');
  // Cloak fold highlights
  line(22, 58, 20, 96, '#558855');
  line(78, 58, 80, 96, '#558855');

  // === LEATHER ARMOR UNDERNEATH ===
  rect(30, 58, 40, 42, P.brown);
  rect(34, 58, 32, 42, '#996633');
  // Stitching
  for (let y = 62; y < 96; y += 4) {
    px(38, y, '#664422');
    px(62, y, '#664422');
  }
  // Belt
  rect(30, 80, 40, 3, '#443322');
  rect(48, 80, 6, 3, P.yellow);
  px(49, 81, '#443322'); px(52, 81, '#443322');

  // === BOW (over left shoulder) ===
  line(14, 22, 10, 76, P.brown);
  line(15, 22, 11, 76, P.brown);
  // Bow tips
  px(14, 20, P.brown); px(15, 20, P.brown);
  px(10, 78, P.brown); px(11, 78, P.brown);
  // Bowstring
  line(16, 24, 12, 74, P.lightGray);

  // === QUIVER (over right shoulder) ===
  rect(74, 38, 8, 20, P.brown);
  rect(75, 36, 6, 4, '#664422');
  // Arrow fletching poking out
  px(76, 36, P.white); px(78, 36, P.white); px(80, 36, P.white);
  px(76, 37, P.lightGray); px(78, 37, P.lightGray);
  px(77, 35, P.red); px(79, 35, P.green);
}

// ─────────────────────────────────────
// PIP WHISTLEDOWN — Halfling Bard (Monk in data)
// ─────────────────────────────────────
function drawHalflingBard({ px, rect, ellipse, line, dither, P }) {
  // Background — warm tavern glow
  dither(1, 1, 98, 98, '#1a1510', '#221a12');

  // === JAUNTY FEATHERED CAP ===
  ellipse(50, 16, 20, 10, P.red);
  rect(30, 14, 40, 8, P.red);
  rect(34, 10, 32, 6, P.red);
  // Cap fold
  line(36, 12, 64, 12, '#CC2222');
  // Cap brim
  rect(28, 20, 44, 3, '#CC2222');
  // Feather!
  line(64, 6, 72, 2, P.green);
  line(65, 6, 73, 2, P.green);
  line(66, 6, 74, 3, '#22AA22');
  line(72, 2, 78, 4, '#22AA22');
  line(73, 2, 78, 6, P.darkGreen);
  // Feather quill
  px(64, 7, P.white);

  // === ROUND CHEERFUL FACE ===
  ellipse(50, 38, 16, 16, '#EEBB99');
  // Rosy cheeks
  ellipse(38, 42, 4, 3, '#DD9977');
  ellipse(62, 42, 4, 3, '#DD9977');

  // === EYES (bright, twinkling) ===
  rect(40, 34, 7, 5, P.white);
  rect(53, 34, 7, 5, P.white);
  rect(43, 34, 3, 5, P.brown);
  rect(56, 34, 3, 5, P.brown);
  rect(44, 35, 2, 3, P.black);
  rect(57, 35, 2, 3, P.black);
  // Twinkle!
  px(44, 34, P.white); px(45, 35, P.white);
  px(57, 34, P.white); px(58, 35, P.white);
  // Merry eyebrows (raised)
  line(39, 31, 48, 32, '#CC6622');
  line(52, 32, 61, 31, '#CC6622');

  // === CURLY AUBURN HAIR ===
  // Poking out from under cap
  ellipse(32, 26, 5, 4, '#CC6622');
  ellipse(68, 26, 5, 4, '#CC6622');
  ellipse(30, 30, 4, 4, '#CC6622');
  ellipse(70, 30, 4, 4, '#CC6622');
  rect(28, 28, 5, 16, '#CC6622');
  rect(67, 28, 5, 16, '#CC6622');
  // Curl details
  px(29, 32, '#AA4411'); px(30, 36, '#AA4411');
  px(70, 32, '#AA4411'); px(69, 36, '#AA4411');

  // === BUTTON NOSE ===
  ellipse(50, 42, 2, 2, '#DDAA88');

  // === BIG GRIN ===
  line(40, 47, 44, 49, '#994433');
  rect(44, 49, 12, 3, '#994433');
  line(56, 49, 60, 47, '#994433');
  // Teeth!
  rect(45, 49, 10, 2, P.white);
  // Dimples
  px(39, 47, '#CCAA88'); px(61, 47, '#CCAA88');

  // === COLORFUL OUTFIT ===
  // Puffy white shirt
  rect(32, 54, 36, 20, P.white);
  rect(30, 56, 40, 16, '#DDDDDD');
  // Vest over shirt
  rect(26, 54, 10, 28, P.darkMag);
  rect(64, 54, 10, 28, P.darkMag);
  rect(28, 54, 8, 28, '#AA2266');
  rect(66, 54, 8, 28, '#AA2266');
  // Vest lacing
  for (let y = 58; y < 80; y += 5) {
    line(36, y, 40, y + 2, P.yellow);
    line(64, y, 60, y + 2, P.yellow);
  }
  // Gold buttons
  px(50, 58, P.yellow); px(50, 64, P.yellow); px(50, 70, P.yellow);

  // Belt with pouches
  rect(26, 80, 48, 3, P.brown);
  rect(46, 80, 8, 3, P.yellow);
  // Pouches
  rect(30, 83, 6, 5, '#664422');
  rect(64, 83, 6, 5, '#664422');

  // Pants
  rect(32, 84, 36, 16, P.brown);
  rect(36, 84, 28, 16, '#996633');

  // === LUTE ===
  // Body (on left side)
  ellipse(14, 70, 8, 10, P.brown);
  ellipse(14, 70, 6, 8, '#AA7744');
  // Sound hole
  ellipse(14, 70, 3, 3, '#664422');
  px(14, 70, '#443311');
  // Neck
  rect(12, 48, 4, 22, P.brown);
  rect(13, 46, 2, 4, '#664422');
  // Tuning pegs
  px(11, 46, P.lightGray); px(16, 47, P.lightGray);
  px(11, 48, P.lightGray); px(16, 49, P.lightGray);
  // Strings
  line(13, 50, 13, 76, P.yellow);
  line(15, 50, 15, 76, P.yellow);
}

// ─────────────────────────────────────
// SISTER MIRAEL — Human Cleric (NPC)
// ─────────────────────────────────────
function drawSisterMirael({ px, rect, ellipse, line, dither, P }) {
  // Background — candlelit warmth
  dither(1, 1, 98, 98, '#1a1520', '#201828');

  // === WIMPLE AND VEIL ===
  // White wimple framing face
  ellipse(50, 18, 24, 14, P.white);
  rect(26, 18, 48, 14, P.white);
  rect(24, 20, 52, 14, P.white);
  // Dark blue veil on top
  rect(28, 4, 44, 16, P.darkBlue);
  rect(32, 2, 36, 6, P.darkBlue);
  // Veil draping down sides
  rect(20, 18, 8, 36, P.darkBlue);
  rect(72, 18, 8, 36, P.darkBlue);
  rect(22, 50, 6, 10, '#000088');
  rect(72, 50, 6, 10, '#000088');
  // Veil folds
  line(22, 20, 22, 56, '#3333AA');
  line(76, 20, 76, 56, '#3333AA');
  // Wimple edge detail
  rect(26, 32, 48, 2, '#CCCCCC');

  // === GENTLE FACE ===
  ellipse(50, 36, 16, 16, '#FFDDC0');
  // Soft cheek shadows
  rect(34, 38, 4, 8, '#EECCAA');
  rect(62, 38, 4, 8, '#EECCAA');

  // === EYES (warm, compassionate) ===
  rect(39, 32, 8, 5, P.white);
  rect(53, 32, 8, 5, P.white);
  rect(42, 32, 4, 5, P.brown);
  rect(56, 32, 4, 5, P.brown);
  rect(43, 33, 2, 3, '#664422');
  rect(57, 33, 2, 3, '#664422');
  px(44, 33, P.white);
  px(58, 33, P.white);
  // Gentle arched brows
  line(38, 30, 48, 30, '#996633');
  line(52, 30, 62, 30, '#996633');

  // === NOSE ===
  line(50, 36, 49, 40, '#EECCAA');
  rect(48, 40, 4, 1, '#EECCAA');

  // === GENTLE SMILE (warm, serene) ===
  line(43, 44, 47, 46, '#CC8877');
  rect(47, 46, 6, 1, '#CC8877');
  line(53, 46, 57, 44, '#CC8877');
  // Smile lines
  px(42, 44, '#EECCAA'); px(58, 44, '#EECCAA');

  // === WHITE-AND-BLUE ROBES ===
  rect(18, 54, 64, 46, P.white);
  rect(22, 54, 56, 46, P.lightGray);
  // Robe folds
  line(34, 56, 32, 98, '#999999');
  line(66, 56, 68, 98, '#999999');
  line(50, 58, 50, 98, '#AAAAAA');

  // === BLUE SASH ===
  rect(42, 58, 16, 42, P.darkBlue);
  rect(44, 56, 12, 4, P.darkBlue);
  // Sash end hanging
  rect(44, 82, 4, 16, P.darkBlue);
  rect(42, 80, 3, 4, P.darkBlue);
  // Sash detail
  line(44, 60, 44, 98, '#3333AA');
  line(56, 60, 56, 98, '#3333AA');

  // === HOLY SYMBOL (ornate golden cross) ===
  // Vertical bar
  rect(48, 64, 4, 14, P.yellow);
  // Horizontal bar
  rect(42, 70, 16, 4, P.yellow);
  // Cross ornaments
  px(48, 64, P.white); px(51, 64, P.white);
  px(42, 70, P.white); px(57, 70, P.white);
  px(48, 77, P.white); px(51, 77, P.white);
  // Gem at center
  rect(49, 71, 2, 2, P.cyan);

  // Sleeves
  rect(14, 56, 10, 22, P.white);
  rect(76, 56, 10, 22, P.white);
  rect(16, 58, 6, 18, '#DDDDDD');
  rect(78, 58, 6, 18, '#DDDDDD');
  // Hands clasped in prayer
  rect(40, 76, 8, 4, '#FFDDC0');
  rect(52, 76, 8, 4, '#FFDDC0');
}

// ─────────────────────────────────────
// ELDON FAIRWEATHER — Half-Elf Druid
// ─────────────────────────────────────
function drawHalfElfDruid({ px, rect, ellipse, line, dither, P }) {
  // Background — mossy forest
  dither(1, 1, 98, 98, '#0a180a', '#0e220e');

  // === WILD HAIR WITH LEAVES ===
  ellipse(50, 14, 22, 12, '#886633');
  rect(28, 14, 44, 14, '#886633');
  rect(24, 18, 52, 12, '#886633');
  // Hair flowing to sides
  rect(22, 26, 8, 20, '#886633');
  rect(70, 26, 8, 20, '#886633');
  // Hair highlights
  line(36, 10, 38, 28, '#AA8844');
  line(62, 10, 60, 28, '#AA8844');
  // Leaves woven in
  px(30, 12, P.green); px(31, 11, P.green); px(32, 12, P.green);
  px(66, 12, P.green); px(67, 11, P.green); px(68, 12, P.green);
  px(44, 8, P.green); px(45, 7, P.green); px(46, 8, P.green);
  px(54, 8, P.green); px(55, 7, P.green); px(56, 8, P.green);
  // Small flowers
  px(34, 14, P.yellow); px(64, 16, P.yellow);
  px(48, 6, P.yellow);

  // === FACE (half-elf, warm) ===
  ellipse(50, 36, 16, 16, '#DDBB99');
  // Freckles
  px(40, 38, '#CC9977'); px(42, 40, '#CC9977');
  px(58, 38, '#CC9977'); px(60, 40, '#CC9977');

  // === SLIGHTLY POINTED EARS ===
  rect(30, 30, 4, 8, '#DDBB99');
  rect(28, 32, 2, 5, '#DDBB99');
  px(27, 33, '#DDBB99'); px(26, 34, '#DDBB99');
  rect(66, 30, 4, 8, '#DDBB99');
  rect(70, 32, 2, 5, '#DDBB99');
  px(72, 33, '#DDBB99'); px(73, 34, '#DDBB99');
  // Ear tips green tint (nature magic)
  px(26, 34, P.darkGreen);
  px(73, 34, P.darkGreen);

  // === EYES (warm brown, kind) ===
  rect(39, 32, 8, 5, P.white);
  rect(53, 32, 8, 5, P.white);
  rect(42, 32, 4, 5, P.brown);
  rect(56, 32, 4, 5, P.brown);
  rect(43, 33, 2, 3, '#664422');
  rect(57, 33, 2, 3, '#664422');
  px(44, 33, P.white);
  px(58, 33, P.white);
  // Friendly brows
  line(38, 30, 48, 29, '#886633');
  line(52, 29, 62, 30, '#886633');

  // === NOSE ===
  rect(48, 38, 4, 4, '#CCAA88');
  rect(47, 41, 6, 2, '#CCAA88');

  // === FRIENDLY SMILE ===
  line(42, 46, 46, 48, '#BB7766');
  rect(46, 48, 8, 2, '#BB7766');
  line(54, 48, 58, 46, '#BB7766');
  // Teeth hint
  rect(47, 48, 6, 1, P.white);

  // === GREEN DRUID ROBES ===
  rect(18, 54, 64, 46, P.darkGreen);
  rect(22, 54, 56, 46, '#338833');
  // Robe texture (leaf pattern)
  for (let y = 60; y < 96; y += 8) {
    for (let x = 28; x < 72; x += 10) {
      px(x, y, P.green); px(x + 1, y - 1, P.green);
      px(x - 1, y - 1, P.green); px(x, y - 2, P.green);
    }
  }
  // Robe folds
  line(36, 58, 34, 98, '#226622');
  line(64, 58, 66, 98, '#226622');
  // V collar
  line(40, 54, 50, 62, '#226622');
  line(60, 54, 50, 62, '#226622');

  // === ROPE BELT WITH HERBS ===
  rect(28, 78, 44, 3, P.brown);
  rect(30, 79, 40, 1, '#996633');
  // Herb pouches
  rect(32, 81, 6, 5, '#664422');
  rect(62, 81, 6, 5, '#664422');
  // Herbs poking out
  px(33, 81, P.green); px(35, 80, P.green);
  px(63, 81, P.green); px(65, 80, P.green);
  // Rope end hanging
  rect(48, 81, 3, 10, P.brown);
  px(48, 91, '#996633');

  // === WOODEN STAFF ===
  rect(12, 14, 4, 86, '#664422');
  rect(13, 16, 2, 82, '#885533');
  // Gnarled top — twisted branches
  rect(8, 8, 12, 8, '#664422');
  rect(10, 6, 8, 4, '#664422');
  rect(12, 4, 4, 4, '#664422');
  // Living leaves on staff
  px(8, 6, P.green); px(9, 5, P.green); px(10, 4, P.green);
  px(20, 8, P.green); px(21, 7, P.green);
  px(12, 3, P.green); px(14, 2, P.green);
  // Faint nature glow
  px(14, 8, '#55FF55'); px(12, 10, '#55FF55');
}

// ─────────────────────────────────────
// VAELITH DUSKMANTLE — Drow Rogue
// ─────────────────────────────────────
function drawDrowRogue({ px, rect, ellipse, line, dither, P }) {
  // Background — Underdark darkness
  dither(1, 1, 98, 98, '#08040e', '#0e081a');

  // === WILD WHITE HAIR ===
  ellipse(50, 16, 24, 14, P.white);
  rect(26, 16, 48, 14, P.white);
  rect(22, 20, 56, 14, P.white);
  // Hair flowing down long
  rect(20, 32, 8, 24, P.white);
  rect(72, 32, 8, 24, P.white);
  rect(22, 54, 6, 14, P.lightGray);
  rect(72, 54, 6, 14, P.lightGray);
  // Hair highlights
  line(32, 12, 34, 34, P.lightGray);
  line(66, 12, 64, 34, P.lightGray);
  // Hair strands
  line(24, 30, 22, 56, P.lightGray);
  line(76, 30, 78, 56, P.lightGray);

  // === DARK ELF FACE (obsidian / deep purple-black) ===
  ellipse(50, 38, 18, 18, '#332244');
  // Lighter purple highlights
  ellipse(50, 38, 12, 12, '#443355');
  // Sharp jaw
  rect(40, 52, 20, 4, '#332244');
  rect(44, 54, 12, 2, '#332244');
  // Cheekbone highlights
  rect(34, 36, 3, 4, '#3a2a4a');
  rect(63, 36, 3, 4, '#3a2a4a');

  // === POINTED EARS (long, drow) ===
  rect(28, 32, 6, 8, '#332244');
  rect(26, 34, 2, 5, '#332244');
  px(24, 35, '#332244'); px(23, 36, '#332244'); px(22, 37, '#332244');
  rect(66, 32, 6, 8, '#332244');
  rect(72, 34, 2, 5, '#332244');
  px(74, 35, '#332244'); px(75, 36, '#332244'); px(76, 37, '#332244');
  // Silver ear cuffs
  px(26, 36, P.lightGray); px(72, 36, P.lightGray);

  // === EYES (glowing red — menacing) ===
  rect(38, 34, 8, 5, P.red);
  rect(54, 34, 8, 5, P.red);
  rect(40, 35, 4, 3, '#FF3333');
  rect(56, 35, 4, 3, '#FF3333');
  // Pupils
  rect(41, 35, 2, 3, P.darkRed);
  rect(57, 35, 2, 3, P.darkRed);
  // Glow effect
  px(36, 35, '#440000'); px(46, 35, '#440000');
  px(52, 35, '#440000'); px(62, 35, '#440000');
  // Sharp angular brows (white)
  line(36, 31, 46, 32, P.lightGray);
  line(54, 32, 64, 31, P.lightGray);

  // === NARROW NOSE ===
  line(50, 38, 49, 44, '#221133');
  rect(48, 44, 4, 1, '#2a1a3a');

  // === THIN LIPS (slight cruel smile) ===
  line(43, 48, 48, 49, '#442255');
  rect(48, 49, 4, 1, '#442255');
  line(52, 49, 57, 48, '#442255');
  // One corner up
  px(57, 47, '#442255');

  // === DARK LEATHER ARMOR ===
  rect(16, 56, 68, 44, '#111111');
  rect(20, 56, 60, 44, '#1a1a2e');
  // Armor plating
  rect(24, 58, 24, 18, '#222233');
  rect(52, 58, 24, 18, '#222233');
  // Armor studs
  for (let y = 60; y < 74; y += 4) {
    for (let x = 28; x < 48; x += 6) {
      px(x, y, P.darkGray);
    }
    for (let x = 56; x < 76; x += 6) {
      px(x, y, P.darkGray);
    }
  }

  // === SPIDER WEB EMBLEM (House symbol) ===
  // Web center
  px(50, 68, P.darkMag);
  // Radial threads
  line(50, 68, 44, 62, P.darkMag);
  line(50, 68, 56, 62, P.darkMag);
  line(50, 68, 44, 74, P.darkMag);
  line(50, 68, 56, 74, P.darkMag);
  line(50, 68, 50, 62, P.darkMag);
  line(50, 68, 50, 74, P.darkMag);
  line(50, 68, 44, 68, P.darkMag);
  line(50, 68, 56, 68, P.darkMag);
  // Spider at center
  px(49, 67, P.magenta); px(50, 67, P.magenta); px(51, 67, P.magenta);
  px(50, 68, P.magenta);

  // === BELT ===
  rect(24, 80, 52, 3, P.darkGray);
  rect(46, 80, 8, 3, P.darkMag);
  // Belt pouches
  rect(28, 83, 5, 4, '#0e0e1e');
  rect(68, 83, 5, 4, '#0e0e1e');

  // === CROSSED DAGGERS ON BACK ===
  line(36, 56, 64, 76, P.lightGray);
  line(64, 56, 36, 76, P.lightGray);
  // Hilts
  rect(34, 54, 4, 4, P.darkMag);
  rect(62, 54, 4, 4, P.darkMag);

  // Cloak edges
  rect(12, 58, 6, 36, '#0e0e1e');
  rect(82, 58, 6, 36, '#0e0e1e');
}

// ─── CHARACTER → DRAWING MAP ───

const CHARACTER_PORTRAITS = {
  'thorin-ironforge': drawDwarfFighter,
  'bramble-thornfoot': drawHalflingRogue,
  'kaelara-brightflame': drawHighElfWizard,
  'grimjaw-bonecrusher': drawHalfOrcBarbarian,
  'lyralei-moonwhisper': drawHumanCleric,
  'zephyr-shadowmend': drawTieflingWarlock,
  'drak-copperhand-voss': drawHumanRanger,
  'pip-whistledown': drawHalflingBard,
  'sister-mirael': drawSisterMirael,
  'eldon-fairweather': drawHalfElfDruid,
  'vaelith-duskmantle': drawDrowRogue,
};

// ─── MAIN ───

function main() {
  const dataRoot = path.join(__dirname, '..', 'data');

  // Write to both live data and defaults
  const targetRoots = [
    dataRoot,
    path.join(dataRoot, 'defaults'),
  ];

  const subdirs = ['characters', 'npcs'];
  let count = 0;

  // Generate each portrait once, then write to both locations
  for (const subdir of subdirs) {
    const liveDir = path.join(dataRoot, subdir);
    const files = fs.readdirSync(liveDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const slug = file.replace('.json', '');
      const drawFn = CHARACTER_PORTRAITS[slug];
      if (!drawFn) {
        console.log(`  skip: ${slug} (no portrait defined)`);
        continue;
      }

      const pic = createPortrait(drawFn);

      for (const root of targetRoots) {
        const filePath = path.join(root, subdir, file);
        if (!fs.existsSync(filePath)) {
          console.log(`  skip: ${filePath} (file missing)`);
          continue;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.profilePic = pic;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      }

      console.log(`  done: ${slug}`);
      count++;
    }
  }

  console.log(`\nGenerated ${count} portraits (written to data/ and data/defaults/).`);
}

main();
