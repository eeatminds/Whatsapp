package app.wareach.calls;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.os.Build;
import java.io.InputStream;
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

    static String deviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String model = Build.MODEL == null ? "Phone" : Build.MODEL;
        String name = model.toLowerCase(Locale.ROOT).startsWith(maker.toLowerCase(Locale.ROOT)) ? model : maker + " " + model;
        name = name.trim();
        return name.isEmpty() ? "Phone" : name.substring(0, 1).toUpperCase(Locale.ROOT) + name.substring(1);
    }

    /** Runs one round. Returns false when it should be tried again later. */
    static synchronized boolean run(Context context) {
        Prefs prefs = new Prefs(context);
        if (!prefs.signedIn()) return true;
        if (!canReadCalls(context)) {
            prefs.failed(context.getString(R.string.error_no_call_permission));
            return true;
        }
        try {
            // If the call log was cleared, its row numbers start again.
            long lastId = prefs.lastCallId();
            if (lastId > CallLogReader.newestId(context)) lastId = 0;
            boolean recordings = canReadRecordings(context);
            JSONObject device = new JSONObject()
                    .put("name", deviceName())
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("recordings", recordings ? "allowed" : "denied");
            int kept = 0;
            JSONArray wanted = new JSONArray();
            while (true) {
                List<CallLogReader.Entry> entries = CallLogReader.read(context, lastId, prefs.since(), BATCH);
                JSONArray calls = new JSONArray();
                for (CallLogReader.Entry e : entries) {
                    calls.put(new JSONObject().put("number", e.number).put("type", e.type).put("startedAt", e.startedAt).put("duration", e.duration));
                }
                JSONObject res = Api.json("POST", prefs.server(), "/calls", prefs.token(), new JSONObject().put("device", device).put("calls", calls));
                kept += res.optInt("stored", 0);
                wanted = res.optJSONArray("recordingsWanted") == null ? new JSONArray() : res.optJSONArray("recordingsWanted");
                if (!entries.isEmpty()) lastId = entries.get(entries.size() - 1).id;
                prefs.synced(lastId, 0);
                if (entries.size() < BATCH) break;
            }
            if (recordings) sendRecordings(context, prefs, wanted);
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

    private static void sendRecordings(Context context, Prefs prefs, JSONArray wanted) throws Exception {
        long now = System.currentTimeMillis();
        for (int i = 0; i < wanted.length(); i++) {
            JSONObject call = wanted.getJSONObject(i);
            long id = call.getLong("id");
            long startedAt = call.getLong("startedAt");
            int duration = call.getInt("duration");
            RecordingFinder.Found found = RecordingFinder.find(context, call.getString("number"), startedAt, duration);
            if (found != null) {
                // The file's real size now (the media index can lag behind a file still being written).
                try (AssetFileDescriptor file = context.getContentResolver().openAssetFileDescriptor(found.uri, "r")) {
                    if (file != null) {
                        long length = file.getLength() >= 0 ? file.getLength() : file.getParcelFileDescriptor().getStatSize();
                        try (InputStream in = file.createInputStream()) {
                            Api.upload(prefs.server(), "/recordings/" + id, prefs.token(), in, length, found.mime);
                        }
                        continue;
                    }
                } catch (Api.ApiException e) {
                    // Not a recording WA Reach accepts: say there is none rather than retry forever.
                    if (e.status == 415 || e.status == 400) {
                        Api.json("POST", prefs.server(), "/recordings/" + id + "/none", prefs.token(), null);
                        continue;
                    }
                    throw e;
                }
            }
            if (now > startedAt + duration * 1000L + GIVE_UP_MS) {
                Api.json("POST", prefs.server(), "/recordings/" + id + "/none", prefs.token(), null);
            }
        }
    }
}
