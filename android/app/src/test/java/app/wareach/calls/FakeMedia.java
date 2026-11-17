package app.wareach.calls;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** The phone's media index for audio files, with real files behind it, filtered like the real one. */
public class FakeMedia extends ContentProvider {
    static final class Row {
        final long id;
        final String name;
        final String folder;
        final long addedSec;
        final long modifiedSec;
        final File file;
        final String mime;
        final long durationMs;
        /** As listed when the file was saved, even if the file is gone since. */
        final long size;

        Row(long id, String name, String folder, long addedSec, long modifiedSec, File file, String mime, long durationMs) {
            this.id = id;
            this.name = name;
            this.folder = folder;
            this.addedSec = addedSec;
            this.modifiedSec = modifiedSec;
            this.file = file;
            this.mime = mime;
            this.durationMs = durationMs;
            this.size = file.length();
        }

        Object value(String column) {
            switch (column) {
                case MediaStore.Audio.Media._ID:
                    return id;
                case MediaStore.Audio.Media.DISPLAY_NAME:
                    return name;
                case MediaStore.Audio.Media.RELATIVE_PATH:
                    return folder;
                case MediaStore.Audio.Media.DATA:
                    return file.getAbsolutePath();
                case MediaStore.Audio.Media.DATE_ADDED:
                    return addedSec;
                case MediaStore.Audio.Media.DATE_MODIFIED:
                    return modifiedSec;
                case MediaStore.Audio.Media.SIZE:
                    return size;
                case MediaStore.Audio.Media.MIME_TYPE:
                    return mime;
                case MediaStore.Audio.Media.DURATION:
                    return durationMs;
                default:
                    return null;
            }
        }
    }

    static final List<Row> ROWS = new ArrayList<>();
    /** Like some phones' media lists: the file is listed but can't be opened through it. */
    static volatile boolean refuseOpen;
    private static final Map<Long, File> FILES = new HashMap<>();

    static void add(Row row) {
        ROWS.add(row);
        FILES.put(row.id, row.file);
    }

    static void clear() {
        ROWS.clear();
        FILES.clear();
        refuseOpen = false;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        MatrixCursor cursor = new MatrixCursor(projection);
        List<Row> rows = new ArrayList<>();
        for (Row row : ROWS) {
            if (args != null && args.length == 4) {
                // "(added BETWEEN ? AND ?) OR (modified BETWEEN ? AND ?)"
                long from = Long.parseLong(args[0]);
                long to = Long.parseLong(args[1]);
                boolean added = row.addedSec >= from && row.addedSec <= to;
                boolean modified = row.modifiedSec >= Long.parseLong(args[2]) && row.modifiedSec <= Long.parseLong(args[3]);
                if (!added && !modified) continue;
            } else if (args != null && args.length == 1 && row.addedSec < Long.parseLong(args[0])) {
                continue; // "added >= ?"
            }
            rows.add(row);
        }
        if (sortOrder != null && sortOrder.endsWith("DESC")) rows.sort((a, b) -> Long.compare(b.addedSec, a.addedSec));
        for (Row row : rows) {
            Object[] values = new Object[projection.length];
            for (int i = 0; i < projection.length; i++) values[i] = row.value(projection[i]);
            cursor.addRow(values);
        }
        return cursor;
    }

    @Override
    public AssetFileDescriptor openAssetFile(Uri uri, String mode) throws FileNotFoundException {
        if (refuseOpen) throw new FileNotFoundException("Not allowed: " + uri);
        File file = FILES.get(Long.parseLong(uri.getLastPathSegment()));
        if (file == null || !file.exists()) throw new FileNotFoundException(uri.toString());
        return new AssetFileDescriptor(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY), 0, file.length());
    }

    @Override
    public String getType(Uri uri) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] args) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] args) {
        return 0;
    }
}
