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
                // A recording much longer or shorter than the call is another call's.
                if (length > 0 && Math.abs(length / 1000 - durationSec) > Math.max(20, durationSec / 4)) continue;
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

    private static String lastDigits(String number, int n) {
        String d = number == null ? "" : number.replaceAll("\\D", "");
        return d.length() <= n ? d : d.substring(d.length() - n);
    }
}
