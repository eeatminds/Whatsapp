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
        /** The file's path, to open it directly if the media index won't hand it over. */
        final String path;
        final String folder;

        Found(Uri uri, long size, String mime, String path, String folder) {
            this.uri = uri;
            this.size = size;
            this.mime = mime;
            this.path = path;
            this.folder = folder;
        }
    }

    /** What a search saw, so the phone can say why a call has no recording. Folders and lengths only. */
    static final class Search {
        Found found;
        /** Audio files saved around the call, anywhere on the phone. */
        int nearby;
        /** Of those, the ones in a call recordings folder or named with the number. */
        int candidates;
        /** Folders the nearby files were in (a few). */
        final java.util.LinkedHashSet<String> folders = new java.util.LinkedHashSet<>();
        /** A candidate skipped for its length, in seconds (0 if none). */
        long wrongLength;
        /** Candidates skipped for being empty or tiny (still being saved), or huge. */
        int badSize;
    }

    static Search find(Context context, String number, long startedAt, int durationSec) {
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
            MediaStore.Audio.Media.DATA,
        };
        // The file is written while the call goes on and finished when it ends.
        long from = startedAt / 1000 - 120;
        long to = (startedAt + durationSec * 1000L) / 1000 + 30 * 60;
        String where = "(" + MediaStore.Audio.Media.DATE_ADDED + " BETWEEN ? AND ?) OR (" + MediaStore.Audio.Media.DATE_MODIFIED + " BETWEEN ? AND ?)";
        String[] args = {String.valueOf(from), String.valueOf(to), String.valueOf(from), String.valueOf(to)};
        String digits = lastDigits(number, 8);
        long callEnd = startedAt + durationSec * 1000L;

        Search search = new Search();
        long bestScore = Long.MAX_VALUE;
        try (Cursor c = context.getContentResolver().query(collection, columns, where, args, null)) {
            if (c == null) return search;
            while (c.moveToNext()) {
                String name = c.getString(1) == null ? "" : c.getString(1);
                String path = c.getString(2) == null ? "" : c.getString(2);
                long size = c.getLong(5);
                long length = c.isNull(7) ? 0 : c.getLong(7);
                search.nearby++;
                if (search.folders.size() < 4) search.folders.add(folderOf(path));
                boolean named = !digits.isEmpty() && name.replaceAll("\\D", "").contains(digits);
                boolean inCallFolder = (path + "/" + name).toLowerCase(Locale.ROOT).contains("call");
                if (!named && !inCallFolder) continue;
                search.candidates++;
                if (size < 1024 || size > 60L * 1024 * 1024) {
                    search.badSize++;
                    continue;
                }
                // A recording much longer or shorter than the call is another call's. Some dialers start
                // recording while the call is still ringing, so a recording may run longer by that much.
                if (length > 0 && !lengthFits(length / 1000, durationSec)) {
                    search.wrongLength = length / 1000;
                    continue;
                }
                long modified = c.getLong(4) * 1000;
                long score = Math.abs(modified - callEnd) - (named ? 3_600_000L : 0);
                if (score < bestScore) {
                    bestScore = score;
                    Uri uri = ContentUris.withAppendedId(collection, c.getLong(0));
                    search.found = new Found(uri, size, c.getString(6), c.getString(8), folderOf(path));
                }
            }
        }
        return search;
    }

    /** "Record/Call/": the folder under the phone's storage (before Android 10 the column is a full path). */
    static String folderOf(String path) {
        if (Build.VERSION.SDK_INT >= 29) return path;
        String dir = path.substring(0, Math.max(0, path.lastIndexOf('/') + 1));
        int storage = dir.indexOf("/emulated/0/");
        return storage >= 0 ? dir.substring(storage + "/emulated/0/".length()) : dir;
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
                String dir = folderOf(path);
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
