// lib/sounds.js — Cross-platform sound playback, OS sound detection, sound resolution
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

/**
 * Play a bundled sound by name. Non-blocking — fires and forgets.
 * @param {'notification' | 'task-complete'} soundName
 * @param {number} volume - 0.0 to 1.0
 */
function playSound(soundName, volume = 0.5) {
  const soundFile = path.join(SOUNDS_DIR, `${soundName}.wav`);
  playSoundFile(soundFile, volume * 100);
}

/**
 * Play any sound file by absolute path. Non-blocking — fires and forgets.
 *
 * Volume is a 0–100 slider. 0 = silent, 50 ≈ typical OS notification at the
 * user's current system volume, 100 = the sound file's recorded level
 * ("unity"). The mapping is linear on the amplitude axis, which on our
 * bundled ~–10 to –14 dBFS source files gives:
 *   vol=5   → ~–36 dBFS peak (barely audible)
 *   vol=50  → ~–16 dBFS peak (normal notification)
 *   vol=100 → ~–11 dBFS peak (louder than OS default, still sane)
 *
 * @param {string} filePath - Absolute path to audio file
 * @param {number} volume   - 0 to 100
 */
function playSoundFile(filePath, volume = 50) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const v = clamp(volume, 0, 100);
  if (v === 0) return;
  try {
    if (process.platform === 'darwin') {
      // afplay -v is an amplitude multiplier (1.0 = unity). Anything above
      // ~1.0 clips. Map 0–100 → 0.0–1.0 linear so the OS master volume
      // stays in control.
      const macVol = (v / 100).toFixed(3);
      execFile('afplay', ['-v', macVol, filePath], handleError);
    } else if (process.platform === 'win32') {
      // SoundPlayer has no volume knob, so use WPF's MediaPlayer which
      // accepts 0.0–1.0. Fall back to SoundPlayer if WPF isn't available.
      const esc = filePath.replace(/'/g, "''");
      const vol = (v / 100).toFixed(3);
      const psCmd = `
        try {
          Add-Type -AssemblyName PresentationCore -ErrorAction Stop
          $p = New-Object System.Windows.Media.MediaPlayer
          $p.Open([System.Uri]::new('${esc}', [System.UriKind]::Absolute))
          $p.Volume = ${vol}
          while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 20 }
          $ms = [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 150
          $p.Play()
          Start-Sleep -Milliseconds $ms
          $p.Close()
        } catch {
          (New-Object System.Media.SoundPlayer '${esc}').PlaySync()
        }`.trim();
      execFile('powershell', ['-NoProfile', '-Command', psCmd], handleError);
    } else {
      // paplay --volume is 0–65536 linear, where 65536 is unity.
      const paVol = String(Math.round((v / 100) * 65536));
      execFile('paplay', ['--volume', paVol, filePath], (err) => {
        // aplay has no volume flag; when paplay is absent, fall back to
        // OS mixer-controlled playback at the file's recorded level.
        if (err) execFile('aplay', [filePath], handleError);
      });
    }
  } catch (_) {}
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

/**
 * Discover system sounds available on the current OS.
 * @returns {{ label: string, path: string }[]}
 */
function discoverSystemSounds() {
  const sounds = [];
  try {
    if (process.platform === 'darwin') {
      const dir = '/System/Library/Sounds';
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.aiff')) {
            sounds.push({ label: path.basename(file, '.aiff'), path: path.join(dir, file) });
          }
        }
      }
    } else if (process.platform === 'win32') {
      const dir = 'C:\\Windows\\Media';
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.wav')) {
            sounds.push({ label: path.basename(file, '.wav'), path: path.join(dir, file) });
          }
        }
      }
    } else {
      for (const dir of ['/usr/share/sounds/freedesktop/stereo', '/usr/share/sounds']) {
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir)) {
            if (file.match(/\.(wav|ogg|oga)$/)) {
              sounds.push({ label: path.basename(file, path.extname(file)), path: path.join(dir, file) });
            }
          }
        }
      }
    }
  } catch (_) {}
  return sounds;
}

/**
 * Resolve a sound setting string to an absolute file path.
 * @param {string} setting - e.g. "bundled:task-complete", "system:Glass", "custom", "none"
 * @param {string} customPath - user-provided path (used when setting is "custom")
 * @param {string} extensionPath - context.extensionPath
 * @returns {string|null}
 */
function resolveSoundPath(setting, customPath, extensionPath) {
  if (!setting || setting === 'none') return null;
  if (setting === 'custom') return customPath || null;
  if (setting.startsWith('bundled:')) {
    const name = setting.replace('bundled:', '');
    return path.join(extensionPath, 'sounds', `${name}.wav`);
  }
  if (setting.startsWith('system:')) {
    const name = setting.replace('system:', '');
    const systemSounds = discoverSystemSounds();
    const match = systemSounds.find(s => s.label === name);
    return match ? match.path : null;
  }
  return null;
}

function handleError(err) {
  if (err && process.env.CLAUDE_TERMINAL_FOCUS_DEBUG) {
    console.error('Sound playback error:', err.message);
  }
}

module.exports = { playSound, playSoundFile, discoverSystemSounds, resolveSoundPath };
