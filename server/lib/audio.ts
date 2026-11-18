import { execFile } from 'node:child_process';
import { chmodSync, renameSync, rmSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long an audio file plays, in seconds, or null when ffprobe isn't installed or can't read it. */
export async function audioSeconds(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { timeout: 20_000 });
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** A recording this much longer than the call is trimmed; less is left as it is. */
const SLACK_SECONDS = 2;
/** Kept before the call's talk time, so its first word isn't cut. */
const LEAD_IN_SECONDS = 1;

/**
 * Some phones' dialers start recording when the number is dialled, so the file begins with the
 * ringing. The call log says how long the call was talked for, and the recording ends when the call
 * ends, so the talk is the file's last `talkSeconds`: keep that (plus a second) and drop the ringing.
 * The audio is copied, not re-encoded. If anything fails, the recording stays exactly as it came.
 * Returns the file's size afterwards.
 */
export async function trimToTalk(path: string, ext: string, talkSeconds: number): Promise<number> {
  const length = await audioSeconds(path);
  if (!length || talkSeconds <= 0 || length <= talkSeconds + SLACK_SECONDS) return statSync(path).size;
  const from = Math.max(0, length - talkSeconds - LEAD_IN_SECONDS);
  const out = `${path}.trim.${ext}`;
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', from.toFixed(2), '-i', path, '-map', '0:a:0', '-c', 'copy', out], { timeout: 60_000 });
    const trimmed = await audioSeconds(out);
    // Only keep the cut if it plays for about the talk time; otherwise keep the original.
    if (trimmed && Math.abs(trimmed - (talkSeconds + LEAD_IN_SECONDS)) <= SLACK_SECONDS + 1) {
      chmodSync(out, 0o600);
      renameSync(out, path);
    }
  } catch {
    // No ffmpeg, or a file it can't cut: the full recording is kept.
  } finally {
    rmSync(out, { force: true });
  }
  return statSync(path).size;
}
