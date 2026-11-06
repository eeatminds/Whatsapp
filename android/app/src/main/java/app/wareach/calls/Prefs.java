package app.wareach.calls;

import android.content.Context;
import android.content.SharedPreferences;

/** What the app remembers: where WA Reach is, the phone's sign-in secret, and how far it has sent. */
final class Prefs {
    static final String FILE = "wa_reach_calls";
    private final SharedPreferences p;

    Prefs(Context context) {
        p = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    SharedPreferences raw() {
        return p;
    }

    boolean signedIn() {
        return !token().isEmpty();
    }

    String server() {
        return p.getString("server", BuildConfig.DEFAULT_SERVER);
    }

    String token() {
        return p.getString("token", "");
    }

    String business() {
        return p.getString("business", "");
    }

    String userName() {
        return p.getString("user", "");
    }

    /** Calls before this (ms) are never sent. */
    long since() {
        return p.getLong("since", 0);
    }

    /** The newest call log entry already sent (its row id), so each sync sends only what's new. */
    long lastCallId() {
        return p.getLong("lastCallId", 0);
    }

    long lastSyncAt() {
        return p.getLong("lastSyncAt", 0);
    }

    String lastError() {
        return p.getString("lastError", "");
    }

    String latestVersion() {
        return p.getString("latestVersion", "");
    }

    String appUrl() {
        return p.getString("appUrl", "");
    }

    /** Calls with leads kept by WA Reach today (this phone's local day). */
    int keptToday() {
        return p.getString("keptDay", "").equals(Time.today()) ? p.getInt("keptToday", 0) : 0;
    }

    void signIn(String server, String token, String business, String user, long since) {
        p.edit()
                .clear()
                .putString("server", server)
                .putString("token", token)
                .putString("business", business)
                .putString("user", user)
                .putLong("since", since)
                .apply();
    }

    void signOut() {
        String server = server();
        p.edit().clear().putString("server", server).apply();
    }

    void setAbout(String business, String user, String latestVersion, String appUrl) {
        p.edit().putString("business", business).putString("user", user).putString("latestVersion", latestVersion).putString("appUrl", appUrl).apply();
    }

    void synced(long lastCallId, int kept) {
        String today = Time.today();
        int before = keptToday();
        p.edit()
                .putLong("lastCallId", Math.max(lastCallId, lastCallId()))
                .putLong("lastSyncAt", System.currentTimeMillis())
                .putString("lastError", "")
                .putString("keptDay", today)
                .putInt("keptToday", before + kept)
                .apply();
    }

    void failed(String error) {
        p.edit().putString("lastError", error).apply();
    }
}
