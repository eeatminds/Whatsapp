package app.wareach.calls;

import android.app.Application;
import android.os.Build;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * If the app ever closes unexpectedly, remember why: the app shows the reason the next time it is
 * opened and sends it to WA Reach with the next sync, so the admin (and whoever fixes the app) can
 * see it. Nothing else is collected.
 */
public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                new Prefs(this).crashed(describe(error));
            } catch (Throwable ignored) {
                // Never stand in the way of Android's own crash handling.
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    /** The error and where it happened, kept short: Android version, phone, app version, stack. */
    static String describe(Throwable error) {
        StringWriter out = new StringWriter();
        error.printStackTrace(new PrintWriter(out));
        String trace = out.toString();
        if (trace.length() > 1600) trace = trace.substring(0, 1600);
        return error.getClass().getSimpleName() + ": " + error.getMessage()
                + "\nAndroid " + Build.VERSION.RELEASE + " (" + Build.VERSION.SDK_INT + "), " + Sync.deviceName() + ", app " + BuildConfig.VERSION_NAME
                + "\n" + trace;
    }
}
