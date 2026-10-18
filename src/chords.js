// Chord names, chord recognition from pitch classes and guitar chord diagrams.

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const QUALITY_INTERVALS = {
  '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  dim: [0, 3, 6], dim7: [0, 3, 6, 9], aug: [0, 4, 8], m7b5: [0, 3, 6, 10],
  sus4: [0, 5, 7], sus2: [0, 2, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
};
// Qualities tried by recognition, with a small complexity cost so plain triads win ties.
const DETECTABLE = [
  ['', 0], ['m', 0], ['7', 0.06], ['maj7', 0.08], ['m7', 0.06], ['dim', 0.1],
  ['m7b5', 0.12], ['sus4', 0.1], ['aug', 0.14],
];

export function pitchName(pc, preferFlats) {
  return (preferFlats ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

function parseRoot(text) {
  const match = /^([A-G])([#b♯♭]*)/.exec(text);
  if (!match) return null;
  let pc = LETTER_PC[match[1]];
  for (const sign of match[2]) pc += sign === '#' || sign === '♯' ? 1 : -1;
  return { pc: ((pc % 12) + 12) % 12, length: match[0].length };
}

// Maps the free-form suffix of a chord symbol to one of QUALITY_INTERVALS.
export function qualityOf(suffix) {
  const s = suffix.replace(/^\s+/, '');
  if (/^(m7b5|m7-5|min7b5|-7b5|ø)/.test(s)) return 'm7b5';
  if (/^(dim7|°7|o7)/.test(s)) return 'dim7';
  if (/^(dim|°|o(?!m))/.test(s)) return 'dim';
  if (/^(aug|\+)/.test(s)) return 'aug';
  if (/^(maj|ma|M|Δ)(7|9|11|13)/.test(s) || /^Δ/.test(s)) return 'maj7';
  if (/^(maj|M)(?![a-z])/.test(s)) return '';
  if (/^(m|min|mi|-)(?!aj)/.test(s)) {
    const rest = s.replace(/^(min|mi|m|-)/, '');
    if (/^(7|9|11|13)/.test(rest)) return 'm7';
    if (/^6/.test(rest)) return 'm6';
    return 'm';
  }
  if (/^sus2/.test(s)) return 'sus2';
  if (/sus/.test(s)) return 'sus4';
  if (/^(7|9|11|13)/.test(s)) return '7';
  if (/^6/.test(s)) return '6';
  return '';
}

export function parseChordName(name) {
  if (typeof name !== 'string') return null;
  const text = name.trim();
  const root = parseRoot(text);
  if (!root) return null;
  let suffix = text.slice(root.length);
  let bass = null;
  const slash = suffix.lastIndexOf('/');
  if (slash >= 0) {
    const parsed = parseRoot(suffix.slice(slash + 1));
    if (parsed && parsed.length === suffix.length - slash - 1) {
      bass = parsed.pc;
      suffix = suffix.slice(0, slash);
    }
  }
  const quality = qualityOf(suffix);
  return { root: root.pc, suffix, quality, bass, intervals: QUALITY_INTERVALS[quality] };
}

export function transposeChordName(name, semitones, preferFlats) {
  const chord = semitones % 12 === 0 ? null : parseChordName(name);
  if (!chord) return name;
  const bass = chord.bass === null ? '' : `/${pitchName(chord.bass + semitones, preferFlats)}`;
  return `${pitchName(chord.root + semitones, preferFlats)}${chord.suffix}${bass}`;
}

// weights: duration-weighted presence of each pitch class; bass: lowest sounding pitch class.
export function detectChord(weights, bass, preferFlats) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const strongest = Math.max(...weights);
  let best = null;
  for (let root = 0; root < 12; root++) {
    for (const [quality, complexity] of DETECTABLE) {
      const tones = QUALITY_INTERVALS[quality].map((interval) => (root + interval) % 12);
      const missing = tones.filter((tone) => weights[tone] < strongest * 0.08);
      // Plain triads may omit a tone; colour chords (7ths, dim, aug, sus) need every tone.
      if (missing.length && tones.length > 3 || missing.length && quality !== '' && quality !== 'm') continue;
      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        const weight = weights[pc];
        if (tones.includes(pc)) score += pc === root ? weight * 1.15 : weight;
        else score -= weight;
      }
      for (const tone of missing) score -= strongest * (tone === root ? 0.6 : 0.35);
      if (bass === root) score += total * 0.2;
      else if (bass !== null && tones.includes(bass)) score += total * 0.05;
      score -= total * complexity;
      if (!best || score > best.score) best = { root, quality, score, tones };
    }
  }
  if (!best || best.score < total * 0.3) return null;
  const slash = bass !== null && bass !== best.root && best.tones.includes(bass) ? `/${pitchName(bass, preferFlats)}` : '';
  return `${pitchName(best.root, preferFlats)}${best.quality}${slash}`;
}

// Fret offsets per string from low E to high E; null = muted.
const MOVABLE_SHAPES = [
  { rootString: 0, shapes: {
    '': [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], 7: [0, 2, 0, 1, 0, 0], maj7: [0, 2, 1, 1, 0, 0],
    m7: [0, 2, 0, 0, 0, 0], sus4: [0, 2, 2, 2, 0, 0], 6: [0, 2, 2, 1, 2, 0], m6: [0, 2, 2, 0, 2, 0],
    aug: [0, 3, 2, 1, 1, 0], dim: [0, 1, 2, 0, null, null], m7b5: [0, null, 0, 0, -1, null], dim7: [0, null, -1, 0, -1, null],
  } },
  { rootString: 1, shapes: {
    '': [null, 0, 2, 2, 2, 0], m: [null, 0, 2, 2, 1, 0], 7: [null, 0, 2, 0, 2, 0], maj7: [null, 0, 2, 1, 2, 0],
    m7: [null, 0, 2, 0, 1, 0], sus4: [null, 0, 2, 2, 3, 0], sus2: [null, 0, 2, 2, 0, 0], dim: [null, 0, 1, 2, 1, null],
    dim7: [null, 0, 1, 2, 1, 2], m7b5: [null, 0, 1, 0, 1, null], aug: [null, 0, 3, 2, 2, 1], 6: [null, 0, 2, 2, 2, 2],
    m6: [null, 0, 2, 2, 1, 2],
  } },
];
const OPEN_D_SHAPES = {
  '': [null, null, 0, 2, 3, 2], m: [null, null, 0, 2, 3, 1], 7: [null, null, 0, 2, 1, 2], maj7: [null, null, 0, 2, 2, 2],
  m7: [null, null, 0, 2, 1, 1], sus4: [null, null, 0, 2, 3, 3], sus2: [null, null, 0, 2, 3, 0], 6: [null, null, 0, 2, 0, 2],
  m6: [null, null, 0, 2, 0, 1], dim: [null, null, 0, 1, 3, 1], dim7: [null, null, 0, 1, 0, 1], aug: [null, null, 0, 3, 3, 2],
  m7b5: [null, null, 0, 1, 1, 1],
};
const OPEN_SPECIALS = {
  0: { '': [null, 3, 2, 0, 1, 0], 7: [null, 3, 2, 3, 1, 0], maj7: [null, 3, 2, 0, 0, 0] },
  7: { '': [3, 2, 0, 0, 0, 3], 7: [3, 2, 0, 0, 0, 1], maj7: [3, 2, 0, 0, 0, 2] },
  11: { 7: [null, 2, 1, 2, 0, 2] },
};
const STRING_ROOTS = [4, 9, 2, 7, 11, 4];

// Returns alphaTab chord diagram data (strings ordered from high E to low E) or null.
export function chordDiagram(name) {
  const chord = parseChordName(name);
  if (!chord) return null;
  const candidates = [];
  const special = OPEN_SPECIALS[chord.root]?.[chord.quality];
  if (special) candidates.push({ frets: special, cost: 0, barre: null });
  if (chord.root === 2 && OPEN_D_SHAPES[chord.quality]) candidates.push({ frets: OPEN_D_SHAPES[chord.quality], cost: 0, barre: null });
  for (const { rootString, shapes } of MOVABLE_SHAPES) {
    const shape = shapes[chord.quality];
    if (!shape) continue;
    const position = (chord.root - STRING_ROOTS[rootString] + 12) % 12;
    if (shape.some((offset) => offset !== null && offset + position < 0)) continue;
    const frets = shape.map((offset) => (offset === null ? null : offset + position));
    const barre = position > 0 && shape.filter((offset) => offset === 0).length >= 2 ? position : null;
    candidates.push({ frets, cost: position + (barre ? 0.5 : 0), barre });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.cost - b.cost);
  const { frets, barre } = candidates[0];
  const positive = frets.filter((fret) => fret !== null && fret > 0);
  const firstFret = positive.length && Math.max(...positive) > 5 ? Math.min(...positive) : 1;
  return {
    strings: frets.map((fret) => (fret === null ? -1 : fret)).reverse(),
    firstFret,
    barreFrets: barre ? [barre] : [],
  };
}
