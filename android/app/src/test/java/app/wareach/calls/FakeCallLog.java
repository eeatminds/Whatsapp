package app.wareach.calls;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.provider.CallLog;
import java.util.ArrayList;
import java.util.List;

/** The phone's call log, as the app reads it: a few calls, filtered and sorted like the real one. */
public class FakeCallLog extends ContentProvider {
    static final List<Object[]> ROWS = new ArrayList<>();

    static void add(long id, String number, int type, long date, int duration) {
        ROWS.add(new Object[] {id, number, type, date, duration});
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        List<String> all = java.util.Arrays.asList(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION);
        MatrixCursor cursor = new MatrixCursor(projection);
        List<Object[]> rows = new ArrayList<>();
        for (Object[] row : ROWS) {
            // CallLogReader asks for rows after an id and from a date on.
            if (args != null && args.length == 2 && ((long) row[0] <= Long.parseLong(args[0]) || (long) row[3] < Long.parseLong(args[1]))) continue;
            rows.add(row);
        }
        rows.sort((a, b) -> Long.compare((long) a[0], (long) b[0]));
        if (sortOrder != null && sortOrder.endsWith("DESC")) java.util.Collections.reverse(rows);
        for (Object[] row : rows) {
            Object[] out = new Object[projection.length];
            for (int i = 0; i < projection.length; i++) out[i] = row[all.indexOf(projection[i])];
            cursor.addRow(out);
        }
        return cursor;
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
