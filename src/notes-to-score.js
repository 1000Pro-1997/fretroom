// Detected notes → MusicXML. A dynamic-programming beat tracker finds the
// pulse and notes are quantized to sixteenths between neighbouring beats, so
// tempo drift in a live performance stays in time.
const ENVELOPE_RATE = 100;
const SUBDIVISIONS = 4;
const BAR_SIXTEENTHS = 16;
const BASS_BELOW = 55;
const SHARP_STEPS = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_STEPS = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
// [sixteenths, MusicXML type, dotted]
const NOTE_VALUES = [[16, 'whole', false], [12, 'half', true], [8, 'half', false], [6, 'quarter', true], [4, 'quarter', false], [3, 'eighth', true], [2, 'eighth', false], [1, '16th', false]];

function onsetEnvelope(notes, length) {
  const envelope = new Float32Array(length);
  for (const note of notes) {
    const frame = Math.round(note.startTimeSeconds * ENVELOPE_RATE);
    // Low notes mark the pulse in fingerstyle playing more reliably than ornaments.
    if (frame < length) envelope[frame] += note.amplitude * (note.pitchMidi < BASS_BELOW ? 1.5 : 1);
  }
  const smoothed = new Float32Array(length);
  const kernel = [0.06, 0.24, 0.4, 0.24, 0.06];
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) if (i + k >= 0 && i + k < length) sum += envelope[i + k] * kernel[k + 2];
    smoothed[i] = sum;
  }
  return smoothed;
}

// Tempo from the autocorrelation of the onset envelope, weighted towards ~100 BPM.
function estimatePeriod(envelope) {
  const minLag = Math.round(ENVELOPE_RATE * 60 / 180);
  const maxLag = Math.round(ENVELOPE_RATE * 60 / 50);
  let best = { lag: Math.round(ENVELOPE_RATE * 0.6), score: -Infinity };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < envelope.length; i++) sum += envelope[i] * envelope[i - lag];
    const prior = Math.exp(-0.5 * (Math.log2(lag / (ENVELOPE_RATE * 0.6)) / 0.9) ** 2);
    if (sum * prior > best.score) best = { lag, score: sum * prior };
  }
  return best.lag;
}

// Normalized autocorrelation, peak within ±4 % of the lag (tempo drifts).
function periodicity(envelope, lag) {
  let energy = 0;
  for (const value of envelope) energy += value * value;
  if (!energy) return 0;
  let best = 0;
  for (let l = Math.round(lag * 0.96); l <= Math.round(lag * 1.04); l++) {
    let sum = 0;
    for (let i = l; i < envelope.length; i++) sum += envelope[i] * envelope[i - l];
    best = Math.max(best, sum / energy);
  }
  return best;
}

// Fingerstyle keeps an even eighth-note flow that autocorrelates more strongly than the beat.
// The thumb plays on beats, so when the bass repeats at twice the period at least as strongly,
// the slower pulse is the beat.
function choosePeriod(envelope, bassEnvelope) {
  const period = estimatePeriod(envelope);
  const double = period * 2;
  if (double > ENVELOPE_RATE * 60 / 50) return period;
  const atPeriod = periodicity(bassEnvelope, period);
  const atDouble = periodicity(bassEnvelope, double);
  return atDouble > 0.02 && atDouble >= atPeriod ? double : period;
}

// Ellis (2007) dynamic-programming beat tracker. Live fingerstyle playing speeds up and holds
// back, so the tempo is allowed to flex; each beat then moves to the strongest onset within a
// tenth of a beat (both measured against a reference tab of a cover recording).
function trackBeats(envelope, period) {
  const score = new Float32Array(envelope.length);
  const back = new Int32Array(envelope.length).fill(-1);
  const tightness = 10;
  for (let t = 0; t < envelope.length; t++) {
    let best = 0;
    let from = -1;
    for (let previous = t - 2 * period; previous <= t - Math.round(period / 2); previous++) {
      if (previous < 0) continue;
      const value = score[previous] - tightness * Math.log((t - previous) / period) ** 2;
      if (from < 0 || value > best) { best = value; from = previous; }
    }
    score[t] = envelope[t] + (from >= 0 ? best : 0);
    back[t] = from;
  }
  let end = envelope.length - 1;
  for (let t = Math.max(0, envelope.length - period); t < envelope.length; t++) if (score[t] > score[end]) end = t;
  const frames = [];
  for (let t = end; t >= 0; t = back[t]) frames.push(t);
  const reach = Math.round(period * 0.1);
  return frames.reverse().map((frame) => {
    let best = frame;
    for (let f = frame - reach; f <= frame + reach; f++) if (f >= 0 && f < envelope.length && envelope[f] > envelope[best]) best = f;
    return best / ENVELOPE_RATE;
  });
}

function estimateKey(notes) {
  const weights = new Array(12).fill(0);
  for (const note of notes) weights[note.pitchMidi % 12] += note.durationSeconds * note.amplitude;
  let best = { fifths: 0, score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [profile, minor] of [[MAJOR_PROFILE, false], [MINOR_PROFILE, true]]) {
      let score = 0;
      for (let pc = 0; pc < 12; pc++) score += weights[pc] * profile[(pc - tonic + 12) % 12];
      const major = minor ? (tonic + 3) % 12 : tonic;
      let fifths = (major * 7) % 12;
      if (fifths > 6) fifths -= 12;
      if (score > best.score) best = { fifths, minor, score };
    }
  }
  return best;
}

function pitchXml(midi, flats) {
  const [step, alter] = (flats ? FLAT_STEPS : SHARP_STEPS)[midi % 12];
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
}

function splitLength(position, length) {
  const pieces = [];
  let at = position;
  let remaining = length;
  while (remaining > 0) {
    const room = BAR_SIXTEENTHS - (at % BAR_SIXTEENTHS);
    const fits = NOTE_VALUES.filter(([value]) => value <= remaining && value <= room);
    const value = fits.find(([v, , dotted]) => at % (dotted ? (v / 3) * 2 : v) === 0) || fits.at(-1);
    pieces.push(value);
    at += value[0];
    remaining -= value[0];
  }
  return pieces;
}

// One voice: chords sit on the sixteenth grid and last until the next chord.
function voiceEvents(groups) {
  const events = [];
  const positions = [...groups.keys()].sort((a, b) => a - b);
  positions.forEach((position, i) => {
    const notes = groups.get(position);
    const next = positions[i + 1] ?? Infinity;
    const length = Math.max(1, Math.min(next - position, Math.max(...notes.map((note) => note.length))));
    events.push({ position, length, pitches: [...new Set(notes.map((note) => note.pitch))].sort((a, b) => a - b) });
  });
  return events;
}

function measureXml(events, barIndex, voice, flats) {
  const start = barIndex * BAR_SIXTEENTHS;
  const end = start + BAR_SIXTEENTHS;
  let at = start;
  let xml = '';
  const rest = (until) => {
    for (const [value, type, dotted] of splitLength(at, until - at)) {
      xml += `<note><rest/><duration>${value}</duration><voice>${voice}</voice><type>${type}</type>${dotted ? '<dot/>' : ''}</note>`;
      at += value;
    }
  };
  for (const event of events) {
    const eventEnd = event.position + event.length;
    if (eventEnd <= start || event.position >= end) continue;
    const from = Math.max(event.position, start);
    if (from > at) rest(from);
    at = from;
    const pieces = splitLength(from, Math.min(eventEnd, end) - from);
    pieces.forEach(([value, type, dotted], p) => {
      const tiedIn = from > event.position || p > 0;
      const tiedOut = p < pieces.length - 1 || eventEnd > end;
      event.pitches.forEach((pitch, n) => {
        const ties = `${tiedIn ? '<tie type="stop"/>' : ''}${tiedOut ? '<tie type="start"/>' : ''}`;
        const tied = tiedIn || tiedOut ? `<notations>${tiedIn ? '<tied type="stop"/>' : ''}${tiedOut ? '<tied type="start"/>' : ''}</notations>` : '';
        xml += `<note>${n ? '<chord/>' : ''}${pitchXml(pitch, flats)}<duration>${value}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dotted ? '<dot/>' : ''}${tied}</note>`;
      });
      at += value;
    });
  }
  if (at < end) rest(end);
  return xml;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

// Quantizes detected notes and writes a two-voice (melody / bass) MusicXML score.
export function notesToMusicXml(notes, title) {
  if (notes.length < 8) throw new Error('기타 음을 충분히 찾지 못했습니다. 기타 소리만 나오는 영상인지 확인해 주세요.');
  const last = Math.max(...notes.map((note) => note.startTimeSeconds + note.durationSeconds));
  const envelope = onsetEnvelope(notes, Math.ceil(last * ENVELOPE_RATE) + ENVELOPE_RATE);
  const bassEnvelope = onsetEnvelope(notes.filter((note) => note.pitchMidi < BASS_BELOW), envelope.length);
  const period = choosePeriod(envelope, bassEnvelope);
  const beats = trackBeats(envelope, period);
  const step = period / ENVELOPE_RATE;
  while (beats[0] > notes[0].startTimeSeconds - step / 8) beats.unshift(beats[0] - step);
  while (beats.at(-1) < last + step) beats.push(beats.at(-1) + step);
  const locate = (seconds) => {
    let k = 0;
    while (k < beats.length - 2 && beats[k + 1] <= seconds) k++;
    return (k + (seconds - beats[k]) / (beats[k + 1] - beats[k])) * SUBDIVISIONS;
  };
  // Bars start on the beat where the bass lands most often.
  const quantized = notes.map((note) => {
    const position = Math.round(locate(note.startTimeSeconds));
    const end = Math.round(locate(note.startTimeSeconds + note.durationSeconds));
    return { position, length: Math.max(1, end - position), pitch: note.pitchMidi, amplitude: note.amplitude };
  });
  const phaseWeight = [0, 0, 0, 0];
  for (const note of quantized) {
    if (note.position % SUBDIVISIONS === 0) phaseWeight[(note.position / SUBDIVISIONS) % 4] += note.amplitude * (note.pitch < BASS_BELOW ? 2 : 0.5);
  }
  const phase = phaseWeight.indexOf(Math.max(...phaseWeight));
  const firstBeat = Math.floor(Math.min(...quantized.map((note) => note.position)) / SUBDIVISIONS);
  const origin = (firstBeat - ((firstBeat - phase) % 4 + 4) % 4) * SUBDIVISIONS;
  const melody = new Map();
  const bass = new Map();
  const byPosition = new Map();
  for (const note of quantized) {
    note.position -= origin;
    if (!byPosition.has(note.position)) byPosition.set(note.position, []);
    byPosition.get(note.position).push(note);
  }
  for (const [position, group] of byPosition) {
    group.sort((a, b) => a.pitch - b.pitch);
    const low = group[0].pitch < BASS_BELOW && group.length > 1 ? [group[0]] : group[0].pitch < BASS_BELOW - 7 ? [group[0]] : [];
    const high = group.filter((note) => !low.includes(note)).slice(-5);
    if (low.length) bass.set(position, low);
    if (high.length) melody.set(position, high);
  }
  const melodyEvents = voiceEvents(melody);
  const bassEvents = voiceEvents(bass);
  const lastPosition = Math.max(...[...melodyEvents, ...bassEvents].map((event) => event.position + event.length));
  const barCount = Math.ceil(lastPosition / BAR_SIXTEENTHS);
  const key = estimateKey(notes);
  const flats = key.fifths < 0;
  const intervals = beats.slice(1).map((beat, i) => beat - beats[i]).sort((a, b) => a - b);
  const tempo = Math.round(60 / intervals[Math.floor(intervals.length / 2)]);
  let measures = '';
  for (let bar = 0; bar < barCount; bar++) {
    const attributes = bar === 0
      ? `<attributes><divisions>${SUBDIVISIONS}</divisions><key><fifths>${key.fifths}</fifths><mode>${key.minor ? 'minor' : 'major'}</mode></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`
      : '';
    measures += `<measure number="${bar + 1}">${attributes}${measureXml(melodyEvents, bar, 1, flats)}<backup><duration>${BAR_SIXTEENTHS}</duration></backup>${measureXml(bassEvents, bar, 2, flats)}</measure>`;
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1"><work><work-title>${escapeXml(title)}</work-title></work><identification><encoding><software>fretroom audio transcription</software></encoding></identification><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
  return { xml, tempo, bars: barCount, notes: notes.length };
}
