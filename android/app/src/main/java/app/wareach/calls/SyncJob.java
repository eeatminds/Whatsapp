package app.wareach.calls;

import android.app.job.JobParameters;
import android.app.job.JobService;

/** Runs a sync round in the background when Android starts one of the scheduled jobs. */
public class SyncJob extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            boolean done = true;
            try {
                done = Sync.run(getApplicationContext());
            } finally {
                if (params.getJobId() == Scheduler.AFTER_A_CALL) Scheduler.armCallTrigger(getApplicationContext());
                // The 15-minute job comes round again anyway; others retry with Android's backoff.
                jobFinished(params, !done && params.getJobId() != Scheduler.EVERY_15_MIN);
            }
        }, "wa-reach-sync").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
