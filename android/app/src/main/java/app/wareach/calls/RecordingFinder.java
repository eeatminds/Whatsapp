package app.wareach.calls;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import java.util.Locale;

/**
 * Finds the recording the phone's own dialer made of a call. Samsung, Xiaomi, OnePlus, Oppo, Vivo
 * and Realme dialers save them in a folder with "call" in its name. Only such files, or files named
 * with the call's number, are ever considered, so voice notes and music are never sent.
 */
final class RecordingFinder {
    private RecordingFinder() {}

    static final class Found {
        final Uri uri;
        final long size;
        final String mime;

        Found(Uri uri, long size, String mime) {
            this.uri = uri;
            this.size = size;
            this.mime = mime;
        }
    }

    static Found find(Context context, String number, long startedAt, int durationSec) {
        Uri collection = Build.VERSION.SDK_INT >= 29
                ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String folder = Build.VERSION.SDK_INT >= 29 ? MediaStore.Audio.Media.RELATIVE_PATH : MediaStore.Audio.Media.DATA;
        String[] columns = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            folder,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DURATION,
        };
        // The file is written while the call goes on and finished when it ends.
        long from = startedAt / 1000 - 120;
        long to = (startedAt + durationSec * 1000L) / 1000 + 30 * 60;
        String where = "(" + MediaStore.Audio.Media.DATE_ADDED + " BETWEEN ? AND ?) OR (" + MediaStore.Audio.Media.DATE_MODIFIED + " BETWEEN ? AND ?)";
        String[] args = {String.valueOf(from), String.valueOf(to), String.valueOf(from), String.valueOf(to)};
        String digits = lastDigits(number, 8);
        long callEnd = startedAt + durationSec * 1000L;

        Found best = null;
        long bestScore = Long.MAX_VALUE;
        try (Cursor c = context.getContentResolver().query(collection, columns, where, args, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                String name = c.getString(1) == null ? "" : c.getString(1);
                String path = c.getString(2) == null ? "" : c.getString(2);
                long size = c.getLong(5);
                long length = c.isNull(7) ? 0 : c.getLong(7);
                if (size < 1024 || size > 60L * 1024 * 1024) continue;
                boolean named = !digits.isEmpty() && name.replaceAll("\\D", "").contains(digits);
                boolean inCallFolder = (path + "/" + name).toLowerCase(Locale.ROOT).contains("call");
                if (!named && !inCallFolder) continue;
                // A recording much longer or shorter than the call is another call's. Some dialers start
                // recording while the call is still ringing, so a recording may run longer by that much.
                if (length > 0 && !lengthFits(length / 1000, durationSec)) continue;
                long modified = c.getLong(4) * 1000;
                long score = Math.abs(modified - callEnd) - (named ? 3_600_000L : 0);
                if (score < bestScore) {
                    bestScore = score;
                    Uri uri = ContentUris.withAppendedId(collection, c.getLong(0));
                    best = new Found(uri, size, c.getString(6));
                }
            }
        }
        return best;
    }

    static boolean lengthFits(long recordingSec, int callSec) {
        long slack = Math.max(15, callSec / 4);
        return recordingSec >= callSec - slack && recordingSec <= callSec + slack + 75;
    }

    /** Where this phone's dialer saved its newest call recording (folder only), and when. */
    static final class Latest {
        final String folder;
        final long at;

        Latest(String folder, long at) {
            this.folder = folder;
            this.at = at;
        }
    }

    /**
     * The newest call recording on the phone in the last week, or null when there is none: tells the
     * caller and the admin whether the phone's dialer is recording calls at all. Only the folder and
     * the time are kept, never the file's name or what is in it.
     */
    static Latest latest(Context context) {
        Uri collection = Build.VERSION.SDK_INT >= 29
                ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String folder = Build.VERSION.SDK_INT >= 29 ? MediaStore.Audio.Media.RELATIVE_PATH : MediaStore.Audio.Media.DATA;
        String[] columns = {MediaStore.Audio.Media.DISPLAY_NAME, folder, MediaStore.Audio.Media.DATE_ADDED};
        String where = MediaStore.Audio.Media.DATE_ADDED + " >= ?";
        String[] args = {String.valueOf(System.currentTimeMillis() / 1000 - 7 * 86_400)};
        try (Cursor c = context.getContentResolver().query(collection, columns, where, args, MediaStore.Audio.Media.DATE_ADDED + " DESC")) {
            if (c == null) return null;
            for (int seen = 0; c.moveToNext() && seen < 500; seen++) {
                String name = c.getString(0) == null ? "" : c.getString(0);
                String path = c.getString(1) == null ? "" : c.getString(1);
                if (!(path + "/" + name).toLowerCase(Locale.ROOT).contains("call")) continue;
                // Before Android 10 the column is the file's full path: keep only its folder.
                String dir = Build.VERSION.SDK_INT >= 29 ? path : path.substring(0, Math.max(0, path.lastIndexOf('/') + 1)).replaceFirst("^/storage/emulated/0/", "");
                return new Latest(dir.length() > 120 ? dir.substring(dir.length() - 120) : dir, c.getLong(2) * 1000);
            }
        }
        return null;
    }

    private static String lastDigits(String number, int n) {
        String d = number == null ? "" : number.replaceAll("\\D", "");
        return d.length() <= n ? d : d.substring(d.length() - n);
    }
}
