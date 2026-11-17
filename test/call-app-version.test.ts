import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { CALL_APP_VERSION } from '../server/services/calls.js';

/**
 * The WA Reach Calls app WA Reach serves (Calls → Get the app) must be the version the server
 * announces, or phones are told about an update that isn't there. The Android CI job also reads the
 * version inside the APK file itself and checks it against this.
 */
describe('the WA Reach Calls app WA Reach hands out', () => {
  it('is the version the server announces', () => {
    const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
    expect(/versionName '([^']+)'/.exec(gradle)?.[1]).toBe(CALL_APP_VERSION);
  });

  it('ships with the web app', () => {
    const apk = readFileSync(new URL('../web/public/downloads/wa-reach-calls.apk', import.meta.url));
    // An APK is a zip file holding the app's manifest.
    expect(apk.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(apk.includes(Buffer.from('AndroidManifest.xml'))).toBe(true);
    expect(statSync(new URL('../web/public/downloads/wa-reach-calls.apk', import.meta.url)).size).toBeGreaterThan(10_000);
  });
});
