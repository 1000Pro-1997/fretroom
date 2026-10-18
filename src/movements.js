import * as alphaTab from '@coderline/alphatab';

const noteLinkKeys = [
  'tieoriginnoteid', 'tiedestinationnoteid', 'sluroriginnoteid', 'slurdestinationnoteid',
  'hammerpulloriginnoteid', 'hammerpulldestinationnoteid', 'slideoriginnoteid', 'slidetargetnoteid',
];

function* notesOf(staff) {
  for (const bar of staff.get('bars')) for (const voice of bar.get('voices')) {
    for (const beat of voice.get('beats')) yield* beat.get('notes');
  }
}

// Optical recognition splits a book into movements when it finds a new
// title or instrumentation. Movements with the same parts are appended into
// one continuous score; otherwise only the first movement is kept.
export function joinMovements(scores, settings) {
  const [first, ...rest] = scores;
  const shape = (score) => score.tracks.map((track) => track.staves.length).join(',');
  if (!rest.length || rest.some((score) => shape(score) !== shape(first))) return { score: first, joined: !rest.length };
  const data = alphaTab.model.JsonConverter.scoreToJsObject(first);
  const staves = data.get('tracks').map((track) => track.get('staves'));
  let offset = 0;
  for (const staff of staves.flat()) for (const note of notesOf(staff)) offset = Math.max(offset, note.get('id') + 1);
  for (const score of rest) {
    const next = alphaTab.model.JsonConverter.scoreToJsObject(score);
    data.get('masterbars').push(...next.get('masterbars'));
    let highest = offset;
    next.get('tracks').forEach((track, t) => track.get('staves').forEach((staff, s) => {
      const target = staves[t][s];
      // Note ids link ties and slurs, so appended notes get ids after the existing ones.
      for (const note of notesOf(staff)) {
        note.set('id', note.get('id') + offset);
        highest = Math.max(highest, note.get('id') + 1);
        for (const key of noteLinkKeys) if (note.has(key) && note.get(key) >= 0) note.set(key, note.get(key) + offset);
      }
      for (const bar of staff.get('bars')) {
        bar.delete('id');
        for (const voice of bar.get('voices')) {
          voice.delete('id');
          for (const beat of voice.get('beats')) beat.delete('id');
        }
      }
      target.get('bars').push(...staff.get('bars'));
      for (const [id, chord] of staff.get('chords') || []) {
        if (!target.has('chords')) target.set('chords', new Map());
        target.get('chords').set(id, chord);
      }
    }));
    offset = highest;
  }
  return { score: alphaTab.model.JsonConverter.jsObjectToScore(data, settings), joined: true };
}
