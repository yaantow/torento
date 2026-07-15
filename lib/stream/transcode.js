const { spawn } = require('child_process');

/**
 * ffprobe a local path or HTTP URL, returning parsed stream/format info.
 */
function probe(input) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams', '-show_format',
      input,
    ];
    const proc = spawn('ffprobe', args);
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

const COMPATIBLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const COMPATIBLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const COMPATIBLE_CONTAINER_EXT = new Set(['.mp4', '.m4v', '.webm']);

/**
 * Decide whether a file can be sent to the browser as-is, needs only a
 * container remux (cheap — no re-encode), or needs a real transcode
 * (expensive — CPU-bound re-encode of video and/or audio).
 */
function planFor(probeResult, ext) {
  const streams = probeResult.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const videoOk = v ? COMPATIBLE_VIDEO.has(v.codec_name) : true;
  const audioOk = a ? COMPATIBLE_AUDIO.has(a.codec_name) : true;
  const containerOk = COMPATIBLE_CONTAINER_EXT.has(ext);

  const duration = Number(probeResult.format?.duration) || 0;
  const sourceSize = Number(probeResult.format?.size) || 0;

  if (videoOk && audioOk && containerOk) {
    return { mode: 'passthrough', duration, sourceSize };
  }
  return {
    mode: videoOk ? 'remux' : 'transcode',
    videoCodec: videoOk ? 'copy' : 'libx264',
    audioCodec: audioOk ? 'copy' : 'aac',
    duration,
    sourceSize,
  };
}

/**
 * Remux/transcode `inputUrl` into a complete, standard (faststart, seekable)
 * MP4 file on disk. Only the first video and first audio stream are mapped;
 * source subtitle tracks are dropped.
 *
 * A live-piped fragmented MP4 (empty moov) was tried first and rejected —
 * plain <video src> playback is unreliable with that format across browsers
 * without also wiring up MediaSource Extensions on the client. Writing a
 * real file and serving it exactly like any other cached file sidesteps
 * that entirely and reuses the already-proven Range-serving code path.
 * `-movflags +faststart` needs a seekable output, so this cannot stream to
 * a pipe — the caller waits for the process to finish before serving it.
 */
function renderToFile({ inputUrl, outputPath, plan }) {
  // This droplet has a single vCPU: a real H.264 re-encode of 1080p HEVC
  // barely clears real-time even at the fastest preset (measured ~1.1x at
  // ultrafast+720p, ~0.4x at 1080p/veryfast) — too marginal to trust for
  // smooth playback, so we cap resolution and use the fastest preset only
  // when a real encode is unavoidable. Stream-copy (remux) is unaffected —
  // it's I/O-bound, not CPU-bound, and runs at ~18x real-time regardless.
  const needsEncode = plan.videoCodec !== 'copy';
  const args = [
    '-loglevel', 'error',
    '-i', inputUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    ...(needsEncode ? ['-vf', "scale='min(1280,iw)':-2"] : []),
    '-c:v', plan.videoCodec,
    ...(needsEncode ? ['-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', plan.audioCodec,
    ...(plan.audioCodec !== 'copy' ? ['-ac', '2', '-b:a', '160k'] : []),
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', outputPath,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg exited ${code}`));
      resolve(outputPath);
    });
  });
}

module.exports = { probe, planFor, renderToFile };
