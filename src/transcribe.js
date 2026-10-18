// Guitar audio → MusicXML: Spotify Basic Pitch finds the notes in the browser
// (TensorFlow.js), then notes-to-score.js turns them into notation.
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import { notesToMusicXml } from './notes-to-score.js';

const MODEL_SAMPLE_RATE = 22050;
// Down to C2 so drop and open tunings (lowest string D or C) are kept.
const LOWEST_GUITAR = 36;
const HIGHEST_GUITAR = 88;
const MAX_SECONDS = 15 * 60;

let modelPromise = null;

export async function decodeAudio(bytes) {
  const data = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const context = new AudioContext();
  let decoded;
  try { decoded = await context.decodeAudioData(data); }
  finally { context.close(); }
  if (decoded.duration > MAX_SECONDS) throw new Error('15분보다 긴 영상은 변환할 수 없습니다.');
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * MODEL_SAMPLE_RATE), MODEL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

export async function detectNotes(audio, onProgress = () => {}) {
  modelPromise ||= tf.loadGraphModel('/basic-pitch/model.json');
  const basicPitch = new BasicPitch(modelPromise);
  const frames = [];
  const onsets = [];
  const contours = [];
  await basicPitch.evaluateModel(audio, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, onProgress);
  const events = outputToNotesPoly(frames, onsets, 0.5, 0.3, 6, true, null, null, true, 11);
  return noteFramesToTime(addPitchBendsToNoteEvents(contours, events))
    .filter((note) => note.pitchMidi >= LOWEST_GUITAR && note.pitchMidi <= HIGHEST_GUITAR && note.amplitude >= 0.2)
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
}

export async function transcribeAudio(bytes, title, onProgress = () => {}) {
  onProgress('decode', 0);
  const audio = await decodeAudio(bytes);
  const notes = await detectNotes(audio, (percent) => onProgress('notes', percent));
  onProgress('score', 1);
  return notesToMusicXml(notes, title);
}
