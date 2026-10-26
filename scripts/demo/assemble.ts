#!/usr/bin/env bun
// Joins the recorded scenes, speaks the narration with a text-to-speech voice and lays it over the video at the
// moment each line was scheduled, and writes the narration script with timestamps.
//   VOICE=en-US-ChristopherNeural RATE=-6% PITCH=-8Hz bun scripts/demo/assemble.ts
// Needs ffmpeg and ffprobe on PATH and Python with `pip install edge-tts` (it calls Microsoft's online TTS service,
// so the narration text leaves the machine; it contains no secrets).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { OUT } from "./lib.ts";

const VOICE = process.env.VOICE ?? "en-US-ChristopherNeural";
const RATE = process.env.RATE ?? "-6%";
const PITCH = process.env.PITCH ?? "-8Hz";
const FINAL = process.env.FINAL ?? "docs/demo/urumi-demo.mp4";

type Beat = { scene: string; at: number; say: string; seconds: number };
const scenes = readdirSync(OUT).filter((f) => /^\d\d-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8")) as { id: string; title: string; beats: Beat[] });

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}\n${err}`);
  return out;
}
const duration = async (file: string) => Number((await sh(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).trim());
const stamp = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// 1. the video: scenes in order
let offset = 0;
const timeline: { abs: number; end: number; say: string; scene: string; title: string }[] = [];
const list: string[] = [];
for (const s of scenes) {
  const file = `${OUT}/${s.id}.mp4`;
  if (!existsSync(file)) throw new Error(`missing ${file}: record that scene first`);
  const len = await duration(file);
  list.push(`file '${process.cwd().replaceAll("\\", "/")}/${file}'`);
  s.beats.forEach((b, i) => timeline.push({ abs: offset + b.at, end: offset + (s.beats[i + 1]?.at ?? len), say: b.say, scene: s.id, title: s.title }));
  offset += len;
}
writeFileSync(`${OUT}/all.txt`, list.join("\n"));
await sh(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/all.txt`, "-c", "copy", `${OUT}/silent.mp4`]);
const total = await duration(`${OUT}/silent.mp4`);
console.log(`video ${stamp(total)} from ${scenes.length} scenes, ${timeline.length} narration lines`);

// 2. the voice
mkdirSync(`${OUT}/tts`, { recursive: true });
const clips: { file: string; start: number; dur: number }[] = [];
let cursor = 0;
for (const [i, beat] of timeline.entries()) {
  const mp3 = `${OUT}/tts/${String(i).padStart(3, "0")}.mp3`;
  if (!existsSync(mp3)) await sh(["python", "-m", "edge_tts", "--voice", VOICE, `--rate=${RATE}`, `--pitch=${PITCH}`, "--text", beat.say, "--write-media", mp3]);
  let dur = await duration(mp3);
  const window = beat.end - beat.abs;
  let tempo = 1;
  if (dur > window - 0.4) tempo = Math.min(1.25, dur / Math.max(1, window - 0.4)); // speed up a little when the screen moves on sooner
  dur /= tempo;
  const start = Math.max(beat.abs + 0.3, cursor + 0.35); // never talk over the previous line
  clips.push({ file: mp3, start, dur });
  (beat as { tempo?: number }).tempo = tempo;
  cursor = start + dur;
}
const lag = Math.max(0, ...clips.map((c, i) => c.start - timeline[i]!.abs));
console.log(`voice ends at ${stamp(cursor)} (video ${stamp(total)}), largest lag behind the picture ${lag.toFixed(1)}s`);

// 3. mix
const inputs = clips.flatMap((c) => ["-i", c.file]);
const filters = clips.map((c, i) => {
  const tempo = (timeline[i] as { tempo?: number }).tempo ?? 1;
  const ms = Math.round(c.start * 1000);
  return `[${i + 1}:a]${tempo > 1.001 ? `atempo=${tempo.toFixed(3)},` : ""}adelay=${ms}|${ms}[a${i}]`;
});
const mix = `${filters.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
writeFileSync(`${OUT}/mix.txt`, mix);
await sh(["ffmpeg", "-v", "error", "-y", "-i", `${OUT}/silent.mp4`, ...inputs, "-filter_complex_script", `${OUT}/mix.txt`, "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", FINAL]);
console.log(`wrote ${FINAL}`);

// 4. the script for a human narrator
let md = `# Demo narration script

Voice-over for the demo video, in the order and at the times it plays in \`docs/demo/urumi-demo.mp4\` (${stamp(total)} long). Each block is what is said while the action on screen happens; the time is when the line starts. If you want to re-record the voice yourself, read each block at that time. Regenerate this file and the video with \`bun scripts/demo/record.ts\` then \`bun scripts/demo/assemble.ts\`.

The bundled voice is a synthetic text-to-speech voice (${VOICE}), not a recording of a person.

`;
let last = "";
timeline.forEach((b, i) => {
  if (b.scene !== last) { md += `\n## ${b.title}\n\n`; last = b.scene; }
  md += `**[${stamp(clips[i]!.start)}]** ${b.say}\n\n`;
});
writeFileSync("docs/demo-narration.md", md);
console.log("wrote docs/demo-narration.md");
