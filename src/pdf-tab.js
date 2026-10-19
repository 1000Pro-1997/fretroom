// Reads guitar tablature straight from a vector PDF exported by notation software (Guitar Pro,
// MuseScore, TuxGuitar…). Fret numbers on the TAB staff are text, and rhythm comes from the SMuFL
// glyphs, stems and beams of the standard staff above it, so the score is rebuilt exactly instead
// of being guessed from pixels. Returns alphaTex, or null when the PDF holds no such tablature.

const IDENTITY = [1, 0, 0, 1, 0, 0];
const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Walks the operator list once, tracking the graphics and text state, and returns every glyph
// (one entry per character, in PDF user space with y up) and every painted path.
async function pagePrimitives(page, OPS) {
  const list = await page.getOperatorList();
  const glyphs = [];
  const paths = [];
  const stack = [];
  let state = { ctm: IDENTITY, font: null, size: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, lineWidth: 1 };
  let tm = IDENTITY;
  let tlm = IDENTITY;
  const moveText = (x, y) => { tlm = multiply([1, 0, 0, 1, x, y], tlm); tm = tlm; };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(state); state = { ...state }; break;
      case OPS.restore: state = stack.pop() ?? state; break;
      case OPS.transform: state.ctm = multiply(args, state.ctm); break;
      case OPS.paintFormXObjectBegin:
        stack.push(state);
        state = { ...state, ctm: args[0] ? multiply(args[0], state.ctm) : state.ctm };
        break;
      case OPS.paintFormXObjectEnd: state = stack.pop() ?? state; break;
      case OPS.setLineWidth: state.lineWidth = args[0]; break;
      case OPS.beginText: tm = IDENTITY; tlm = IDENTITY; break;
      case OPS.setFont: {
        state.font = page.commonObjs.has(args[0]) ? page.commonObjs.get(args[0]) : null;
        state.size = args[1];
        break;
      }
      case OPS.setTextMatrix: tlm = tm = Array.from(args.length === 6 ? args : args[0]); break;
      case OPS.moveText: moveText(args[0], args[1]); break;
      case OPS.setLeadingMoveText: state.leading = -args[1]; moveText(args[0], args[1]); break;
      case OPS.nextLine: moveText(0, -state.leading); break;
      case OPS.setLeading: state.leading = args[0]; break;
      case OPS.setCharSpacing: state.charSpacing = args[0]; break;
      case OPS.setWordSpacing: state.wordSpacing = args[0]; break;
      case OPS.setHScale: state.hScale = args[0] / 100; break;
      case OPS.setTextRise: state.rise = args[0]; break;
      case OPS.showText: {
        const scale = (state.font?.fontMatrix ?? [0.001])[0] * state.size;
        for (const glyph of args[0]) {
          if (typeof glyph === 'number') {
            tm = multiply([1, 0, 0, 1, -glyph * 0.001 * state.size * state.hScale, 0], tm);
            continue;
          }
          if (!glyph) continue;
          const box = [state.size * state.hScale, 0, 0, state.size, 0, state.rise];
          const render = multiply(multiply(box, tm), state.ctm);
          const spacing = state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0);
          tm = multiply([1, 0, 0, 1, (glyph.width * scale + spacing) * state.hScale, 0], tm);
          const text = glyph.unicode ?? '';
          if (text.trim()) {
            const next = multiply(multiply(box, tm), state.ctm);
            glyphs.push({ text, x: render[4], y: render[5], size: Math.hypot(render[2], render[3]), advance: Math.hypot(next[4] - render[4], next[5] - render[5]), font: state.font?.loadedName ?? '' });
          }
        }
        break;
      }
      case OPS.constructPath: {
        const [paint, [data]] = args;
        if (!data || paint === OPS.endPath) break;
        const filled = paint !== OPS.stroke && paint !== OPS.closeStroke;
        const width = state.lineWidth * Math.hypot(state.ctm[0], state.ctm[1]);
        let points = [];
        const flush = () => { if (points.length > 1) paths.push({ points, filled, width }); points = []; };
        for (let k = 0; k < data.length;) {
          const op = data[k++];
          if (op === 0) { flush(); points.push(apply(state.ctm, data[k], data[k + 1])); k += 2; }
          else if (op === 1) { points.push(apply(state.ctm, data[k], data[k + 1])); k += 2; }
          else if (op === 2) { points.push(apply(state.ctm, data[k + 4], data[k + 5])); k += 6; }
          else if (op === 3) { points.push(apply(state.ctm, data[k + 2], data[k + 3])); k += 4; }
          else if (op === 4) flush();
          else break;
        }
        flush();
        break;
      }
      default: break;
    }
  }
  return { glyphs, paths };
}

// SMuFL code points shared by Bravura and the other standard music fonts.
const HEAD_VALUES = { 0xe0a0: 8, 0xe0a2: 4, 0xe0a3: 2, 0xe0a4: 1, 0xe0a7: 4, 0xe0a8: 2, 0xe0a9: 1 };
const DIAMOND_VALUES = { 0xe0d9: 4, 0xe0da: 2, 0xe0db: 1, 0xe1b8: 2, 0xe1b9: 1 };
const WIDE_HEADS = new Set([0xe0a0, 0xe0a2, 0xe0a7, 0xe0d9]);
const DEAD_HEADS = new Set([0xe0a7, 0xe0a8, 0xe0a9]);
const REST_VALUES = { 0xe4e2: 8, 0xe4e3: 'bar', 0xe4e4: 2, 0xe4e5: 1, 0xe4e6: 0.5, 0xe4e7: 0.25, 0xe4e8: 0.125, 0xe4e9: 0.0625 };
const DOT = 0xe1e7;
const TEMPO_NOTES = { 0xe1d2: 4, 0xe1d3: 2, 0xe1d5: 1, 0xe1d7: 0.5 };
const isFlag = (cp) => cp >= 0xe240 && cp <= 0xe24d;
const flagLevel = (cp) => Math.floor((cp - 0xe240) / 2) + 1;
const TAB_CLEFS = new Set([0xe06d, 0xe06e]);
const STAFF_CLEFS = new Set([0xe050, 0xe052, 0xe053, 0xe062, 0xe05c]);
const ARROW_UP = 0xeb78;
const ARROW_DOWN = 0xeb7c;
const PICK_DOWN = 0xe610;
const PICK_UP = 0xe612;
const HARMONIC_LABELS = { AH: 'ah', TH: 'th', PH: 'ph', SH: 'sh', NH: 'nh', 'A.H.': 'ah', 'T.H.': 'th', 'P.H.': 'ph', 'S.H.': 'sh', 'N.H.': 'nh' };
const STANDARD_TUNINGS = { 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 6: [64, 59, 55, 50, 45, 40], 7: [64, 59, 55, 50, 45, 40, 35], 8: [64, 59, 55, 50, 45, 40, 35, 30] };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PITCH_CLASSES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

// Plain-text glyphs grouped into words (a space where the gap is wide). Faux-bold text drawn
// twice with a small offset is read once.
function wordsOf(glyphs) {
  const text = glyphs.filter((g) => g.text.codePointAt(0) < 0xe000 && g.size < 40).sort((a, b) => b.y - a.y);
  const rows = [];
  for (const g of text) {
    const row = rows.at(-1);
    if (row && near(row.y, g.y, g.size * 0.2)) row.glyphs.push(g); else rows.push({ y: g.y, glyphs: [g] });
  }
  const words = [];
  for (const row of rows) {
    const open = [];
    for (const g of row.glyphs.sort((a, b) => a.x - b.x)) {
      const word = open.findLast((w) => w.font === g.font && near(w.size, g.size, 0.3));
      const gap = word ? g.x - word.x1 : Infinity;
      if (word && word.last.text === g.text && g.x - word.last.x < g.size * 0.15) continue;
      if (word && gap < g.size * 0.6) {
        word.text += (gap > g.size * 0.2 ? ' ' : '') + g.text;
        word.x1 = g.x + g.advance;
        word.last = g;
      } else {
        const created = { text: g.text, x0: g.x, x1: g.x + g.advance, y: g.y, size: g.size, font: g.font, last: g };
        open.push(created);
        words.push(created);
      }
    }
  }
  for (const word of words) word.xc = (word.x0 + word.x1) / 2;
  return words;
}

function lineGroups(paths) {
  const segments = [];
  for (const path of paths) {
    const xs = path.points.map((p) => p[0]);
    const ys = path.points.map((p) => p[1]);
    const height = Math.max(...ys) - Math.min(...ys);
    const width = Math.max(...xs) - Math.min(...xs);
    if (height < 0.4 && width > 0.5 && (!path.filled || path.points.length <= 5)) {
      segments.push({ y: (Math.max(...ys) + Math.min(...ys)) / 2, x0: Math.min(...xs), x1: Math.max(...xs) });
    }
  }
  segments.sort((a, b) => a.y - b.y);
  const groups = [];
  for (const segment of segments) {
    const group = groups.find((g) => near(g.y, segment.y, 0.3));
    if (group) { group.parts.push(segment); group.x0 = Math.min(group.x0, segment.x0); group.x1 = Math.max(group.x1, segment.x1); }
    else groups.push({ y: segment.y, x0: segment.x0, x1: segment.x1, parts: [segment] });
  }
  return groups;
}

// The longest run of evenly spaced lines around a clef glyph.
function staffLines(groups, clef, count) {
  const candidates = groups.filter((g) => g.x0 <= clef.x + 2 && g.x1 >= clef.x + 20 && near(g.y, clef.y, clef.size * 2.5))
    .map((g) => g.y).sort((a, b) => b - a);
  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const spacing = candidates[i] - candidates[j];
      if (spacing < 1) continue;
      const lines = [candidates[i]];
      for (let k = j; k < candidates.length; k++) {
        const expected = lines.at(-1) - spacing;
        if (near(candidates[k], expected, spacing * 0.08)) lines.push(candidates[k]);
        else if (candidates[k] < expected) break;
      }
      if (count && lines.length !== count) continue;
      if (lines.length < 4 || clef.y > lines[0] + spacing || clef.y < lines.at(-1) - spacing) continue;
      if (!best || lines.length > best.lines.length) best = { lines, spacing };
    }
  }
  return best;
}

function findSystems(page, groups) {
  const systems = [];
  for (const clef of page.music.filter((g) => TAB_CLEFS.has(g.cp))) {
    const tab = staffLines(groups, clef);
    if (!tab) continue;
    const tabTop = tab.lines[0];
    const tabBottom = tab.lines.at(-1);
    const staffClef = page.music.filter((g) => STAFF_CLEFS.has(g.cp) && near(g.x, clef.x, 20) && g.y > tabTop)
      .sort((a, b) => a.y - b.y)[0];
    const staff = staffClef && staffLines(groups, staffClef, 5);
    if (!staff) continue;
    const rows = groups.filter((g) => tab.lines.some((y) => near(g.y, y, 0.3)));
    systems.push({
      page, tab: tab.lines, tabSpacing: tab.spacing, tabTop, tabBottom,
      staffTop: staff.lines[0], staffBottom: staff.lines[4], space: staff.spacing,
      x0: Math.min(...rows.map((g) => g.x0)), x1: Math.max(...rows.map((g) => g.x1)),
    });
  }
  systems.sort((a, b) => b.staffTop - a.staffTop);
  // Glyphs above a staff belong to it only up to the TAB staff of the system above.
  systems.forEach((system, i) => {
    system.ceiling = Math.min(system.staffTop + 14 * system.space, i ? systems[i - 1].tabBottom - systems[i - 1].tabSpacing : Infinity);
  });
  return systems;
}

function bounds(path) {
  const xs = path.points.map((p) => p[0]);
  const ys = path.points.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// Barlines cross both staves at the same x: one rule over the whole system or one per staff.
function barlines(system, paths) {
  const vertical = paths.map(bounds).filter((b) => b.x1 - b.x0 < system.space * 0.8 && b.x0 >= system.x0 - 3 && b.x1 <= system.x1 + 3);
  const spans = (b, bottom, top) => b.y0 <= bottom + 0.6 && b.y1 >= top - 0.6;
  const xs = [];
  for (const b of vertical) {
    const x = (b.x0 + b.x1) / 2;
    const whole = spans(b, system.tabBottom, system.staffTop);
    const tabOnly = spans(b, system.tabBottom, system.tabTop) && b.y1 < system.staffBottom;
    if (whole || (tabOnly && vertical.some((o) => near((o.x0 + o.x1) / 2, x, 1) && spans(o, system.staffBottom, system.staffTop)))) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  const merged = [];
  for (const x of xs) if (!merged.length || x - merged.at(-1) > system.space) merged.push(x);
  if (!merged.length || merged[0] > system.x0 + system.space * 3) merged.unshift(system.x0);
  if (merged.at(-1) < system.x1 - system.space * 3) merged.push(system.x1);
  return merged;
}

function beamsOf(paths, space) {
  const beams = [];
  for (const path of paths) {
    if (!path.filled) continue;
    let points = path.points;
    if (points.length === 5 && near(points[0][0], points[4][0], 0.05) && near(points[0][1], points[4][1], 0.05)) points = points.slice(0, 4);
    if (points.length !== 4) continue;
    const sorted = [...points].sort((a, b) => a[0] - b[0]);
    const [l1, l2, r1, r2] = sorted;
    if (!near(l1[0], l2[0], 0.3) || !near(r1[0], r2[0], 0.3)) continue;
    const thickness = Math.abs(l1[1] - l2[1]);
    if (thickness < space * 0.25 || thickness > space * 0.8 || r1[0] - l1[0] < space * 0.5) continue;
    beams.push({ x0: l1[0], x1: r1[0], y0: (l1[1] + l2[1]) / 2, y1: (r1[1] + r2[1]) / 2 });
  }
  return beams;
}
const beamY = (beam, x) => beam.y0 + (beam.y1 - beam.y0) * (x - beam.x0) / (beam.x1 - beam.x0);

const TAB_WORD = /^(\(?(\d+|[xX])\)?|<\d+>)$/;

// Notes, rests and markings of one system, in page coordinates.
function readSystem(system, words, paths, firstNumber) {
  const { space } = system;
  const middle = (system.tabTop + system.staffBottom) / 2;
  const inX = (x) => x >= system.x0 - 3 && x <= system.x1 + 3;
  // Notation reaches down to the TAB: low notes, voice 2 stems and beams sit under the staff.
  const floor = system.tabTop + 1;
  const inStaff = (y) => y > floor && y < system.ceiling;
  const music = system.page.music.filter((g) => inX(g.x));
  const staffGlyphs = music.filter((g) => inStaff(g.y));
  const fontSize = space * 4;

  const heads = staffGlyphs.filter((g) => HEAD_VALUES[g.cp] || DIAMOND_VALUES[g.cp]).map((g) => ({
    ...g, width: (WIDE_HEADS.has(g.cp) ? 1.69 : 1.18) * g.size / 4, diamond: Boolean(DIAMOND_VALUES[g.cp]),
    value: HEAD_VALUES[g.cp] ?? DIAMOND_VALUES[g.cp], dead: DEAD_HEADS.has(g.cp), grace: g.size < fontSize * 0.85,
  }));
  const bars = barlines(system, paths);
  const stems = paths.filter((p) => p.points.length === 2 || (p.filled && p.points.length <= 5)).map(bounds)
    .filter((b) => b.x1 - b.x0 < space * 0.3 && b.y1 - b.y0 > space * 1.2 && inX(b.x0) && b.y1 > floor && b.y0 < system.ceiling
      && !bars.some((x) => near(x, b.x0, 1)))
    .map((b) => ({ x: (b.x0 + b.x1) / 2, y0: b.y0, y1: b.y1 }));
  const beams = beamsOf(paths, space).filter((b) => inX(b.x0) && b.y0 > floor && b.y1 > floor);

  // Noteheads sit at the foot of a stem, left of an up stem and right of a down stem; the tip end
  // is free, so another voice's note touching the tip is not taken.
  const chords = [];
  const attached = new Set();
  for (const stem of stems) {
    const tip = Math.min(space * 1.5, (stem.y1 - stem.y0) * 0.45);
    const up = heads.filter((h) => !attached.has(h) && near(stem.x, h.x + h.width, space * 0.22) && h.y >= stem.y0 - space * 0.6 && h.y <= stem.y1 - tip);
    const down = heads.filter((h) => !attached.has(h) && near(stem.x, h.x, space * 0.22) && h.y >= stem.y0 + tip && h.y <= stem.y1 + space * 0.6);
    const upFoot = up.some((h) => near(h.y, stem.y0, space * 0.6));
    const downFoot = down.some((h) => near(h.y, stem.y1, space * 0.6));
    if (!upFoot && !downFoot) continue;
    const direction = upFoot && (!downFoot || up.length >= down.length) ? 'up' : 'down';
    const members = direction === 'up' ? up : down;
    for (const h of members) attached.add(h);
    chords.push({ heads: members, stem, direction });
  }
  // A second interval pushes one head to the other side of its stem.
  for (const chord of chords) {
    const { stem } = chord;
    const across = heads.filter((h) => !attached.has(h) && h.y >= stem.y0 - space * 0.4 && h.y <= stem.y1 + space * 0.4
      && near(stem.x, chord.direction === 'up' ? h.x : h.x + h.width, space * 0.22) && chord.heads.some((m) => near(m.y, h.y, space * 0.6)));
    for (const h of across) { attached.add(h); chord.heads.push(h); }
  }
  for (const h of heads) {
    if (attached.has(h)) continue;
    // Stemless (whole) notes a second apart sit side by side, one head width apart.
    const chord = chords.find((c) => !c.stem && c.heads.some((o) => near(o.x, h.x, Math.max(space * 0.5, o.width * 1.15))));
    if (chord) chord.heads.push(h);
    else chords.push({ heads: [h], stem: null, direction: 'none' });
    attached.add(h);
  }

  const dots = staffGlyphs.filter((g) => g.cp === DOT);
  const dotsAfter = (x, y, rangeY) => {
    const found = dots.filter((d) => d.x > x + space * 0.05 && d.x < x + space * 2.2 && near(d.y, y, rangeY));
    return new Set(found.map((d) => Math.round(d.x))).size;
  };
  const flags = staffGlyphs.filter((g) => isFlag(g.cp));
  for (const chord of chords) {
    const primary = chord.heads.some((h) => !h.diamond) ? chord.heads.filter((h) => !h.diamond) : chord.heads;
    chord.primary = primary;
    chord.grace = primary.every((h) => h.grace);
    chord.x0 = Math.min(...primary.map((h) => h.x));
    chord.x1 = Math.max(...primary.map((h) => h.x + h.width));
    chord.xc = primary.reduce((sum, h) => sum + h.x + h.width / 2, 0) / primary.length;
    let value = Math.max(...primary.map((h) => h.value));
    if (chord.heads.every((h) => h.diamond) && !chord.stem) value = 4;
    if (value === 1 && chord.stem) {
      const { stem } = chord;
      let level = beams.filter((b) => stem.x >= b.x0 - 0.6 && stem.x <= b.x1 + 0.6
        && beamY(b, stem.x) >= stem.y0 - space * 0.4 && beamY(b, stem.x) <= stem.y1 + space * 0.4).length;
      for (const flag of flags) {
        if (near(flag.x, stem.x, space * 0.5) && flag.y >= stem.y0 - space * 3 && flag.y <= stem.y1 + space * 3) level = Math.max(level, flagLevel(flag.cp));
      }
      value = 1 / 2 ** level;
    }
    chord.value = value;
    chord.dots = Math.max(0, ...primary.map((h) => dotsAfter(h.x + h.width, h.y, space * 0.8)));
    chord.dead = primary.every((h) => h.dead);
  }

  const rests = staffGlyphs.filter((g) => REST_VALUES[g.cp] !== undefined && g.size >= fontSize * 0.85).map((g) => ({
    rest: true, x0: g.x, x1: g.x + space, xc: g.x + space / 2, y: g.y, value: REST_VALUES[g.cp],
    dots: dotsAfter(g.x + space * 0.6, g.y, space * 1.3),
  }));

  // Tuplet numbers sit over a bracket or a beamed group; measure numbers sit on barlines.
  const groupOf = new Map();
  for (const chord of chords) groupOf.set(chord, chord);
  const root = (c) => (groupOf.get(c) === c ? c : root(groupOf.get(c)));
  for (const beam of beams) {
    const crossing = chords.filter((c) => c.stem && c.stem.x >= beam.x0 - 0.6 && c.stem.x <= beam.x1 + 0.6
      && beamY(beam, c.stem.x) >= c.stem.y0 - space * 0.4 && beamY(beam, c.stem.x) <= c.stem.y1 + space * 0.4);
    for (const c of crossing.slice(1)) groupOf.set(root(c), root(crossing[0]));
  }
  const strokes = paths.filter((p) => !p.filled).map((p) => ({ ...bounds(p), path: p }));
  for (const word of words) {
    const digits = /^\d{1,2}$/.test(word.text) ? Number(word.text) : null;
    if (!TUPLET_NORMAL[digits] || !inX(word.x0) || !inStaff(word.y)) continue;
    if (word.y >= system.staffTop - space && word.y <= system.staffTop + space * 3
      && (bars.some((x) => near(x, word.x0, space * 1.5)) || digits === firstNumber + bars.filter((x) => x < word.x0 - space * 2).length - 1)) continue;
    const above = word.y > (system.staffTop + system.staffBottom) / 2;
    const left = strokes.find((s) => near(s.y1, word.y + word.size * 0.35, space * 1.5) && s.x1 <= word.x0 + 0.5 && s.x1 >= word.x0 - space * 1.5 && s.x1 - s.x0 > space);
    const right = strokes.find((s) => near(s.y1, word.y + word.size * 0.35, space * 1.5) && s.x0 >= word.x1 - 1 && s.x0 <= word.x1 + space * 1.5 && s.x1 - s.x0 > space);
    const side = (c) => c.direction === 'none' || (above ? c.direction === 'up' : c.direction === 'down');
    let members;
    if (left && right) {
      members = [...chords.filter((c) => !c.grace && side(c) && c.xc >= left.x0 - space && c.xc <= right.x1 + space),
        ...rests.filter((r) => r.xc >= left.x0 - space && r.xc <= right.x1 + space && (above ? r.y > system.staffBottom + space : r.y < system.staffTop - space))];
    } else {
      const nearest = chords.filter((c) => !c.grace && side(c) && c.stem).sort((a, b) => Math.abs(a.xc - word.xc) - Math.abs(b.xc - word.xc))[0];
      if (!nearest || Math.abs(nearest.xc - word.xc) > space * 4) continue;
      members = chords.filter((c) => root(c) === root(nearest));
    }
    for (const member of members) member.tuplet = digits;
  }

  // TAB: fret numbers on the string lines, with harmonics, ties, dead and grace notes.
  const tabWords = words.filter((w) => inX(w.x0) && w.y >= system.tabBottom - system.tabSpacing * 0.9 && w.y <= system.tabTop + system.tabSpacing * 0.3
    && TAB_WORD.test(w.text.replace(/\s/g, '')));
  const fretSize = mode(tabWords.filter((w) => /^\d+$/.test(w.text)).map((w) => Math.round(w.size * 2) / 2)) ?? 7;
  const stringOf = (w) => {
    const center = w.y + w.size * 0.34;
    let best = 0;
    system.tab.forEach((y, i) => { if (Math.abs(y - center) < Math.abs(system.tab[best] - center)) best = i; });
    return best + 1;
  };
  const tabNotes = [];
  const markers = [];
  for (const w of tabWords) {
    const text = w.text.replace(/\s/g, '');
    const string = stringOf(w);
    if (text.startsWith('<')) { markers.push({ value: Number(text.slice(1, -1)), string, x0: w.x0, x1: w.x1, xc: w.xc }); continue; }
    const tied = text.startsWith('(');
    const body = tied ? text.slice(1, -1) : text;
    tabNotes.push({
      string, fret: /^\d+$/.test(body) ? Number(body) : 'x', tied, grace: w.size < fretSize * 0.85,
      x0: w.x0, x1: w.x1, xc: w.xc, effects: [],
    });
  }
  for (const marker of markers) {
    const owner = tabNotes.find((n) => n.string === marker.string && marker.x0 >= n.x1 - 1.5 && marker.x0 - n.x1 < fretSize);
    if (owner) owner.harmonic = { value: marker.value, type: 'ah' };
    else tabNotes.push({ string: marker.string, fret: marker.value, tied: false, grace: false, x0: marker.x0, x1: marker.x1, xc: marker.xc, effects: [], harmonic: { value: marker.value, type: 'nh' } });
  }

  // Markings drawn above the TAB staff.
  const labels = words.filter((w) => inX(w.x0) && w.y > system.tabTop && w.y < middle + space);
  const nextOnString = (a) => tabNotes.filter((n) => n.string === a.string && n.xc > a.xc + 1).sort((p, q) => p.xc - q.xc)[0];
  const pairAround = (x) => {
    let best = null;
    for (const a of tabNotes) {
      if (a.xc >= x) continue;
      const b = nextOnString(a);
      if (!b || b.xc <= x) continue;
      const cost = (x - a.xc) + (b.xc - x);
      if (!best || cost < best.cost) best = { a, b, cost };
    }
    return best;
  };
  for (const label of labels) {
    const text = label.text.replace(/\s/g, '');
    if (text === 'H' || text === 'P') pairAround(label.xc)?.a.effects.push('h');
    else if (/^sl\.?$/i.test(text)) { const pair = pairAround(label.xc); if (pair) pair.a.slide = 'sl'; }
    else if (HARMONIC_LABELS[text]) {
      const line = strokes.filter((s) => near(s.y0, label.y + label.size * 0.35, label.size * 0.6) && s.x0 >= label.x1 - 2 && s.x0 <= label.x1 + label.size)
        .sort((a, b) => b.x1 - a.x1)[0];
      const end = line ? line.x1 + 2 : label.x1 + label.size;
      for (const note of tabNotes) if (note.harmonic && note.harmonic.type !== 'nh' && note.xc >= label.x0 - label.size && note.xc <= end) note.harmonic.type = HARMONIC_LABELS[text];
    }
  }
  // Slide lines between two frets on one string; labelled ones were already marked legato.
  for (const s of strokes) {
    if (s.path.points.length !== 2 || s.y1 - s.y0 < 0.6 || s.x1 - s.x0 < 2 || s.y0 < system.tabBottom - 2 || s.y1 > system.tabTop + 2) continue;
    const origin = tabNotes.filter((n) => near(n.x1, s.x0, fretSize * 0.6) && Math.abs(system.tab[n.string - 1] - (s.y0 + s.y1) / 2) < system.tabSpacing * 0.6)[0];
    if (origin && !origin.slide) origin.slide = 'ss';
  }
  // Column marks: brush arrows in the TAB, wavy arpeggio lines, pick strokes. An arrowhead pointing
  // up is a stroke from the low to the high strings, which alphaTab calls a down brush.
  const marks = [];
  for (const g of music) {
    if (g.y < system.tabBottom - space * 6 || g.y > middle + space) continue;
    if (g.cp === ARROW_UP || g.cp === ARROW_DOWN) marks.push({ x: g.x, effect: g.cp === ARROW_UP ? 'bd' : 'bu', reach: space * 4 });
    else if (g.cp === PICK_DOWN || g.cp === PICK_UP) marks.push({ x: g.x - space, effect: g.cp === PICK_DOWN ? 'sd' : 'su', reach: space * 2.5 });
  }
  const wiggles = music.filter((g) => g.cp >= 0xeaa9 && g.cp <= 0xeaae && g.y > system.tabBottom - space * 6 && g.y < system.ceiling).sort((a, b) => a.y - b.y);
  const chains = [];
  for (const g of wiggles) {
    const chain = chains.find((c) => near(c.x, g.x, 1) && g.y - c.glyphs.at(-1).y < space * 1.6);
    if (chain) chain.glyphs.push(g); else chains.push({ x: g.x, glyphs: [g] });
  }
  for (const chain of chains) {
    const arrow = chain.glyphs.find((g) => g.cp === 0xeaad || g.cp === 0xeaae);
    const pointsDown = arrow && arrow === chain.glyphs[0] && chain.glyphs.length > 1;
    marks.push({ x: chain.x, effect: pointsDown ? 'au' : 'ad', reach: space * 4 });
  }

  // Time signatures, tempo marks and rehearsal letters.
  const meters = [];
  const digits = staffGlyphs.filter((g) => g.cp >= 0xe080 && g.cp <= 0xe08b);
  for (const g of digits) {
    if (meters.some((m) => near(m.x, g.x, space))) continue;
    const column = digits.filter((o) => near(o.x, g.x, space)).sort((a, b) => b.y - a.y);
    if (g.cp === 0xe08a) meters.push({ x: g.x, numerator: 4, denominator: 4 });
    else if (g.cp === 0xe08b) meters.push({ x: g.x, numerator: 2, denominator: 2 });
    else if (column.length >= 2) meters.push({ x: g.x, numerator: column[0].cp - 0xe080, denominator: column.at(-1).cp - 0xe080 });
  }
  const tempos = [];
  for (const g of music.filter((m) => TEMPO_NOTES[m.cp] && m.y > system.staffTop && m.y < system.ceiling)) {
    const value = words.find((w) => near(w.y, g.y, space * 1.5) && w.x0 > g.x && w.x0 - g.x < space * 4 && /^=\s*\d+/.test(w.text));
    if (value) tempos.push({ x: g.x, bpm: Math.round(Number(value.text.replace(/[^\d.]/g, '')) * TEMPO_NOTES[g.cp]) });
  }
  const boxes = strokes.filter((s) => s.path.points.length >= 4 && s.x1 - s.x0 > 4 && s.x1 - s.x0 < space * 8 && s.y1 - s.y0 > 4 && s.y0 > system.staffTop && s.y1 < system.ceiling);
  const sections = words.filter((w) => w.y > system.staffTop && w.y < system.ceiling && boxes.some((b) => w.xc > b.x0 && w.xc < b.x1 && w.y + w.size * 0.3 > b.y0 && w.y + w.size * 0.3 < b.y1))
    .map((w) => ({ x: w.x0, text: w.text }));

  // Split everything into measures.
  const measures = [];
  for (let i = 0; i + 1 < bars.length; i++) {
    const [x0, x1] = [bars[i], bars[i + 1]];
    if (x1 - x0 < space * 2) continue;
    const inside = (x) => x >= x0 && x < x1;
    measures.push({
      chords: chords.filter((c) => inside(c.xc)), rests: rests.filter((r) => inside(r.xc)),
      tabNotes: tabNotes.filter((n) => inside(n.xc)), marks: marks.filter((g) => inside(g.x)),
      meter: meters.find((m) => inside(m.x)), tempos: tempos.filter((t) => inside(t.x)), section: sections.find((s) => inside(s.x))?.text,
      space, tuningLines: system.tab.length,
    });
  }
  return measures;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const TUPLET_NORMAL = { 3: 2, 5: 4, 6: 4, 7: 4, 9: 8, 10: 8, 11: 8, 12: 8 };
function eventLength(event, barLength) {
  if (event.value === 'bar') return barLength;
  let length = event.value * (event.dots === 2 ? 1.75 : event.dots === 1 ? 1.5 : 1);
  if (event.tuplet) length *= (TUPLET_NORMAL[event.tuplet] ?? event.tuplet - 1) / event.tuplet;
  return length;
}

function* permutations(items) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
  }
}

function* combinations(items, size) {
  if (size === 0) { yield []; return; }
  for (let i = 0; i <= items.length - size; i++) {
    for (const rest of combinations(items.slice(i + 1), size - 1)) yield [items[i], ...rest];
  }
}

// Voices are rebuilt from timing: every voice starts on the barline and the next column starts
// when the earliest sounding voice ends; its events continue exactly the voices ending then.
// Stem directions only break ties between possible orders.
function scheduleVoices(measure, barLength) {
  const events = [...measure.chords.filter((c) => !c.grace), ...measure.rests].sort((a, b) => a.xc - b.xc);
  if (!events.length) return [[]];
  const columns = [];
  for (const e of events) {
    const column = columns.at(-1);
    if (column && e.xc - column.x <= measure.space) column.events.push(e); else columns.push({ x: e.xc, events: [e] });
  }
  const eps = 1e-6;
  let best = null;
  let budget = 50000;
  // A secondary voice may stop early (notation software hides its trailing rests); stopping costs
  // more than any stem-direction mismatch so complete voices win when they fit.
  const STOP = 3;
  const search = (index, voices, penalty) => {
    if (--budget < 0 || (best && penalty >= best.penalty)) return;
    if (index === columns.length) {
      const short = voices.filter((v) => v.free < barLength - eps).length;
      if (voices.every((v) => v.free < barLength + eps) && short < voices.length && penalty + short * STOP < (best?.penalty ?? Infinity)) {
        best = { penalty: penalty + short * STOP, voices: voices.map((v) => v.events) };
      }
      return;
    }
    if (index === 0) {
      search(1, columns[0].events.map((e) => ({ free: eventLength(e, barLength), events: [e], direction: e.direction })), 0);
      return;
    }
    const open = voices.filter((v) => !v.stopped && v.free < barLength - eps);
    if (!open.length) return;
    const time = Math.min(...open.map((v) => v.free));
    const due = open.filter((v) => Math.abs(v.free - time) < eps);
    // A note pushed sideways by a neighbouring voice can land in the next column.
    const takes = [{ events: columns[index].events, next: index + 1 }];
    for (let next = index + 1; takes.at(-1).events.length < due.length && next < columns.length && columns[next].x - columns[index].x <= measure.space * 2.5; next++) {
      takes.push({ events: [...takes.at(-1).events, ...columns[next].events], next: next + 1 });
    }
    for (const take of takes.reverse()) {
      if (take.events.length > due.length) continue;
      for (const continuing of combinations(due, take.events.length)) {
        const stopped = due.filter((v) => !continuing.includes(v));
        for (const order of permutations(take.events)) {
          let cost = penalty + stopped.length * STOP;
          const updated = voices.map((v) => (due.includes(v) ? { ...v, events: [...v.events], stopped: stopped.includes(v) } : v));
          continuing.forEach((v, i) => {
            const target = updated[voices.indexOf(v)];
            const e = order[i];
            if (e.direction && e.direction !== 'none' && target.direction && target.direction !== 'none' && e.direction !== target.direction) cost += 1;
            target.events.push(e);
            target.free += eventLength(e, barLength);
            if (e.direction && e.direction !== 'none') target.direction = e.direction;
          });
          search(take.next, updated, cost);
        }
      }
    }
  };
  search(0, [], 0);
  if (!best) return null;
  // Higher voices first, as notation software numbers them.
  const height = (voice) => {
    const ys = voice.flatMap((e) => (e.rest ? [] : e.primary.map((h) => h.y)));
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : -Infinity;
  };
  return best.voices.sort((a, b) => height(b) - height(a));
}

// Fallback for a measure whose rhythm does not add up: up stems in one voice, everything else
// in x order in the other.
function fallbackVoices(measure) {
  const events = [...measure.chords.filter((c) => !c.grace), ...measure.rests].sort((a, b) => a.xc - b.xc);
  const up = events.filter((e) => e.direction === 'up');
  const rest = events.filter((e) => e.direction !== 'up');
  return up.length && rest.length ? [up, rest] : [events];
}

function tuningFromText(lines, count) {
  const tuning = [...(STANDARD_TUNINGS[count] ?? STANDARD_TUNINGS[6])];
  const closest = (pitchClass, reference) => {
    let best = reference;
    for (let p = reference - 6; p <= reference + 6; p++) if (((p % 12) + 12) % 12 === pitchClass) { best = p; break; }
    return best;
  };
  for (const line of lines) {
    if (/drop\s*d/i.test(line) && count >= 6) tuning[5] = 38;
    for (const match of line.matchAll(/([\u2460-\u2467])\s*=\s*([A-G])\s*([#b♯♭]?)/g)) {
      const string = match[1].codePointAt(0) - 0x2460;
      if (string >= tuning.length) continue;
      const pitchClass = (PITCH_CLASSES[match[2]] + (/[#♯]/.test(match[3]) ? 1 : /[b♭]/.test(match[3]) ? -1 : 0) + 12) % 12;
      tuning[string] = closest(pitchClass, tuning[string]);
    }
  }
  return tuning;
}

const quote = (text) => `"${text.replace(/["\\]/g, '')}"`;
const DURATIONS = new Map([[8, 0.5], [4, 1], [2, 2], [1, 4], [0.5, 8], [0.25, 16], [0.125, 32], [0.0625, 64], [0.03125, 128]]);

function noteTex(note) {
  if (note.tied) return `${note.fret === 'x' ? 'x' : note.fret}.${note.string}{t}`;
  const effects = [...note.effects];
  // alphaTab stores artificial/tapped harmonics relative to the fretted note; TAB prints the absolute fret.
  if (note.harmonic) effects.push(note.harmonic.type === 'nh' ? 'nh' : `${note.harmonic.type} ${note.harmonic.value - (note.fret === 'x' ? 0 : note.fret)}`);
  if (note.slide) effects.push(note.slide);
  return `${note.fret === 'x' ? 'x' : note.fret}.${note.string}${effects.length ? `{${[...new Set(effects)].join(' ')}}` : ''}`;
}

const LETTERS = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const diatonic = (midi) => Math.floor(midi / 12) * 7 + LETTERS[((midi % 12) + 12) % 12];
const staffStep = (head, measure) => Math.round((head.y - measure.staffBottom) / (measure.space / 2));
const covers = (chord, column, space) => column.xc >= chord.x0 - space * 0.5 && column.xc <= chord.x1 + space * 0.5;

function tabColumns(measure) {
  const columns = [];
  for (const note of measure.tabNotes.filter((n) => !n.grace).sort((a, b) => a.xc - b.xc)) {
    const column = columns.at(-1);
    if (column && note.xc - column.xc <= measure.space * 0.6) column.notes.push(note); else columns.push({ xc: note.xc, notes: [note] });
  }
  return columns;
}

// Pairs descending targets with descending slots, keeping their order and minimising the total
// distance; surplus targets share their nearest slot.
function matchInOrder(targets, slots) {
  if (targets.length > slots.length) {
    return targets.map((t) => slots.reduce((best, s, i) => (Math.abs(s - t) < Math.abs(slots[best] - t) ? i : best), 0));
  }
  const cost = Array.from({ length: targets.length + 1 }, (_, i) => new Array(slots.length + 1).fill(i ? Infinity : 0));
  const take = (i, j) => cost[i - 1][j - 1] + Math.abs(targets[i - 1] - slots[j - 1]);
  for (let i = 1; i <= targets.length; i++) {
    for (let j = i; j <= slots.length; j++) cost[i][j] = Math.min(cost[i][j - 1], take(i, j));
  }
  const result = [];
  for (let i = targets.length, j = slots.length; i > 0; j--) if (cost[i][j] === take(i, j)) result[--i] = j - 1;
  return result;
}

function beatTex(event, notes, extra = []) {
  const duration = DURATIONS.get(event.value === 'bar' ? 1 : event.value) ?? 4;
  const effects = [...extra];
  if (event.dots === 2) effects.push('dd'); else if (event.dots === 1) effects.push('d');
  if (event.tuplet) effects.push(`tu ${event.tuplet}`);
  const body = notes.length ? `(${notes.map(noteTex).join(' ')})` : 'r';
  return `${body}.${event.value === 'bar' ? 1 : duration}${effects.length ? `{${[...new Set(effects)].join(' ')}}` : ''}`;
}

/**
 * @returns {Promise<{ tex: string, measures: number, uncertain: number[] } | null>} uncertain lists
 *   the measure numbers whose rhythm or TAB numbers could not be matched exactly.
 */
export async function readPdfTab(pdf, OPS) {
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const { glyphs, paths } = await pagePrimitives(await pdf.getPage(number), OPS);
    const page = { glyphs, paths, music: glyphs.filter((g) => g.text.codePointAt(0) >= 0xe000).map((g) => ({ ...g, cp: g.text.codePointAt(0) })) };
    page.words = wordsOf(glyphs);
    page.systems = findSystems(page, lineGroups(paths));
    pages.push(page);
  }
  const systems = pages.flatMap((p) => p.systems);
  if (!systems.length) return null;
  const uncertain = new Set();
  const measures = [];
  for (const s of systems) {
    const staffMiddle = (s.staffTop + s.staffBottom) / 2;
    for (const m of readSystem(s, s.page.words, s.page.paths, measures.length + 1)) measures.push({ ...m, staffMiddle, staffBottom: s.staffBottom });
  }
  if (!measures.some((m) => m.tabNotes.length)) return null;

  // Header text above the first system on the first page.
  const first = pages[0];
  const top = first.systems[0]?.staffTop ?? 0;
  const lines = [];
  for (const w of first.words.filter((w) => w.y > top + 20)) {
    const line = lines.find((l) => near(l.y, w.y, w.size * 0.4) && near(l.size, w.size, 1));
    if (line) line.words.push(w); else lines.push({ y: w.y, size: w.size, words: [w] });
  }
  for (const line of lines) line.text = line.words.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' ').trim();
  const allText = pages.flatMap((p) => p.words.map((w) => w.text));
  const capo = Number(allText.map((t) => /capo\s*(?:fret)?\s*:?\s*(\d+)/i.exec(t)?.[1]).find(Boolean) ?? 0);
  const tuning = tuningFromText(allText, measures[0].tuningLines);
  const pageWidth = Math.max(...first.systems.map((s) => s.x1));
  const header = lines.filter((l) => !/tuning|capo|^=|^\d+$/i.test(l.text) && near((Math.min(...l.words.map((w) => w.x0)) + Math.max(...l.words.map((w) => w.x1))) / 2, pageWidth / 2 + 10, 80))
    .sort((a, b) => b.y - a.y);
  const title = header.reduce((best, l) => (!best || l.size > best.size ? l : best), null);
  const rest = header.filter((l) => l !== title).map((l) => l.text);

  // Notation sits an octave (and possibly a capo) away from the TAB pitch; the staff offset comes
  // from columns holding one note under one notehead.
  const pitch = (n) => tuning[n.string - 1] + (n.fret === 'x' ? 0 : n.fret);
  const pairs = [];
  for (const m of measures) {
    for (const column of tabColumns(m)) {
      const over = m.chords.filter((c) => !c.grace && covers(c, column, m.space));
      const [note] = column.notes;
      if (over.length === 1 && over[0].primary.length === 1 && column.notes.length === 1 && note.fret !== 'x' && !note.harmonic) {
        pairs.push([staffStep(over[0].primary[0], m), pitch(note)]);
      }
    }
  }
  let calibration = { shift: 0, offset: 0, hits: -1 };
  for (const shift of new Set([capo, 0])) {
    const counts = new Map();
    for (const [step, p] of pairs) counts.set(step - diatonic(p + shift), (counts.get(step - diatonic(p + shift)) || 0) + 1);
    for (const [offset, hits] of counts) if (hits > calibration.hits) calibration = { shift, offset, hits };
  }
  const predicted = (n) => diatonic(pitch(n) + calibration.shift) + calibration.offset;

  // Measures → alphaTex, one block per voice.
  const voiceBars = [];
  const lastNotes = [];
  let meter = { numerator: 4, denominator: 4 };
  let tempo = null;
  measures.forEach((measure, index) => {
    const changed = measure.meter && (measure.meter.numerator !== meter.numerator || measure.meter.denominator !== meter.denominator || index === 0);
    if (measure.meter) meter = measure.meter;
    const barLength = meter.numerator * 4 / meter.denominator;
    let voices = scheduleVoices(measure, barLength);
    if (!voices) {
      uncertain.add(index + 1);
      voices = fallbackVoices(measure);
    }
    const notesOf = new Map(voices.flat().filter((e) => !e.rest).map((c) => [c, []]));

    // Each TAB column belongs to the notation chord(s) above it. With several voices in a column
    // the notes go to the noteheads at their predicted staff positions, in pitch order.
    const chords = [...notesOf.keys()];
    for (const column of tabColumns(measure)) {
      let candidates = chords.filter((c) => covers(c, column, measure.space));
      if (!candidates.length) {
        const nearest = chords.sort((a, b) => Math.abs(a.xc - column.xc) - Math.abs(b.xc - column.xc))[0];
        if (nearest && Math.abs(nearest.xc - column.xc) < measure.space * 2) candidates = [nearest];
      }
      if (!candidates.length) { uncertain.add(index + 1); continue; }
      if (candidates.length === 1) { notesOf.get(candidates[0]).push(...column.notes); continue; }
      const slots = candidates.flatMap((c) => c.primary.map((h) => ({ step: staffStep(h, measure), chord: c }))).sort((a, b) => b.step - a.step);
      const ordered = [...column.notes].sort((a, b) => predicted(b) - predicted(a));
      for (const [note, slot] of matchInOrder(ordered.map(predicted), slots.map((s) => s.step)).map((s, i) => [ordered[i], slots[s]])) {
        notesOf.get(slot.chord).push(note);
      }
    }
    for (const [chord, notes] of notesOf) {
      notes.sort((a, b) => a.string - b.string);
      chord.notes = notes;
    }
    // A note tied over the barline stays in the voice it came from, even where notation software
    // prints it stacked with another voice's note.
    voices.forEach((voice, v) => {
      const first = voice[0];
      if (!first || first.rest) return;
      for (const note of first.notes.filter((n) => n.tied)) {
        const same = (n) => n.string === note.string && n.fret === note.fret;
        if (lastNotes[v]?.some(same)) continue;
        const origin = lastNotes.findIndex((notes, w) => w !== v && notes?.some(same));
        if (origin < 0 || voices[origin]?.length) continue;
        while (voices.length <= origin) voices.push([]);
        first.notes = first.notes.filter((n) => n !== note);
        voices[origin] = [{ ...first, notes: [note] }];
      }
    });
    // A notehead without a TAB number continues a tied note (tab often hides tie continuations).
    voices.forEach((voice, v) => {
      for (const event of voice) {
        if (event.rest) continue;
        if (!event.notes.length && lastNotes[v]?.length) {
          event.notes = [...lastNotes[v]].sort((a, b) => pitch(b) - pitch(a)).slice(0, event.primary.length)
            .map((n) => ({ ...n, tied: true, effects: [], harmonic: undefined, slide: undefined }));
        }
        if (!event.notes.length) uncertain.add(index + 1);
        lastNotes[v] = event.notes;
      }
    });

    // Grace notes go before the next main note of their voice.
    const graces = new Map();
    for (const grace of measure.chords.filter((c) => c.grace)) {
      const target = chords.filter((c) => c.xc > grace.xc && c.xc - grace.xc < measure.space * 8)
        .sort((a, b) => (a.xc - b.xc) || (Math.abs(a.primary[0].y - grace.primary[0].y) - Math.abs(b.primary[0].y - grace.primary[0].y)))[0];
      const notes = measure.tabNotes.filter((n) => n.grace && near(n.xc, grace.xc, measure.space * 1.5));
      if (!target || !notes.length) continue;
      if (!graces.has(target)) graces.set(target, []);
      graces.get(target).push({ ...grace, value: grace.value > 0.5 ? 0.5 : grace.value, dots: 0, tuplet: 0, notes });
    }

    // Beat effects attached to columns: arpeggio arrows, pick strokes, tempo changes.
    const columnEffects = new Map();
    // Arpeggios and strokes apply to every voice in their column with one roll speed, so the
    // player rolls the column as one chord (ticks between strings: arpeggio 120, brush 30);
    // a tempo change goes to one beat.
    const ROLL = { ad: 120, au: 120, bd: 30, bu: 30 };
    const addEffect = (x, effect, reach, column = true) => {
      const ahead = chords.filter((c) => c.xc >= x - measure.space && c.xc - x < reach).sort((a, b) => a.xc - b.xc);
      if (!ahead.length) return;
      const targets = column ? ahead.filter((c) => c.xc - ahead[0].xc <= measure.space) : [ahead[0]];
      const strings = new Set(targets.flatMap((c) => c.notes.filter((n) => !n.tied).map((n) => n.string))).size;
      const value = ROLL[effect] ? `${effect} ${ROLL[effect] * Math.max(1, strings - 1)}` : effect;
      for (const target of targets) {
        if (!columnEffects.has(target)) columnEffects.set(target, []);
        columnEffects.get(target).push(value);
      }
    };
    for (const mark of measure.marks) addEffect(mark.x, mark.effect, mark.reach);
    let barTempo = '';
    for (const t of measure.tempos) {
      if (tempo === null) { tempo = t.bpm; continue; }
      if (t.bpm === tempo) continue;
      tempo = t.bpm;
      const target = voices[0].filter((e) => e.xc >= t.x - measure.space).sort((a, b) => a.xc - b.xc)[0];
      if (target && !target.rest && target !== voices[0][0]) addEffect(target.xc, `tempo ${t.bpm}`, measure.space, false);
      else barTempo = `\\tempo ${t.bpm} `;
    }

    voices.forEach((voice, v) => {
      const beats = [];
      for (const event of voice) {
        for (const grace of graces.get(event) ?? []) beats.push(beatTex(grace, grace.notes, ['gr']));
        beats.push(beatTex(event, event.rest ? [] : event.notes, columnEffects.get(event) ?? []));
      }
      const prefix = v === 0 ? `${measure.section ? `\\section ${quote(measure.section)} ` : ''}${changed ? `\\ts ${meter.numerator} ${meter.denominator} ` : ''}${barTempo}` : '';
      voiceBars[v] ??= new Array(index).fill('');
      voiceBars[v][index] = `${prefix}${beats.join(' ')}`;
    });
  });

  const tuningText = tuning.map((p) => `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`).join(' ');
  const head = [
    title && `\\title ${quote(title.text)}`,
    rest[0] && `\\subtitle ${quote(rest[0])}`,
    rest.length > 1 && `\\artist ${quote(rest.slice(1).join(' · '))}`,
    tempo && `\\tempo ${measures[0].tempos[0]?.bpm ?? tempo}`,
    // The PDF prints no dynamics unless written; alphaTab would otherwise show its default.
    '\\hideDynamics',
  ].filter(Boolean).join(' ');
  const staff = `\\track "Guitar" \\staff {tabs score} \\tuning (${tuningText}) \\instrument 25${capo ? ` \\capo ${capo}` : ''}`;
  const voiceText = voiceBars.map((bars) => `\\voice ${Array.from({ length: measures.length }, (_, i) => bars[i] ?? '').join(' | ')}`).join(' ');
  return { tex: `${head} . ${staff} ${voiceText}`, measures: measures.length, uncertain: [...uncertain].sort((a, b) => a - b) };
}
