package app.wareach.calls;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.os.Build;
import android.os.PowerManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * One round: send the call log entries added since last time, then upload the recordings WA Reach
 * asks for. WA Reach keeps only calls with leads' numbers and ignores the rest.
 */
final class Sync {
    private Sync() {}

    private static final int BATCH = 200;
    /** After this long without finding a recording, tell WA Reach there isn't one. */
    private static final long GIVE_UP_MS = 30 * 60_000L;

    static boolean canReadCalls(Context c) {
        return c.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    static String audioPermission() {
        return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    static boolean canReadRecordings(Context c) {
        return c.checkSelfPermission(audioPermission()) == PackageManager.PERMISSION_GRANTED;
    }

    /** False when Android may stop the app in the background (battery saving), so calls arrive late. */
    static boolean runsInBackground(Context c) {
        PowerManager pm = c.getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    static String deviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "Phone" : Build.MODEL;
        String name = model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT)) ? model : maker + " " + model;
        name = name.trim();
        return name.isEmpty() ? "Phone" : name.substring(0, 1).toUpperCase(Locale.ROOT) + name.substring(1);
    }

    /** Runs one round. Returns false when it should be tried again later. */
    static boolean run(Context context) {
        return run(context, true);
    }

    /**
     * Runs one round. With lookAgain, a recording the dialer hasn't finished saving yet gets another
     * look in a couple of minutes, rather than at the next 15-minute round.
     */
    static synchronized boolean run(Context context, boolean lookAgain) {
        Prefs prefs = new Prefs(context);
        if (!prefs.signedIn()) return true;
        try {
            boolean callHistory = canReadCalls(context);
            boolean recordings = canReadRecordings(context);
            // How this phone is set up, so the admin can see a phone that can't send (shown on the Calls page).
            JSONObject device = new JSONObject()
                    .put("name", deviceName())
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("recordings", recordings ? "allowed" : "denied")
                    .put("callHistory", callHistory ? "allowed" : "denied")
                    .put("background", runsInBackground(context) ? "allowed" : "restricted");
            if (recordings) {
                // Whether the phone's dialer is saving call recordings at all (folder and time only).
                RecordingFinder.Latest latest = latestRecording(context);
                device.put("recordingsFolder", latest == null ? "" : latest.folder).put("lastRecordingAt", latest == null ? 0 : latest.at);
                prefs.recordingsChecked(latest == null ? "" : latest.folder, latest == null ? 0 : latest.at);
            }
            if (!prefs.recordingReport().isEmpty()) device.put("recordingCheck", prefs.recordingReport());
            String problem = prefs.problem();
            if (!problem.isEmpty() && !prefs.problemReported()) device.put("problem", problem);
            if (!callHistory) {
                // Still check in, so WA Reach can tell the admin that call history access is off.
                Api.json("POST", prefs.server(), "/calls", prefs.token(), new JSONObject().put("device", device).put("calls", new JSONArray()));
                prefs.reported(problem);
                prefs.failed(context.getString(R.string.error_no_call_permission));
                return true;
            }
            // If the call log was cleared, its row numbers start again.
            long lastId = prefs.lastCallId();
            if (lastId > CallLogReader.newestId(context)) lastId = 0;
            int kept = 0;
            JSONArray wanted = new JSONArray();
            while (true) {
                List<CallLogReader.Entry> entries = CallLogReader.read(context, lastId, prefs.since(), BATCH);
                JSONArray calls = new JSONArray();
                for (CallLogReader.Entry e : entries) {
                    calls.put(new JSONObject().put("number", e.number).put("type", e.type).put("startedAt", e.startedAt).put("duration", e.duration));
                }
                JSONObject res = Api.json("POST", prefs.server(), "/calls", prefs.token(), new JSONObject().put("device", device).put("calls", calls));
                prefs.reported(problem);
                device.remove("problem");
                kept += res.optInt("stored", 0);
                wanted = res.optJSONArray("recordingsWanted") == null ? new JSONArray() : res.optJSONArray("recordingsWanted");
                if (!entries.isEmpty()) lastId = entries.get(entries.size() - 1).id;
                prefs.synced(lastId, 0);
                if (entries.size() < BATCH) break;
            }
            if (recordings) {
                String before = prefs.recordingReport();
                if (sendRecordings(context, prefs, wanted) > 0 && lookAgain) Scheduler.lookAgainSoon(context);
                // Tell WA Reach straight away what happened to the newest call's recording.
                if (!prefs.recordingReport().equals(before)) {
                    JSONObject check = new JSONObject().put("recordingCheck", prefs.recordingReport());
                    Api.json("POST", prefs.server(), "/calls", prefs.token(), new JSONObject().put("device", check).put("calls", new JSONArray()));
                }
            }
            prefs.synced(lastId, kept);
            return true;
        } catch (Api.ApiException e) {
            if (e.signedOut) {
                prefs.signOut();
                Scheduler.cancel(context);
            }
            prefs.failed(e.getMessage());
            return e.status < 500 && e.status != 429;
        } catch (Exception e) {
            prefs.failed(context.getString(R.string.error_offline));
            return false;
        }
    }

    private static RecordingFinder.Latest latestRecording(Context context) {
        try {
            return RecordingFinder.latest(context);
        } catch (RuntimeException e) {
            // Some phones' media index refuses a query; the calls still go out.
            return null;
        }
    }

    /**
     * Uploads the recordings WA Reach asked for. Returns how many weren't found yet but may still
     * appear (the dialer can take a moment to save the file); after GIVE_UP_MS WA Reach is told there
     * is none. What happened to the newest call is kept as a short report for the caller and admin.
     */
    private static int sendRecordings(Context context, Prefs prefs, JSONArray wanted) throws Exception {
        long now = System.currentTimeMillis();
        int notYet = 0;
        String report = null;
        for (int i = 0; i < wanted.length(); i++) {
            JSONObject call = wanted.getJSONObject(i);
            long id = call.getLong("id");
            long startedAt = call.getLong("startedAt");
            int duration = call.getInt("duration");
            String when = new SimpleDateFormat("d MMM h:mm a", Locale.ENGLISH).format(new Date(startedAt));
            RecordingFinder.Search search;
            try {
                search = RecordingFinder.find(context, call.getString("number"), startedAt, duration);
            } catch (RuntimeException e) {
                search = new RecordingFinder.Search();
                report = "Call at " + when + ": the phone's media list couldn't be searched (" + e.getClass().getSimpleName() + ").";
            }
            if (search.found != null) {
                String outcome = upload(context, prefs, id, search.found);
                if (outcome == null) {
                    report = "Call at " + when + ": recording sent (from " + search.found.folder + ").";
                    continue;
                }
                report = "Call at " + when + ": found its recording in " + search.found.folder + " but " + outcome;
                if (outcome.startsWith("WA Reach")) continue;
            } else if (report == null || !report.startsWith("Call at " + when)) {
                report = "Call at " + when + ": " + describe(search, duration);
            }
            if (now > startedAt + duration * 1000L + GIVE_UP_MS) {
                Api.json("POST", prefs.server(), "/recordings/" + id + "/none", prefs.token(), null);
            } else {
                notYet++;
            }
        }
        if (report != null) prefs.recordingReport(report);
        return notYet;
    }

    /** Why no recording was found for a call, in words for the caller and the admin. */
    static String describe(RecordingFinder.Search search, int callSec) {
        if (search.nearby == 0) return "no audio file was saved on the phone around it, so the Phone app didn't record it.";
        if (search.candidates == 0) {
            return "audio files were saved around it (in " + String.join(", ", search.folders)
                    + ") but none in a call recordings folder or named with the number.";
        }
        if (search.badSize == search.candidates) return "the recording in " + String.join(", ", search.folders) + " is empty or still being saved.";
        if (search.wrongLength > 0) return "the recording nearest it is " + search.wrongLength + " s long and the call was " + callSec + " s, so it's another call's.";
        return "no matching recording yet.";
    }

    /**
     * Sends one recording: through the media list, or straight from its file if the media list won't
     * hand it over. Returns null when sent, else what went wrong (starting "WA Reach" when WA Reach
     * refused the file, which then counts as having no recording).
     */
    private static String upload(Context context, Prefs prefs, long callId, RecordingFinder.Found found) throws Exception {
        String problem;
        try {
            AssetFileDescriptor file = context.getContentResolver().openAssetFileDescriptor(found.uri, "r");
            if (file != null) {
                try (AssetFileDescriptor f = file; InputStream in = f.createInputStream()) {
                    // The file's real size now (the media index can lag behind a file still being written).
                    long length = f.getLength() >= 0 ? f.getLength() : f.getParcelFileDescriptor().getStatSize();
                    if (length > 0) return send(prefs, callId, in, length, found.mime);
                }
            }
            problem = "the media list gave an empty file";
        } catch (Api.ApiException e) {
            throw e;
        } catch (java.io.IOException | RuntimeException e) {
            problem = "couldn't open it (" + e.getClass().getSimpleName() + ")";
        }
        // Some phones' media lists refuse; the file itself can still be readable with the audio permission.
        if (found.path != null && !found.path.isEmpty()) {
            File file = new File(found.path);
            try (InputStream in = new FileInputStream(file)) {
                if (file.length() > 0) return send(prefs, callId, in, file.length(), found.mime);
            } catch (Api.ApiException e) {
                throw e;
            } catch (java.io.IOException | RuntimeException e) {
                problem += "; reading the file failed too (" + e.getClass().getSimpleName() + ")";
            }
        }
        return problem + ".";
    }

    private static String send(Prefs prefs, long callId, InputStream in, long length, String mime) throws Exception {
        try {
            Api.upload(prefs.server(), "/recordings/" + callId, prefs.token(), in, length, mime);
            return null;
        } catch (Api.ApiException e) {
            // Not a recording WA Reach accepts: say there is none rather than retry forever.
            if (e.status == 415 || e.status == 400) {
                Api.json("POST", prefs.server(), "/recordings/" + callId + "/none", prefs.token(), null);
                return "WA Reach didn't accept the file (" + e.getMessage() + ").";
            }
            throw e;
        }
    }
}
