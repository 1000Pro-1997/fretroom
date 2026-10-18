import * as alphaTab from '@coderline/alphatab';

// Use the same repeat/direction/alternate-ending walk that alphaTab uses for MIDI.
// TypeScript marks this method private, but it is present on the bundled 1.8.4 class.
export function unfoldRepeats(score, settings) {
  const sequence = [];
  const maxBars = Math.max(10000, score.masterBars.length * 32);
  alphaTab.midi.MidiFileGenerator._playThroughSong(
    score, [], false,
    (bar) => {
      if (sequence.length >= maxBars) throw new Error('반복 구간이 너무 길어 악보를 펼칠 수 없습니다.');
      sequence.push(bar.index);
    },
    () => {},
    () => {},
  );
  if (sequence.length === score.masterBars.length && sequence.every((index, i) => index === i)) return score;

  // Serialization retains the full score (articulations, bends, tempo, tuning and
  // track metadata). Deserializing each repeated bar creates distinct model nodes.
  const data = alphaTab.model.JsonConverter.scoreToJsObject(score);
  const masterBars = data.get('masterbars');
  const tracks = data.get('tracks');
  const staffs = tracks.flatMap((track) => track.get('staves'));
  const linkedNotes = [];
  let nextNoteId = 0;
  for (const staff of staffs) {
    for (const bar of staff.get('bars')) {
      for (const voice of bar.get('voices')) {
        for (const beat of voice.get('beats')) {
          for (const note of beat.get('notes')) nextNoteId = Math.max(nextNoteId, note.get('id'));
        }
      }
    }
  }

  for (const bar of masterBars) {
    bar.set('isrepeatstart', false);
    bar.set('repeatcount', 0);
    bar.set('alternateendings', 0);
    bar.delete('directions');
    bar.delete('custombarnumber');
    bar.delete('custombarnumbertext');
  }
  for (let s = 0; s < staffs.length; s++) {
    const sourceBars = staffs[s].get('bars');
    const occurrences = new Map();
    let position = 0;
    const copies = sequence.map((index) => {
      const bar = structuredClone(sourceBars[index]);
      if (score.masterBars[index].isRepeatStart && bar.get('barlineleft') === alphaTab.model.BarLineStyle.HeavyLight) {
        bar.set('barlineleft', alphaTab.model.BarLineStyle.Automatic);
      }
      if (score.masterBars[index].isRepeatEnd && bar.get('barlineright') === alphaTab.model.BarLineStyle.LightHeavy) {
        bar.set('barlineright', alphaTab.model.BarLineStyle.Automatic);
      }
      bar.delete('id');
      for (const voice of bar.get('voices')) {
        voice.delete('id');
        for (const beat of voice.get('beats')) {
          beat.delete('id');
          for (const note of beat.get('notes')) {
            const oldId = note.get('id');
            const entry = { note, position: position++, oldId, origins: [] };
            note.set('id', ++nextNoteId);
            for (const [originKey, destinationKey] of noteLinks) {
              if (note.has(originKey)) entry.origins.push([note.get(originKey), originKey, destinationKey]);
              note.delete(originKey);
              note.delete(destinationKey);
            }
            if (!occurrences.has(oldId)) occurrences.set(oldId, []);
            occurrences.get(oldId).push(entry);
            linkedNotes.push({ entry, occurrences });
          }
        }
      }
      return bar;
    });
    staffs[s].set('bars', copies);
  }
  // Reconnect explicit tied/slurred/hammered/slid notes to the nearest played
  // source, never to a different occurrence of the same original measure.
  for (const { entry, occurrences } of linkedNotes) {
    for (const [oldOriginId, originKey, destinationKey] of entry.origins) {
      const sources = occurrences.get(oldOriginId) || [];
      for (let i = sources.length - 1; i >= 0; i--) {
        const source = sources[i];
        if (source.position >= entry.position || source.note.has(destinationKey)) continue;
        source.note.set(destinationKey, entry.note.get('id'));
        entry.note.set(originKey, source.note.get('id'));
        break;
      }
    }
  }
  data.set('masterbars', sequence.map((index) => masterBars[index]));
  data.set('systemslayout', []);
  for (const track of tracks) {
    track.set('systemslayout', []);
    track.delete('linebreaks');
  }
  return alphaTab.model.JsonConverter.jsObjectToScore(data, settings);
}

const noteLinks = [
  ['tieoriginnoteid', 'tiedestinationnoteid'],
  ['sluroriginnoteid', 'slurdestinationnoteid'],
  ['hammerpulloriginnoteid', 'hammerpulldestinationnoteid'],
  ['slideoriginnoteid', 'slidetargetnoteid'],
];
