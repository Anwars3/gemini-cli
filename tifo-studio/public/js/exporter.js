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

// Chrome records fragmented MP4 whose header only states the first fragment's length,
// so players show e.g. 0:03 for a 5-minute video. Patch the durations in the moov box.
async function fixMp4Duration(blob, seconds) {
  if (blob.size > 1.5e9) return blob;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let movieScale = 0;
  const put = (pos, v1, scale) => {
    const d = Math.round(seconds * scale);
    if (v1) dv.setBigUint64(pos, BigInt(d));
    else dv.setUint32(pos, d);
  };
  const walk = (off, end) => {
    while (off + 8 <= end) {
      let size = dv.getUint32(off);
      let hdr = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(off + 8));
        hdr = 16;
      } else if (size === 0) size = end - off;
      if (size < 8) return;
      const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
      const v1 = buf[off + hdr] === 1;
      const p = off + hdr + 4; // skip version + flags
      if (type === 'moov' || type === 'trak' || type === 'mdia') walk(off + hdr, off + size);
      else if (type === 'mvhd') {
        movieScale = dv.getUint32(p + (v1 ? 16 : 8));
        put(p + (v1 ? 20 : 12), v1, movieScale);
      } else if (type === 'mdhd') {
        put(p + (v1 ? 20 : 12), v1, dv.getUint32(p + (v1 ? 16 : 8)));
      } else if (type === 'tkhd' && movieScale) {
        put(p + (v1 ? 24 : 16), v1, movieScale);
      }
      off += size;
    }
  };
  try {
    walk(0, buf.length);
    return new Blob([buf], { type: blob.type });
  } catch (e) {
    console.warn('Could not patch MP4 duration', e);
    return blob;
  }
}

export async function exportVideo({ project, renderer, audio, fps = 30, bitrate = 16e6, onProgress, signal }) {
  if (!window.MediaRecorder) throw new Error('This browser does not support MediaRecorder. Use Chrome or Edge.');
  const total = projectDuration(project);
  await audio.preload(project);
  const ctx = audio.ensure();
  const dest = ctx.createMediaStreamDestination();
  // Keep the audio track producing (silent) samples. With no voiceover/music the track
  // would carry no data, and Chrome's recorder then truncates MP4 or writes empty WebM.
  const keepAlive = ctx.createConstantSource();
  keepAlive.offset.value = 0;
  keepAlive.connect(dest);
  keepAlive.start();
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
  const recStart = performance.now();
  let recEnd = 0;

  await new Promise((resolve) => {
    const loop = () => {
      const T = ctx.currentTime - t0;
      if (signal?.aborted || T >= total) {
        frame(Math.max(0, total - 1e-3));
        setTimeout(() => { recEnd = performance.now(); rec.stop(); resolve(); }, 250);
        return;
      }
      frame(Math.max(0, T));
      onProgress?.(Math.max(0, T) / total);
      requestAnimationFrame(loop);
    };
    loop();
  });
  await stopped;
  [...nodes, keepAlive].forEach((n) => { try { n.stop(); } catch { /* ignore */ } });
  vstream.getTracks().forEach((t) => t.stop());
  if (signal?.aborted) return null;
  const type = (mimeType || 'video/webm').split(';')[0];
  let blob = new Blob(chunks, { type });
  if (type.includes('mp4')) blob = await fixMp4Duration(blob, (recEnd - recStart) / 1000);
  return { blob, ext: type.includes('mp4') ? 'mp4' : 'webm' };
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
