const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json({ limit: "50mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const jobs = {};

async function download(url, dest) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(dest, response.data);
}

function ensureFFmpeg() {
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
  } catch {
    console.log("Installing ffmpeg...");
    execSync("apt-get install -y ffmpeg 2>/dev/null || true", { stdio: "inherit" });
  }
}

async function renderVideo({ imageUrl, voiceoverUrl, jobId }) {
  const tmpDir = `/tmp/${jobId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  const imagePath = path.join(tmpDir, "comic.png");
  const audioPath = path.join(tmpDir, "voice.mp3");
  const outputPath = path.join(tmpDir, "output.mp4");

  console.log(`[${jobId}] Downloading image...`);
  await download(imageUrl, imagePath);

  console.log(`[${jobId}] Downloading voiceover...`);
  await download(voiceoverUrl, audioPath);

  // Get audio duration
  const durationRaw = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
  ).toString().trim();
  const duration = Math.ceil(parseFloat(durationRaw)) || 30;
  console.log(`[${jobId}] Audio duration: ${duration}s`);

  // Safe filter: scale to fit 1080x1920, pad remaining space with black
  // Works on ANY image size — no crop, no dimension errors
  const filterComplex = `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v]`;

  const ffmpegCmd = [
    `ffmpeg -y`,
    `-loop 1 -i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[v]" -map 1:a`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 128k`,
    `-t ${duration}`,
    `-pix_fmt yuv420p`,
    `-movflags +faststart`,
    `"${outputPath}"`,
  ].join(" ");

  await new Promise((resolve, reject) => {
    exec(ffmpegCmd, (err, stdout, stderr) => {
      if (err) {
        console.error(`[${jobId}] FFmpeg error:`, stderr);
        return reject(new Error("FFmpeg render failed: " + stderr.slice(-500)));
      }
      resolve();
    });
  });

  console.log(`[${jobId}] Render done. Uploading to Supabase...`);

  const videoBuffer = fs.readFileSync(outputPath);
  const storagePath = `renders/${jobId}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from("videos")
    .upload(storagePath, videoBuffer, { contentType: "video/mp4", upsert: true });

  if (uploadError) throw new Error("Supabase upload failed: " + uploadError.message);

  const { data: urlData } = supabase.storage.from("videos").getPublicUrl(storagePath);
  const videoUrl = urlData.publicUrl;

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[${jobId}] Done! videoUrl: ${videoUrl}`);
  return videoUrl;
}

app.get("/", (req, res) => res.json({ status: "ok", service: "comic-render-server" }));

app.post("/render", async (req, res) => {
  const { imageUrl, voiceoverUrl, title } = req.body;
  if (!imageUrl || !voiceoverUrl) {
    return res.status(400).json({ error: "imageUrl and voiceoverUrl are required" });
  }
  const jobId = uuidv4();
  jobs[jobId] = { status: "rendering", startedAt: Date.now() };
  console.log(`[${jobId}] New render job — "${title}"`);

  renderVideo({ imageUrl, voiceoverUrl, jobId })
    .then((videoUrl) => {
      jobs[jobId] = { status: "done", videoUrl, title, elapsedMs: Date.now() - jobs[jobId].startedAt };
    })
    .catch((err) => {
      console.error(`[${jobId}] Render failed:`, err.message);
      jobs[jobId] = { status: "failed", error: err.message };
    });

  res.json({ jobId, status: "rendering" });
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

ensureFFmpeg();
app.listen(PORT, () => console.log(`🎬 Render server running on port ${PORT}`));
