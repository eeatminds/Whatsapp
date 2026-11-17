package app.wareach.calls;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.provider.CallLog;

/**
 * Two jobs: one every 15 minutes (Android's shortest), and one that runs right after a call ends,
 * when the call log changes.
 *
 * Android can refuse to schedule a job (a missing permission on a newer Android version, or a
 * phone maker's own limits). That must never close the app, so each request is guarded and a
 * refusal is shown on the app's screen instead.
 */
final class Scheduler {
    private Scheduler() {}

    static final int EVERY_15_MIN = 1;
    static final int AFTER_A_CALL = 2;
    static final int NOW = 3;

    static void schedule(Context context) {
        if (!new Prefs(context).signedIn()) return;
        JobScheduler js = context.getSystemService(JobScheduler.class);
        if (js == null) return;
        try {
            if (js.getPendingJob(EVERY_15_MIN) == null) {
                js.schedule(new JobInfo.Builder(EVERY_15_MIN, new ComponentName(context, SyncJob.class))
                        .setPeriodic(15 * 60_000L)
                        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                        .setPersisted(true)
                        .build());
            }
        } catch (RuntimeException e) {
            refused(context);
        }
        armCallTrigger(context);
    }

    /** One-shot: Android runs it after the call log changes, so it is armed again each time it runs. */
    static void armCallTrigger(Context context) {
        if (!new Prefs(context).signedIn()) return;
        JobScheduler js = context.getSystemService(JobScheduler.class);
        if (js == null) return;
        try {
            js.schedule(new JobInfo.Builder(AFTER_A_CALL, new ComponentName(context, SyncJob.class))
                    .addTriggerContentUri(new JobInfo.TriggerContentUri(CallLog.Calls.CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                    .setTriggerContentUpdateDelay(5_000)
                    .setTriggerContentMaxDelay(60_000)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build());
        } catch (RuntimeException e) {
            refused(context);
        }
    }

    static void cancel(Context context) {
        JobScheduler js = context.getSystemService(JobScheduler.class);
        if (js == null) return;
        try {
            js.cancelAll();
        } catch (RuntimeException ignored) {
            // Nothing scheduled to cancel.
        }
    }

    private static void refused(Context context) {
        new Prefs(context).failed(context.getString(R.string.error_background));
    }
}
