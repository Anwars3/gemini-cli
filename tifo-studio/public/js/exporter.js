// Real-time video export (canvas + mixed audio → MediaRecorder) and SRT subtitles.

export function projectDuration(project) {
  return project.scenes.reduce((s, sc) => s + sc.duration, 0);
}

export function locate(project, T) {
  let acc = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    const d = project.scenes[i].duration;
    if (T < acc + d || i === project.scenes.length - 1) return { si: i, t: Math.min(T - acc, d) };
    acc += d;
  }
  return { si: 0, t: 0 };
}

function pickMime() {
  const c = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

export async function exportVideo({ project, renderer, audio, fps = 30, bitrate = 16e6, onProgress, signal }) {
  if (!window.MediaRecorder) throw new Error('This browser does not support MediaRecorder. Use Chrome or Edge.');
  const total = projectDuration(project);
  await audio.preload(project);
  const ctx = audio.ensure();
  const dest = ctx.createMediaStreamDestination();
  const frame = (T) => {
    const { si, t } = locate(project, T);
    renderer.draw(project, project.scenes[si], t, { showCaptions: project.showCaptions, useCamera: true });
  };
  frame(0);
  const vstream = renderer.canvas.captureStream(fps);
  const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mimeType = pickMime();
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));

  const t0 = ctx.currentTime + 0.3;
  const nodes = audio.schedule(project, 0, 0, true, dest, t0);
  rec.start(500);

  await new Promise((resolve) => {
    const loop = () => {
      const T = ctx.currentTime - t0;
      if (signal?.aborted || T >= total) {
        frame(Math.max(0, total - 1e-3));
        setTimeout(() => { rec.stop(); resolve(); }, 250);
        return;
      }
      frame(Math.max(0, T));
      onProgress?.(Math.max(0, T) / total);
      requestAnimationFrame(loop);
    };
    loop();
  });
  await stopped;
  nodes.forEach((n) => { try { n.stop(); } catch { /* ignore */ } });
  vstream.getTracks().forEach((t) => t.stop());
  if (signal?.aborted) return null;
  const type = (mimeType || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
}

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// One subtitle cue per ~12 words, spread evenly across each scene.
export function buildSRT(project) {
  const cues = [];
  let acc = 0;
  for (const sc of project.scenes) {
    const text = (sc.narration || sc.caption || '').trim();
    if (text) {
      const words = text.split(/\s+/);
      const n = Math.ceil(words.length / 12);
      const per = sc.duration / n;
      for (let i = 0; i < n; i++) {
        cues.push({ a: acc + i * per, b: acc + (i + 1) * per - 0.05, text: words.slice(i * 12, (i + 1) * 12).join(' ') });
      }
    }
    acc += sc.duration;
  }
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.a)} --> ${srtTime(c.b)}\n${c.text}\n`).join('\n');
}
