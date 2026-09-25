// Voiceover / music playback, scheduling and microphone recording.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.cache = new Map(); // assetId -> AudioBuffer
    this.nodes = [];
    this.rec = null;
  }

  ensure() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async preload(project) {
    const ids = new Set(project.scenes.map((s) => s.audio).filter(Boolean));
    if (project.music) ids.add(project.music);
    const ctx = this.ensure();
    for (const id of ids) {
      if (this.cache.has(id) || !project.assets[id]) continue;
      try {
        const ab = await (await fetch(project.assets[id])).arrayBuffer();
        this.cache.set(id, await ctx.decodeAudioData(ab));
      } catch (e) {
        console.warn('Could not decode audio asset', id, e);
      }
    }
  }

  duration(id) {
    return this.cache.get(id)?.duration ?? null;
  }

  // Schedule voiceover + music starting at scene `si`, local time `t`.
  schedule(project, si, t, all, out, when) {
    const ctx = this.ensure();
    const nodes = [];
    let acc = -t;
    const last = all ? project.scenes.length - 1 : si;
    for (let i = si; i <= last; i++) {
      const sc = project.scenes[i];
      const buf = sc.audio && this.cache.get(sc.audio);
      if (buf) {
        const off = Math.max(0, -acc);
        if (off < buf.duration) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const gain = ctx.createGain();
          gain.gain.value = sc.audioVolume ?? 1;
          src.connect(gain).connect(out);
          src.start(when + Math.max(0, acc), off);
          src.stop(when + acc + sc.duration);
          nodes.push(src);
        }
      }
      acc += sc.duration;
    }
    const mbuf = project.music && this.cache.get(project.music);
    if (mbuf && acc > 0) {
      let before = 0;
      for (let i = 0; i < si; i++) before += project.scenes[i].duration;
      const src = ctx.createBufferSource();
      src.buffer = mbuf;
      src.loop = true;
      const gain = ctx.createGain();
      const vol = project.musicVolume ?? 0.15;
      gain.gain.setValueAtTime(vol, when);
      if (acc > 2) {
        gain.gain.setValueAtTime(vol, when + acc - 1.5);
        gain.gain.linearRampToValueAtTime(0, when + acc);
      }
      src.connect(gain).connect(out);
      src.start(when, (before + t) % mbuf.duration);
      src.stop(when + acc);
      nodes.push(src);
    }
    return nodes;
  }

  play(project, si, t, all) {
    this.stop();
    const ctx = this.ensure();
    this.nodes = this.schedule(project, si, t, all, ctx.destination, ctx.currentTime + 0.02);
  }

  stop() {
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* already stopped */ }
    }
    this.nodes = [];
  }

  async recStart() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        resolve(new Blob(chunks, { type: rec.mimeType }));
      };
    });
    rec.start();
    this.rec = { rec, done };
  }

  async recStop() {
    if (!this.rec) return null;
    const { rec, done } = this.rec;
    this.rec = null;
    rec.stop();
    return done;
  }
}
