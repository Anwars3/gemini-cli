# Tifo Studio

A local web app for making **Tifo Football-style animated tactics videos**: a flat, textured
tactics board with animated players, self-drawing arrows, zones, camera zooms, title and
illustration cards, voiceover, music and a 1080p video export.

No build step and no dependencies: just Node.js 18+ and Chrome or Edge.

## Run it

```bash
cd tifo-studio
npm start          # or: node server.js
```

Open <http://127.0.0.1:5173>. A sample project ("The High Press") loads on first run.
Press **▶▶ All** to watch it.

The **How it's made** link in the top bar opens a guide to how Tifo-style videos are
produced and how each step maps to this tool.

## Workflow

1. **Script → Scenes**: paste your script. Each paragraph becomes a scene.
2. **Voiceover**: in each scene press **● Record mic** (the animation plays while you talk)
   or **Upload audio**, then **Fit to audio**.
3. **Players**: pick a formation and click **Insert XI**, or place players with the
   Home/Away tools.
4. **Animate**: move the playhead, then drag a player or the ball. That creates a keyframe
   (movement is eased). Press **◆ Key** (K) to hold a position until a given moment.
5. **Annotate**: Pass, Run, Dribble and Line arrows draw themselves on at their
   **Appears** time. Zones and labels fade in and out.
   Shift-click several players and choose **Connect with line** to get a back-four or
   pressing line that moves with them.
6. **Camera**: use the 🎥 tool and drag a frame over the area to zoom into at the
   playhead. Untick **Camera view** to edit on the full pitch.
7. **Continue ▸** starts a new scene from where the current one ends.
8. **Export Video** gives a 1920×1080, 30 fps video with voice and music mixed in.
   **Export .srt** gives YouTube subtitles.

### Shortcuts

| Key | Action |
| --- | --- |
| Space / Shift+Space | Play scene / play all |
| ← → (Shift) | Step 1 frame (1 s) |
| K | Keyframe the selection at the playhead |
| V H A B P R D L Z E T C | Select, Home, Away, Ball, Pass, Run, Dribble, Line, Zone, Ellipse, Text, Camera |
| Delete | Delete the selection |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |

## Saving

- **Save / Open** store projects as JSON in `tifo-studio/projects/`, including audio and images.
- **Download JSON / Import JSON** move projects between machines.
- Work is also autosaved in the browser.

## Notes

- Export records in real time, so a 5-minute video takes 5 minutes. Keep the tab visible
  while it runs.
- Chrome exports MP4 (H.264) when it can, otherwise WebM. To convert a WebM file:
  `ffmpeg -i in.webm -c:v libx264 -crf 18 -c:a aac out.mp4`
- The "Preview with voice" button uses the browser's text-to-speech. It is for timing
  only and is not included in the export. For the final video, record or upload real audio.

## Files

```
server.js            zero-dependency static server + project save API
public/index.html    editor UI
public/guide.html    "how Tifo videos are made" guide
public/js/model.js     data model, keyframes, formations, sample project
public/js/renderer.js  canvas renderer (the Tifo look)
public/js/audio.js     voiceover/music playback and mic recording
public/js/exporter.js  video export and SRT
public/js/app.js       editor interactions
```
