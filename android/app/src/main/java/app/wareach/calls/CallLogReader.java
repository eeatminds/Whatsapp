package app.wareach.calls;

import android.content.Context;
import android.database.Cursor;
import android.provider.CallLog;
import java.util.ArrayList;
import java.util.List;

/** Reads new entries from the phone's call log. */
final class CallLogReader {
    private CallLogReader() {}

    static final class Entry {
        final long id;
        final String number;
        final int type;
        final long startedAt;
        final int duration;

        Entry(long id, String number, int type, long startedAt, int duration) {
            this.id = id;
            this.number = number;
            this.type = type;
            this.startedAt = startedAt;
            this.duration = duration;
        }
    }

    /** Entries added after row afterId that started at or after since (ms), oldest first, at most limit. */
    static List<Entry> read(Context context, long afterId, long since, int limit) {
        List<Entry> out = new ArrayList<>();
        String[] columns = {CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION};
        String where = CallLog.Calls._ID + " > ? AND " + CallLog.Calls.DATE + " >= ?";
        String[] args = {String.valueOf(afterId), String.valueOf(since)};
        try (Cursor c = context.getContentResolver().query(CallLog.Calls.CONTENT_URI, columns, where, args, CallLog.Calls._ID + " ASC")) {
            if (c == null) return out;
            while (c.moveToNext() && out.size() < limit) {
                String number = c.getString(1);
                if (number == null || number.trim().isEmpty()) continue;
                out.add(new Entry(c.getLong(0), number, c.getInt(2), c.getLong(3), c.getInt(4)));
            }
        }
        return out;
    }

    /** The newest row id in the call log, or 0. */
    static long newestId(Context context) {
        String[] columns = {CallLog.Calls._ID};
        try (Cursor c = context.getContentResolver().query(CallLog.Calls.CONTENT_URI, columns, null, null, CallLog.Calls._ID + " DESC")) {
            return c != null && c.moveToFirst() ? c.getLong(0) : 0;
        }
    }
}
