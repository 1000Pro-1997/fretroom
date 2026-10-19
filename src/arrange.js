import * as alphaTab from '@coderline/alphatab';
import { chordDiagram, detectChord, parseChordName, pitchName, transposeChordName } from './chords.js';

// alphaTab stores tunings from the highest string down; note.string 1 is the
// lowest string, so open[string - 1] below is its pitch (low → high).
export const TUNINGS = [
  { name: 'Standard', label: '표준 튜닝', open: [40, 45, 50, 55, 59, 64] },
  { name: 'Drop D', label: 'Drop D', open: [38, 45, 50, 55, 59, 64] },
  { name: 'Half step down', label: '반음 내림 튜닝', open: [39, 44, 49, 54, 58, 63] },
  { name: 'DADGAD', label: 'DADGAD', open: [38, 45, 50, 55, 57, 62] },
  { name: 'Open D', label: 'Open D', open: [38, 45, 50, 54, 57, 62] },
  { name: 'Open G', label: 'Open G', open: [38, 43, 50, 55, 59, 62] },
  { name: 'Open C', label: 'Open C', open: [36, 43, 48, 55, 60, 64] },
];
const STANDARD = TUNINGS[0];
const MAX_FRET = 17;
const LOWEST = STANDARD.open[0];
const MELODY_LOWEST = 52;
const guitarFor = (tuning) => ({ tuning, open: tuning.open, lowest: tuning.open[0], highest: tuning.open[5] + MAX_FRET });
const GENERATED_GRID = 240;
const BEAM = 32;
const MAX_ACCOMPANIMENT_NOTES = 4;
const DURATIONS = [
  [3840, 1, 0], [2880, 2, 1], [1920, 2, 0], [1440, 4, 1], [960, 4, 0], [720, 8, 1],
  [480, 8, 0], [360, 16, 1], [240, 16, 0], [120, 32, 0], [60, 64, 0],
];

export const DEFAULT_ARRANGE_OPTIONS = { keyMode: 'auto', maxSpan: 4, accompaniment: 'full' };

export function hasGuitarTab(score) {
  return score.tracks.some((track) => !track.isPercussion &&
    track.staves.some((staff) => !staff.isPercussion && staff.isStringed && staff.tuning.length >= 6));
}

function playableBeats(voice) {
  return voice ? voice.beats.filter((beat) => beat.graceType === alphaTab.model.GraceType.None) : [];
}

// Start/end ticks as the arranged score will have them: grace beats are
// removed, so every remaining beat gets its full written duration.
function beatTimes(voice, barStart) {
  const times = [];
  let at = barStart;
  for (const beat of playableBeats(voice)) {
    times.push({ beat, start: at, end: at + beat.displayDuration });
    at += beat.displayDuration;
  }
  return times;
}

// A line is one voice of one staff. MusicXML importers often leave voice 0
// empty and put the music in later voices, so lines are ranked by content.
function collectLines(score) {
  const lines = [];
  for (const track of score.tracks) {
    if (track.isPercussion) continue;
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      const voiceCount = Math.max(0, ...staff.bars.map((bar) => bar.voices.length));
      for (let voice = 0; voice < voiceCount; voice++) {
        let sum = 0;
        let count = 0;
        for (const bar of staff.bars) for (const beat of playableBeats(bar.voices[voice])) {
          for (const note of beat.notes) { sum += note.realValue; count++; }
        }
        if (count) lines.push({ track, staff, voice, mean: sum / count, count });
      }
    }
  }
  return lines;
}

function lineBeats(line, masterBar) {
  return beatTimes(line.staff.bars[masterBar.index]?.voices[line.voice], masterBar.start);
}

function normalizeKeySignature(value, preferFlats) {
  let key = ((value % 12) + 12) % 12;
  if (key > 6 || (key === 6 && preferFlats)) key -= 12;
  return key;
}

// Collects every guitar note slot. The highest line becomes output voice 0
// (melody); the lowest line becomes output voice 1 (bass). Other lines only
// contribute notes that start together with a melody or bass beat.
function buildTimeline(score, options) {
  const lines = collectLines(score);
  if (!lines.length) throw new Error('기타로 옮길 음표가 없습니다.');
  const most = Math.max(...lines.map((line) => line.count));
  const melody = lines.filter((line) => line.count >= most * 0.25)
    .reduce((best, line) => (line.mean > best.mean ? line : best));
  const bassCandidates = lines.filter((line) => line !== melody && line.count >= most * 0.15 && line.mean < melody.mean);
  const bass = options.accompaniment === 'none' || !bassCandidates.length ? null
    : bassCandidates.reduce((best, line) => (line.mean < best.mean ? line : best));
  const others = lines.filter((line) => line !== melody && line !== bass).sort((a, b) => b.mean - a.mean);

  const bars = [];
  const slotByNote = new Map();
  const allSlots = [];
  const makeSlot = (outBeat, note, role) => {
    const origin = note.isTieDestination && note.tieOrigin ? slotByNote.get(note.tieOrigin) : null;
    const slot = {
      beat: outBeat, pitch: note.realValue, role, start: outBeat.start, end: outBeat.end,
      tieFrom: origin && origin.beat.voice === outBeat.voice ? origin.root : null,
      dynamics: note.dynamics, accentuated: note.accentuated, isStaccato: note.isStaccato,
    };
    slot.root = slot.tieFrom || slot;
    slot.chainEnd = slot.end;
    if (slot.tieFrom) slot.root.chainEnd = Math.max(slot.root.chainEnd, slot.end);
    slotByNote.set(note, slot);
    outBeat.slots.push(slot);
    allSlots.push(slot);
    return slot;
  };
  const hasNotes = (times) => times.some(({ beat }) => beat.notes.length);

  for (const masterBar of score.masterBars) {
    const start = masterBar.start;
    const record = { index: masterBar.index, start, end: start + masterBar.calculateDuration(), voices: [[], []] };
    const toOutBeats = (times, voice) => times.map(({ beat, start: from, end }) => ({
      voice, source: beat, start: from, end, slots: [], chord: null,
    }));
    // When the melody line rests for a whole bar, the highest other line carries the tune.
    let melodyLine = melody;
    let melodyTimes = lineBeats(melody, masterBar);
    if (!hasNotes(melodyTimes)) {
      const stand = others.find((line) => hasNotes(lineBeats(line, masterBar)));
      if (stand) { melodyLine = stand; melodyTimes = lineBeats(stand, masterBar); }
    }
    record.melodyStaff = melodyLine.staff;
    record.voices[0] = toOutBeats(melodyTimes, 0);
    // Likewise the lowest other line fills in for a resting bass line.
    let bassLine = bass;
    if (bass && !hasNotes(lineBeats(bass, masterBar))) {
      bassLine = [...others].reverse().find((line) => line !== melodyLine && hasNotes(lineBeats(line, masterBar))) || bass;
    }
    if (bassLine) record.voices[1] = toOutBeats(lineBeats(bassLine, masterBar), 1);
    for (const outBeat of record.voices[0]) {
      const notes = [...outBeat.source.notes].sort((a, b) => b.realValue - a.realValue);
      notes.forEach((note, n) => {
        if (n > 0 && options.accompaniment !== 'full') return;
        makeSlot(outBeat, note, n === 0 ? 'melody' : 'inner');
      });
    }
    for (const outBeat of record.voices[1]) {
      const notes = [...outBeat.source.notes].sort((a, b) => a.realValue - b.realValue);
      notes.forEach((note, n) => {
        if (n > 0 && options.accompaniment !== 'full') return;
        makeSlot(outBeat, note, n === 0 ? 'bass' : 'inner');
      });
    }
    if (options.accompaniment === 'full') {
      for (const line of others) {
        if (line === melodyLine || line === bassLine) continue;
        for (const { beat, start: from } of lineBeats(line, masterBar)) {
          const at = (outBeat) => outBeat.start === from && !outBeat.source.isEmpty;
          const target = record.voices[1].find(at) || record.voices[0].find(at);
          if (!target) continue;
          for (const note of beat.notes) {
            if (note.isTieDestination) continue;
            if (target.slots.some((slot) => slot.pitch === note.realValue)) continue;
            makeSlot(target, note, 'inner');
          }
        }
      }
    }
    bars.push(record);
  }
  return { bars, allSlots, melody, bass, lines };
}

// Chord symbols written in the source win; otherwise chords are recognised
// from all sounding notes, per half bar in even meters and per bar otherwise.
function buildChordTimeline(score, lines, preferFlats) {
  const written = [];
  for (const line of lines) {
    for (const masterBar of score.masterBars) for (const { beat, start } of lineBeats(line, masterBar)) {
      const name = beat.chord?.name;
      if (name && parseChordName(name)) written.push({ tick: start, name });
    }
  }
  if (written.length) {
    written.sort((a, b) => a.tick - b.tick);
    return { source: 'written', chords: written.filter((chord, i) => i === 0 || chord.tick !== written[i - 1].tick) };
  }
  const notes = [];
  for (const line of lines) {
    for (const masterBar of score.masterBars) for (const { beat, start, end } of lineBeats(line, masterBar)) {
      for (const note of beat.notes) notes.push({ start, end, pitch: note.realValue });
    }
  }
  const chords = [];
  for (const masterBar of score.masterBars) {
    const length = masterBar.calculateDuration();
    const parts = masterBar.timeSignatureNumerator % 2 === 0 && masterBar.timeSignatureNumerator >= 4 ? 2 : 1;
    for (let p = 0; p < parts; p++) {
      const from = masterBar.start + (length * p) / parts;
      const to = masterBar.start + (length * (p + 1)) / parts;
      const weights = new Array(12).fill(0);
      let bass = null;
      let bassPitch = Infinity;
      for (const note of notes) {
        const overlap = Math.min(note.end, to) - Math.max(note.start, from);
        if (overlap <= 0) continue;
        weights[note.pitch % 12] += overlap;
        if (note.pitch < bassPitch && overlap >= (to - from) / 8) { bassPitch = note.pitch; bass = note.pitch % 12; }
      }
      const name = detectChord(weights, bass, preferFlats);
      if (name && chords.at(-1)?.name !== name) chords.push({ tick: from, name });
    }
  }
  return { source: 'detected', chords };
}

function splitDuration(position, length) {
  const pieces = [];
  let at = position;
  let remaining = length;
  while (remaining > 0) {
    const fit = DURATIONS.find(([ticks, , dots]) => ticks <= remaining && at % (dots ? ticks / 1.5 : ticks) === 0) ||
      DURATIONS.find(([ticks]) => ticks <= remaining);
    if (!fit) break;
    pieces.push({ ticks: fit[0], duration: fit[1], dots: fit[2] });
    at += fit[0];
    remaining -= fit[0];
  }
  return pieces;
}

// For a melody-only lead sheet, plays the chord bass (and chord tones in
// full mode) under the melody.
function generateAccompaniment(timeline, chordTimeline, allSlots, withChordTones) {
  const chords = chordTimeline.chords;
  for (const bar of timeline.bars) {
    const points = [];
    const carried = chords.filter((chord) => chord.tick <= bar.start).at(-1);
    if (carried) points.push({ tick: bar.start, name: carried.name });
    for (const chord of chords) {
      if (chord.tick <= bar.start || chord.tick >= bar.end) continue;
      const tick = bar.start + Math.floor((chord.tick - bar.start) / GENERATED_GRID) * GENERATED_GRID;
      if (points.at(-1)?.tick === tick) points.at(-1).name = chord.name;
      else points.push({ tick, name: chord.name });
    }
    const beats = [];
    let at = bar.start;
    const rest = (until) => {
      for (const piece of splitDuration(at - bar.start, until - at)) {
        beats.push({ voice: 1, generated: piece, start: at, end: at + piece.ticks, slots: [], chord: null });
        at += piece.ticks;
      }
    };
    points.forEach((point, p) => {
      if (point.tick > at) rest(point.tick);
      const end = points[p + 1]?.tick ?? bar.end;
      const chord = parseChordName(point.name);
      const bassPc = chord.bass ?? chord.root;
      const bassPitch = LOWEST + ((bassPc - LOWEST % 12 + 12) % 12);
      const upper = !withChordTones ? [] : chord.intervals.slice(1).map((interval) => {
        const pc = (chord.root + interval) % 12;
        return 52 + ((pc - 52 % 12 + 12) % 12);
      });
      let first = null;
      for (const piece of splitDuration(at - bar.start, end - at)) {
        const outBeat = { voice: 1, generated: piece, start: at, end: at + piece.ticks, slots: [], chord: null };
        const pitches = [{ pitch: bassPitch, role: 'bass' }, ...upper.map((pitch) => ({ pitch, role: 'inner' }))];
        pitches.forEach(({ pitch, role }, n) => {
          const origin = first?.[n];
          const slot = { beat: outBeat, pitch, role, start: outBeat.start, end: outBeat.end, tieFrom: origin ? origin.root : null };
          slot.root = slot.tieFrom || slot;
          slot.chainEnd = slot.end;
          if (slot.tieFrom) slot.root.chainEnd = Math.max(slot.root.chainEnd, slot.end);
          outBeat.slots.push(slot);
          allSlots.push(slot);
        });
        first ||= outBeat.slots;
        beats.push(outBeat);
        at += piece.ticks;
      }
    });
    if (at < bar.end && beats.length) rest(bar.end);
    bar.voices[1] = beats;
  }
}

// From each chord change on: the chord shape held by the fretting hand (fret per
// string, index = string - 1, low → high; -1 muted) and the chord's pitch
// classes. Alternate (mostly open) tunings treat the open strings as the shape.
function chordShapes(chords, transpose, tuning) {
  return chords.map((chord) => {
    const name = transposeChordName(chord.name, transpose, false);
    const parsed = parseChordName(name);
    const tones = parsed ? parsed.intervals.map((interval) => (parsed.root + interval) % 12) : null;
    if (tuning !== STANDARD) return { tick: chord.tick, shape: [0, 0, 0, 0, 0, 0], tones };
    const diagram = chordDiagram(name);
    return { tick: chord.tick, shape: diagram ? [...diagram.strings].reverse() : null, tones };
  });
}

function chordAt(shapes, tick) {
  let found = null;
  for (const entry of shapes || []) {
    if (entry.tick > tick) break;
    found = entry;
  }
  return found;
}

function positionsOf(pitch, guitar) {
  const positions = [];
  for (let s = 0; s < 6; s++) {
    const fret = pitch - guitar.open[s];
    if (fret >= 0 && fret <= MAX_FRET) positions.push({ string: s + 1, fret });
  }
  return positions;
}

function chooseMelodyOctave(slots, transpose, guitar) {
  const melody = slots.filter((slot) => slot.role === 'melody' && !slot.tieFrom);
  let best = { shift: 0, cost: Infinity };
  for (const shift of [-24, -12, 0, 12]) {
    let cost = 0;
    for (const slot of melody) {
      const pitch = slot.pitch + transpose + shift;
      if (pitch < MELODY_LOWEST || pitch > guitar.highest) cost += 5;
      // Keep the written octave unless the melody leaves the comfortable guitar range.
      cost += Math.max(0, pitch - 79, 55 - pitch) * 0.3 + (Math.abs(shift) / 12) * 0.2;
    }
    if (cost < best.cost) best = { shift, cost };
  }
  return best;
}

function foldMelody(pitch, guitar) {
  let folded = pitch;
  while (folded > guitar.highest) folded -= 12;
  while (folded < MELODY_LOWEST) folded += 12;
  return folded;
}

function fingeringCost(notes, maxSpan) {
  const fretted = notes.filter((note) => note.fret > 0);
  if (!fretted.length) return { ok: true, cost: 0, hand: null, min: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (const note of fretted) { min = Math.min(min, note.fret); max = Math.max(max, note.fret); }
  const span = max - min;
  if (span > maxSpan - 1) return { ok: false };
  const atMin = fretted.filter((note) => note.fret === min).length;
  const fingers = atMin >= 2 ? fretted.length - atMin + 1 : fretted.length;
  if (fingers > 4) return { ok: false };
  let cost = span * 0.5 + fingers * 0.3 + (atMin >= 2 && fretted.length > atMin ? 0.8 : 0);
  if (span >= 4) cost += 1.5;
  for (const note of fretted) cost += note.fret * 0.08 + (note.fret > 12 ? 0.3 : 0);
  return { ok: true, cost, hand: min, min, max };
}

// One event = every slot attacked at the same tick. Candidates are every
// playable assignment with melody always kept and accompaniment dropped or
// moved by octaves when it does not fit under the hand. For recordings
// (options.recording) hard notes may also become similar notes: a melody note
// an octave away, or an accompaniment note replaced by a nearby chord tone.
function eventCandidates(event, pitchOf, melodyCeiling, options) {
  const items = [];
  const { guitar } = options;
  if (event.melody) {
    const pitch = pitchOf(event.melody);
    const choices = [{ pitch, shift: 0, cost: 0 }];
    if (options.recording) {
      for (const q of [pitch - 12, pitch + 12]) if (q >= MELODY_LOWEST && q <= guitar.highest) choices.push({ pitch: q, shift: 0, cost: 4, similar: true });
    }
    items.push({ slot: event.melody, options: choices });
  }
  for (const slot of event.accompaniment) {
    const base = pitchOf(slot);
    const valid = (pitch) => pitch >= guitar.lowest && pitch <= guitar.highest && pitch < melodyCeiling;
    const choices = [];
    if (valid(base)) {
      choices.push({ pitch: base, shift: 0, cost: 0 });
      if (melodyCeiling - base > 19 && valid(base + 12)) choices.push({ pitch: base + 12, shift: 1, cost: 2 });
    } else {
      for (const k of [1, -1, 2, -2, 3]) {
        if (valid(base + 12 * k)) { choices.push({ pitch: base + 12 * k, shift: Math.abs(k), cost: Math.abs(k) * 2 }); break; }
      }
    }
    if (options.recording && event.tones) {
      for (const step of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
        const q = base + step;
        if (event.tones.includes(q % 12) && valid(q)) { choices.push({ pitch: q, shift: 0, cost: 2.5, similar: true }); break; }
      }
    }
    items.push({ slot, options: choices });
  }
  const results = [];
  let worst = Infinity;
  const chosen = [];
  const usedStrings = new Set();
  const pitches = new Set();
  const push = (candidate) => {
    results.push(candidate);
    if (results.length > BEAM * 3) {
      results.sort((a, b) => a.cost - b.cost);
      results.length = BEAM;
      worst = results.at(-1).cost;
    }
  };
  const visit = (index, partial) => {
    if (partial >= worst) return;
    if (index === items.length) {
      const fingering = fingeringCost(chosen, options.maxSpan);
      if (!fingering.ok) return;
      const top = chosen.find((note) => note.slot.role === 'melody');
      if (top && chosen.some((note) => note !== top && note.pitch >= top.pitch)) return;
      let cost = partial + fingering.cost;
      const kept = chosen.map((note) => note.pitch % 12);
      for (const item of items) {
        if (chosen.some((note) => note.slot === item.slot)) continue;
        const doubled = kept.includes(pitchOf(item.slot) % 12);
        cost += doubled ? 1 : item.slot.role === 'bass' ? 7 : 3;
      }
      // Chord-based fingerstyle: the hand holds the current chord shape and the
      // melody moves only a few fingers away from it.
      if (event.shape) {
        for (const note of chosen) {
          const held = event.shape[note.string - 1];
          if (note.fret > 0 && held !== note.fret) cost += held > 0 ? 0.45 : 0.3;
          else if (note.fret === 0 && held !== 0) cost += 0.1;
        }
      }
      const melodyNote = chosen.find((note) => note.slot.role === 'melody');
      if (melodyNote) {
        if (melodyNote.string <= 2) cost += 1;
        for (const note of chosen) if (note !== melodyNote && note.string > melodyNote.string) cost += 1.5;
      }
      push({ notes: chosen.map((note) => ({ ...note })), cost, hand: fingering.hand, min: fingering.min, max: fingering.max });
      return;
    }
    const item = items[index];
    const isMelody = item.slot.role === 'melody';
    for (const choice of item.options) {
      if (pitches.has(choice.pitch)) continue;
      for (const position of positionsOf(choice.pitch, options.guitar)) {
        if (usedStrings.has(position.string)) continue;
        usedStrings.add(position.string);
        pitches.add(choice.pitch);
        chosen.push({ slot: item.slot, pitch: choice.pitch, shift: choice.shift, similar: Boolean(choice.similar), ...position });
        visit(index + 1, partial + choice.cost);
        chosen.pop();
        pitches.delete(choice.pitch);
        usedStrings.delete(position.string);
      }
    }
    if (!isMelody) visit(index + 1, partial);
  };
  visit(0, 0);
  results.sort((a, b) => a.cost - b.cost);
  if (results.length > BEAM) results.length = BEAM;
  return results;
}

function transitionCost(previous, candidate, tick, maxSpan) {
  let cost = 0;
  if (previous.hand !== null && candidate.hand !== null) {
    const move = Math.abs(candidate.hand - previous.hand);
    cost += move * 0.35 + (move ? 0.3 : 0);
  }
  const used = new Set(candidate.notes.map((note) => note.string));
  let held = 0;
  for (const ringing of previous.sounding) {
    if (ringing.end <= tick) continue;
    if (used.has(ringing.string)) { cost += ringing.tied ? 20 : ringing.role === 'melody' ? 3 : 1.5; continue; }
    if (ringing.fret > 0) {
      held++;
      if (candidate.min !== null &&
          Math.max(candidate.max, ringing.fret) - Math.min(candidate.min, ringing.fret) > maxSpan - 1) cost += 2;
    }
  }
  const fretted = candidate.notes.filter((note) => note.fret > 0).length;
  if (held + fretted > 4) cost += 1.5;
  const bass = candidate.notes.find((note) => note.slot.role === 'bass');
  if (bass && previous.bassShift !== null && bass.shift !== previous.bassShift) cost += 1;
  return cost;
}

// limitTick restricts the search to the start of the piece, used to rank many
// tuning/capo/key placements cheaply before solving the best ones in full.
function solve(timeline, transpose, options, limitTick = Infinity) {
  const guitar = options.guitar;
  const slots = timeline.allSlots.filter((slot) => slot.start < limitTick);
  // A recording sounds in the octave it was played; only notes the guitar cannot reach fold.
  const melodyOctave = options.recording ? { shift: 0 } : chooseMelodyOctave(slots, transpose, guitar);
  const pitchOf = (slot) => (slot.role === 'melody'
    ? foldMelody(slot.pitch + transpose + melodyOctave.shift, guitar)
    : slot.pitch + transpose);
  const groups = new Map();
  for (const slot of slots) {
    if (slot.tieFrom) continue;
    if (!groups.has(slot.start)) groups.set(slot.start, { tick: slot.start, melody: null, accompaniment: [] });
    const group = groups.get(slot.start);
    if (slot.role === 'melody') group.melody = slot;
    else group.accompaniment.push(slot);
  }
  const events = [...groups.values()].sort((a, b) => a.tick - b.tick);
  const melodyRoots = slots.filter((slot) => slot.role === 'melody' && !slot.tieFrom).sort((a, b) => a.start - b.start);
  let melodyIndex = 0;
  for (const event of events) {
    // Bass first, then inner voices from the top down, unique pitches only.
    const bassSlot = event.accompaniment.find((slot) => slot.role === 'bass');
    const inner = event.accompaniment.filter((slot) => slot !== bassSlot).sort((a, b) => b.pitch - a.pitch);
    const seen = new Set();
    event.accompaniment = [];
    for (const slot of [bassSlot, ...inner]) {
      if (!slot || seen.has(slot.pitch)) continue;
      seen.add(slot.pitch);
      if (event.accompaniment.length < MAX_ACCOMPANIMENT_NOTES) event.accompaniment.push(slot);
      else event.overflow = (event.overflow || 0) + 1;
    }
    while (melodyIndex + 1 < melodyRoots.length && melodyRoots[melodyIndex + 1].start <= event.tick) melodyIndex++;
    const current = melodyRoots[melodyIndex];
    event.ceiling = event.melody ? pitchOf(event.melody)
      : current && current.start <= event.tick && current.chainEnd > event.tick ? pitchOf(current) : Infinity;
    const chord = chordAt(options.shapes, event.tick);
    event.shape = chord?.shape ?? (options.guitar.open === STANDARD.open ? null : [0, 0, 0, 0, 0, 0]);
    event.tones = chord?.tones ?? null;
  }

  const start = { cost: 0, hand: null, sounding: [], bassShift: null, notes: [] };
  let layer = [start];
  const layers = [];
  for (const event of events) {
    const candidates = eventCandidates(event, pitchOf, event.ceiling, options);
    const next = candidates.map((candidate) => {
      let best = null;
      for (const previous of layer) {
        const total = previous.cost + transitionCost(previous, candidate, event.tick, options.maxSpan);
        if (!best || total < best.total) best = { previous, total };
      }
      const used = new Set(candidate.notes.map((note) => note.string));
      const sounding = best.previous.sounding.filter((ringing) => ringing.end > event.tick && !used.has(ringing.string));
      for (const note of candidate.notes) {
        sounding.push({ string: note.string, fret: note.fret, end: note.slot.chainEnd, role: note.slot.role, tied: note.slot.chainEnd > note.slot.end });
      }
      const bass = candidate.notes.find((note) => note.slot.role === 'bass');
      return {
        ...candidate, cost: best.total + candidate.cost, back: best.previous, sounding,
        hand: candidate.hand ?? best.previous.hand, bassShift: bass ? bass.shift : best.previous.bassShift,
      };
    });
    layers.push({ event, states: next });
    layer = next;
  }
  let state = layer.reduce((best, candidate) => (candidate.cost < best.cost ? candidate : best), layer[0]);
  const total = state.cost;
  const assignment = new Map();
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const note of state.notes) assignment.set(note.slot, note);
    state = state.back;
  }
  let dropped = 0;
  let shifted = 0;
  let similar = 0;
  for (const { event } of layers) {
    dropped += event.overflow || 0;
    if (event.melody && assignment.get(event.melody)?.similar) similar++;
    for (const slot of event.accompaniment) {
      const note = assignment.get(slot);
      if (!note) dropped++;
      else if (note.similar) similar++;
      else if (note.shift) shifted++;
    }
  }
  return { total, assignment, melodyShift: melodyOctave.shift, dropped, shifted, similar, events: events.length };
}

// A placement is a tuning, a capo and a key change. Every tuning/capo keeps
// the sounding key; auto mode also tries nearby keys in standard tuning.
// Recordings (options.recording) keep the key they were played in, so the tab can be played
// along with them; easy shapes come from a capo or an alternate tuning the player may have used.
// A fixed options.capo (from 연주 설정) restricts every placement to that capo.
function candidatePlacements(timeline, options) {
  const placements = [];
  const fixed = Number.isInteger(options.capo) ? options.capo : null;
  const capos = fixed !== null ? [fixed] : options.recording ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5];
  // Every alternate tuning lowers the bottom string, so a recording is only taken as retuned when
  // notes below the standard low E recur as a bass would (3 % of notes); otherwise standard tuning
  // plays it as recorded. Sporadic low notes are mostly octave-below detection errors.
  const struck = timeline.allSlots.filter((slot) => !slot.tieFrom);
  const belowStandard = struck.filter((slot) => slot.pitch < STANDARD.open[0]).length;
  const retuned = options.recording && belowStandard >= Math.max(6, struck.length * 0.03);
  for (const tuning of retuned ? TUNINGS : [STANDARD]) {
    for (const capo of capos) placements.push({ tuning, capo, transpose: -capo, keyChange: 0 });
  }
  if (options.keyMode === 'auto' && !options.recording) {
    const capo = fixed ?? 0;
    const ranked = [];
    for (let t = -5; t <= 6; t++) ranked.push({ t, cost: chooseMelodyOctave(timeline.allSlots, t, guitarFor(STANDARD)).cost + Math.abs(t) * 0.5 });
    ranked.sort((a, b) => a.cost - b.cost);
    for (const { t } of ranked.slice(0, 5)) if (t) placements.push({ tuning: STANDARD, capo, transpose: t - capo, keyChange: t });
  }
  return placements;
}

function placementPenalty(placement, chords) {
  let penalty = Math.abs(placement.keyChange) * 2 + (placement.capo ? 1 + placement.capo * 0.8 : 0) +
    (placement.tuning === STANDARD ? 0 : 4);
  // Open chord shapes are cleaner to play than barre or high-position chords.
  for (const chord of chords) {
    if (placement.tuning !== STANDARD) { penalty += 0.6; continue; }
    const diagram = chordDiagram(transposeChordName(chord.name, placement.transpose, false));
    penalty += !diagram ? 1 : diagram.barreFrets.length || diagram.firstFret > 1 ? 0.6 : 0;
  }
  return penalty;
}

function noteJson(slot, note, nextId) {
  return new Map([
    ['id', nextId()], ['string', note.string], ['fret', note.fret], ['istiedestination', Boolean(slot.tieFrom)],
    ['dynamics', slot.dynamics ?? alphaTab.model.DynamicValue.MF], ['accentuated', slot.accentuated ?? 0],
    ['isstaccato', Boolean(slot.isStaccato)],
  ]);
}

function sourceBeatJson(data, beat) {
  const bar = beat.voice.bar;
  return data.get('tracks')[bar.staff.track.index].get('staves')[bar.staff.index]
    .get('bars')[bar.index].get('voices')[beat.voice.index].get('beats')[beat.index];
}

// Arranges any score into one guitar track (tuning, capo and key chosen for playability) with tab, standard
// notation and chord names. Returns the new alphaTab score and a summary.
export function arrangeForGuitar(score, settings, requested = {}) {
  const options = { ...DEFAULT_ARRANGE_OPTIONS, ...requested };
  const timeline = buildTimeline(score, options);
  const sourceKey = timeline.melody.staff.bars[0]?.keySignature ?? 0;
  const chordTimeline = buildChordTimeline(score, timeline.lines, sourceKey < 0);
  if (!timeline.bass && options.accompaniment !== 'none' && chordTimeline.source === 'written') {
    generateAccompaniment(timeline, chordTimeline, timeline.allSlots, options.accompaniment === 'full');
  }

  const placements = candidatePlacements(timeline, options);
  const evaluate = (placement, limit) => {
    const shapes = chordShapes(chordTimeline.chords, placement.transpose, placement.tuning);
    const result = solve(timeline, placement.transpose, { ...options, guitar: guitarFor(placement.tuning), shapes }, limit);
    // An alternate tuning must make the piece clearly (8 %) easier than standard tuning.
    const margin = placement.tuning === STANDARD ? 1 : 1.08;
    return { result, total: result.total * margin + placementPenalty(placement, chordTimeline.chords.filter((chord) => chord.tick < limit)) };
  };
  // Rank all placements on the opening bars, then solve the best few in full.
  let finalists = placements;
  if (placements.length > 4 && timeline.bars.length > 16) {
    const limit = timeline.bars[15].end;
    finalists = placements.map((placement) => ({ placement, total: evaluate(placement, limit).total }))
      .sort((a, b) => a.total - b.total).slice(0, 4).map(({ placement }) => placement);
  }
  let best = null;
  for (const placement of finalists) {
    const { result, total } = evaluate(placement, Infinity);
    if (!best || total < best.score) best = { ...result, ...placement, score: total };
  }
  const { assignment, transpose, capo, tuning } = best;
  // Notation and key signature show the sounding key; with a capo the chord names
  // and diagrams follow the shapes the hand plays.
  const soundingKey = normalizeKeySignature(sourceKey + 7 * (transpose + capo), sourceKey < 0);
  const shapeKey = normalizeKeySignature(sourceKey + 7 * transpose, sourceKey < 0);
  const preferFlats = shapeKey < 0;

  // Tie continuations follow their origin; continuations of dropped notes vanish.
  for (const slot of timeline.allSlots) {
    if (slot.tieFrom && assignment.has(slot.tieFrom)) assignment.set(slot, assignment.get(slot.tieFrom));
  }

  const chordIds = new Map();
  for (const chord of chordTimeline.chords) {
    const name = transposeChordName(chord.name, transpose, preferFlats);
    const bar = timeline.bars.find((entry) => chord.tick >= entry.start && chord.tick < entry.end);
    if (!bar) continue;
    // Invisible beats (empty melody placeholders, accompaniment rests) cannot carry a chord name.
    const visible = (beat) => (beat.voice === 0 ? !beat.source?.isEmpty : beat.slots.some((slot) => assignment.has(slot)));
    const target = bar.voices[0].find((beat) => beat.start === chord.tick && visible(beat)) ||
      bar.voices[1].find((beat) => beat.start === chord.tick && visible(beat)) ||
      bar.voices[0].find((beat) => beat.start > chord.tick && visible(beat)) ||
      bar.voices[1].find((beat) => beat.start > chord.tick && visible(beat));
    if (!target || target.chord) continue;
    target.chord = name;
    // Diagrams use standard-tuning shapes, so alternate tunings show chord names only.
    chordIds.set(name, tuning === STANDARD ? chordDiagram(name) : null);
  }

  const data = alphaTab.model.JsonConverter.scoreToJsObject(score);
  let noteId = 0;
  const nextId = () => ++noteId;
  const staffJsonOf = (staff) => data.get('tracks')[staff.track.index].get('staves')[staff.index];
  const melodyStaffJson = staffJsonOf(timeline.melody.staff);
  const restBeats = (bar) => splitDuration(0, bar.end - bar.start).map(({ duration, dots }) =>
    new Map([['duration', duration], ['dots', dots], ['notes', []], ['isempty', false]]));
  const bars = timeline.bars.map((bar) => {
    const barJson = structuredClone(staffJsonOf(bar.melodyStaff).get('bars')[bar.index]);
    barJson.delete('id');
    barJson.set('clef', alphaTab.model.Clef.G2);
    barJson.set('clefottava', alphaTab.model.Ottavia.Regular);
    barJson.set('keysignature', normalizeKeySignature((barJson.get('keysignature') ?? 0) + 7 * (transpose + capo), sourceKey < 0));
    barJson.set('sustainpedals', []);
    const voices = bar.voices.map((beats, v) => {
      const beatJsons = beats.map((outBeat) => {
        let beatJson;
        if (outBeat.generated) {
          beatJson = new Map([['duration', outBeat.generated.duration], ['dots', outBeat.generated.dots]]);
        } else {
          beatJson = structuredClone(sourceBeatJson(data, outBeat.source));
          beatJson.delete('id');
          beatJson.set('ottava', alphaTab.model.Ottavia.Regular);
          beatJson.set('automations', (beatJson.get('automations') || []).filter((automation) =>
            automation.get('type') === alphaTab.model.AutomationType.Tempo));
          if (v === 1) beatJson.delete('lyrics');
        }
        // A tied continuation keeps its string; anything else on that string is dropped.
        const strings = new Set();
        const notes = outBeat.slots
          .filter((slot) => assignment.has(slot))
          .sort((a, b) => Boolean(b.tieFrom) - Boolean(a.tieFrom))
          .filter((slot) => !strings.has(assignment.get(slot).string) && strings.add(assignment.get(slot).string))
          .map((slot) => noteJson(slot, assignment.get(slot), nextId));
        beatJson.set('notes', notes);
        beatJson.set('chordid', outBeat.chord);
        // Accompaniment rests stay invisible so the tab is not cluttered with second-voice rests.
        beatJson.set('isempty', !notes.length && (v === 1 || (!outBeat.generated && outBeat.source.isEmpty)));
        return beatJson;
      });
      if (!beatJsons.some((beat) => !beat.get('isempty'))) {
        return new Map([['beats', v === 0 ? restBeats(bar)
          : [new Map([['duration', alphaTab.model.Duration.Whole], ['isempty', true], ['notes', []]])]]]);
      }
      return new Map([['beats', beatJsons]]);
    });
    if (!timeline.bass && !voices[1].get('beats').some((beat) => !beat.get('isempty'))) voices.length = 1;
    barJson.set('voices', voices);
    return barJson;
  });

  const staffJson = structuredClone(melodyStaffJson);
  staffJson.set('bars', bars);
  staffJson.set('chords', new Map([...chordIds].map(([name, diagram]) => [name, new Map([
    ['name', name], ['firstfret', diagram?.firstFret ?? 1], ['strings', diagram?.strings ?? []],
    ['barrefrets', diagram?.barreFrets ?? []], ['showname', true], ['showdiagram', Boolean(diagram)], ['showfingering', false],
  ])])));
  staffJson.set('capo', capo);
  staffJson.set('transpositionpitch', 0);
  staffJson.set('displaytranspositionpitch', -12);
  staffJson.set('stringtuning', new Map([['isstandard', tuning === STANDARD], ['name', tuning.name], ['tunings', [...tuning.open].reverse()]]));
  staffJson.set('showtablature', true);
  staffJson.set('showstandardnotation', true);
  staffJson.set('showslash', false);
  staffJson.set('shownumbered', false);
  staffJson.set('ispercussion', false);
  staffJson.set('standardnotationlinecount', 5);

  const trackJson = structuredClone(data.get('tracks')[timeline.melody.track.index]);
  trackJson.set('name', '기타 편곡');
  trackJson.set('shortname', 'Gtr');
  trackJson.get('playbackinfo').set('program', 24);
  trackJson.set('staves', [staffJson]);
  trackJson.set('systemslayout', []);
  trackJson.delete('linebreaks');
  trackJson.set('percussionarticulations', []);
  data.set('tracks', [trackJson]);
  data.set('systemslayout', []);

  const arranged = alphaTab.model.JsonConverter.jsObjectToScore(data, settings);
  const minor = (timeline.melody.staff.bars[0]?.keySignatureType ?? 0) === alphaTab.model.KeySignatureType.Minor;
  const tonic = pitchName((soundingKey * 7 + (minor ? 9 : 0)) % 12 + 12, soundingKey < 0) + (minor ? 'm' : '');
  return {
    score: arranged,
    summary: {
      transpose: transpose + capo,
      capo,
      tuning: tuning === STANDARD ? null : tuning.label,
      key: tonic,
      melodyShift: best.melodyShift,
      dropped: best.dropped,
      shifted: best.shifted,
      similar: best.similar,
      chords: chordIds.size,
      chordSource: chordIds.size ? chordTimeline.source : null,
      melodyPart: timeline.melody.track.name || '',
    },
  };
}
