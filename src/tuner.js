const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const WINDOW_SIZE = 2048;
const MIN_FREQUENCY = 32;
const MAX_FREQUENCY = 1600;
const YIN_THRESHOLD = 0.16;
const MIN_RMS = 0.004;
const FRAME_INTERVAL_MS = 75;

function fftSizeFor(sampleRate, step) {
  const maxLag = Math.ceil(sampleRate / step / MIN_FREQUENCY);
  let size = 2048;
  while (size < (WINDOW_SIZE + maxLag + 1) * step) size *= 2;
  return size;
}

function findPitch(samples, difference, sampleRate, maxLag) {
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQUENCY));
  let total = 0;

  // YIN's cumulative mean normalized difference favors the fundamental over
  // the stronger harmonics commonly present in plucked guitar strings.
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < WINDOW_SIZE; i++) {
      const delta = samples[i] - samples[i + lag];
      sum += delta * delta;
    }
    total += sum;
    difference[lag] = total > 0 ? sum * lag / total : 1;
  }

  for (let lag = minLag; lag < maxLag; lag++) {
    if (difference[lag] >= YIN_THRESHOLD) continue;
    while (lag + 1 < maxLag && difference[lag + 1] < difference[lag]) lag++;
    const previous = difference[lag - 1];
    const current = difference[lag];
    const next = difference[lag + 1];
    const curvature = previous - 2 * current + next;
    const offset = curvature > 0 ? Math.max(-1, Math.min(1, (previous - next) / (2 * curvature))) : 0;
    return sampleRate / (lag + offset);
  }
  return null;
}

export function createTuner({ onReading, onState, onError }) {
  let targets = [];
  let generation = 0;
  let pending = null;
  let audio = null;
  let frame = 0;
  let lastFrame = 0;
  let hasReading = false;

  function clearReading() {
    if (hasReading) {
      hasReading = false;
      onReading(null);
    }
  }

  function release(stream, context, source, analyser, output) {
    source?.disconnect();
    analyser?.disconnect();
    output?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== 'closed') context.close().catch(() => {});
  }

  function stop() {
    const wasActive = pending !== null || audio !== null;
    generation++;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (audio) {
      release(audio.stream, audio.context, audio.source, audio.analyser, audio.output);
      audio = null;
    }
    pending = null;
    lastFrame = 0;
    clearReading();
    if (wasActive) onState('stopped');
  }

  function analyse(time) {
    if (!audio) return;
    frame = requestAnimationFrame(analyse);
    if (time - lastFrame < FRAME_INTERVAL_MS) return;
    lastFrame = time;

    const { analyser, waveform, samples, difference, step, rate, maxLag } = audio;
    analyser.getFloatTimeDomainData(waveform);
    const count = WINDOW_SIZE + maxLag + 1;
    let index = waveform.length - count * step;
    let sum = 0;
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let j = 0; j < step; j++) value += waveform[index++];
      value /= step;
      samples[i] = value;
      sum += value;
      sumSquares += value * value;
    }
    const mean = sum / count;
    if (sumSquares / count - mean * mean < MIN_RMS * MIN_RMS) {
      clearReading();
      return;
    }

    const frequency = findPitch(samples, difference, rate, maxLag);
    if (frequency === null) {
      clearReading();
      return;
    }

    const pitch = 69 + 12 * Math.log2(frequency / 440);
    const nearestNote = Math.round(pitch);
    let target = null;
    let distance = Infinity;
    for (const candidate of targets) {
      const gap = Math.abs(candidate.pitch - pitch);
      if (gap < distance) {
        distance = gap;
        target = candidate;
      }
    }
    hasReading = true;
    onReading({
      frequency,
      note: `${NOTE_NAMES[((nearestNote % 12) + 12) % 12]}${Math.floor(nearestNote / 12) - 1}`,
      cents: Math.round(100 * (pitch - (target?.pitch ?? nearestNote))),
      targetLabel: target?.label ?? null,
      targetPitch: target?.pitch ?? null
    });
  }

  function start(deviceId = '') {
    if (audio) return Promise.resolve();
    if (pending) return pending;
    const token = ++generation;
    const opening = (async () => {
      let stream;
      let context;
      let source;
      let analyser;
      let output;
      try {
        // Allow start() to publish its pending promise before any synchronous failure.
        await Promise.resolve();
        if (token !== generation) return;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable.');
        const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (deviceId) audioConstraints.deviceId = { exact: deviceId };
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        if (token !== generation) {
          release(stream);
          return;
        }
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Web Audio is unavailable.');
        context = new AudioContextClass();
        const step = Math.max(1, Math.round(context.sampleRate / 24000));
        const rate = context.sampleRate / step;
        const maxLag = Math.ceil(rate / MIN_FREQUENCY);
        analyser = context.createAnalyser();
        analyser.fftSize = fftSizeFor(context.sampleRate, step);
        source = context.createMediaStreamSource(stream);
        output = context.createGain();
        output.gain.value = 0;
        source.connect(analyser);
        analyser.connect(output);
        output.connect(context.destination);
        await context.resume();
        if (token !== generation) {
          release(stream, context, source, analyser, output);
          return;
        }
        audio = {
          stream, context, source, analyser, output, step, rate, maxLag,
          waveform: new Float32Array(analyser.fftSize),
          samples: new Float32Array(WINDOW_SIZE + maxLag + 1),
          difference: new Float32Array(maxLag + 1)
        };
        onState('listening');
        if (token === generation) frame = requestAnimationFrame(analyse);
      } catch (error) {
        release(stream, context, source, analyser, output);
        if (token === generation) {
          stop();
          onError(error);
          throw error;
        }
      } finally {
        if (pending === opening) pending = null;
      }
    })();
    pending = opening;
    return opening;
  }

  function setTargets(nextTargets) {
    targets = nextTargets.filter((target) => Number.isFinite(target.pitch)).map(({ label, pitch }) => ({ label, pitch }));
  }

  return { start, stop, setTargets };
}
