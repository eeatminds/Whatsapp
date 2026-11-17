package app.wareach.calls;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class Time {
    private Time() {}

    static String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    /** "just now", "5 min ago", "2 h ago", "3 days ago". */
    static String ago(long at) {
        long minutes = (System.currentTimeMillis() - at) / 60_000;
        if (minutes < 1) return "just now";
        if (minutes < 60) return minutes + " min ago";
        long hours = minutes / 60;
        if (hours < 48) return hours + " h ago";
        return (hours / 24) + " days ago";
    }
}
