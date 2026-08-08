const SUBTITLE_EXTS = ['.srt', '.vtt'];

// Cue-identifier lines (bare numbers) before a timestamp line are valid in
// both formats, so only the timestamp separator and header actually differ.
function srtToVtt(srtText) {
  const body = srtText.replace(/\r+/g, '').trim().replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body}\n`;
}

function toVtt(text, ext) {
  return ext.toLowerCase() === '.srt' ? srtToVtt(text) : text;
}

module.exports = { SUBTITLE_EXTS, srtToVtt, toVtt };
