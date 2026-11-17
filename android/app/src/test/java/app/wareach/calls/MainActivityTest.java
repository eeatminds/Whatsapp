package app.wareach.calls;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.pm.PackageManager;
import android.os.Looper;
import android.provider.CallLog;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import java.util.function.BooleanSupplier;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowJobScheduler;
import org.robolectric.shadows.ShadowActivity;

/**
 * Runs the app's screen and sync on Android 8, 10, 13, 14 and 15 the way a caller uses it: open,
 * sign in, allow (or refuse) call history, send. None of it may close the app.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 33, 34, 35})
public class MainActivityTest {
    private Application app;
    private FakeServer server;

    @Before
    public void setUp() throws Exception {
        app = RuntimeEnvironment.getApplication();
        server = new FakeServer();
        FakeCallLog.ROWS.clear();
        Robolectric.setupContentProvider(FakeCallLog.class, CallLog.AUTHORITY);
    }

    @After
    public void tearDown() throws Exception {
        server.close();
    }

    @Test
    public void opensOnTheSignInScreenWithItsVersion() {
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertEquals(View.VISIBLE, screen.findViewById(R.id.signin).getVisibility());
        assertEquals(View.GONE, screen.findViewById(R.id.status).getVisibility());
        assertTrue(text(screen, R.id.version).contains(BuildConfig.VERSION_NAME));
    }

    @Test
    public void signsInAsksForCallHistoryThenRecordingsAndSendsCalls() {
        FakeCallLog.add(1, "99893 76205", CallLog.Calls.OUTGOING_TYPE, System.currentTimeMillis() - 60_000, 95);
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity screen = controller.get();
        signIn(screen);

        // First: call history.
        ShadowActivity.PermissionsRequest first = waitForRequest(screen, Manifest.permission.READ_CALL_LOG);
        assertEquals(View.VISIBLE, screen.findViewById(R.id.status).getVisibility());
        assertTrue(text(screen, R.id.connected_as).contains("Shreyas Naveen Tiles"));

        // Allowed: background sending is set up, calls go out, and recordings are asked for next.
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG);
        screen.onRequestPermissionsResult(first.requestCode, first.requestedPermissions, new int[] {PackageManager.PERMISSION_GRANTED});
        idle();
        JobScheduler jobs = app.getSystemService(JobScheduler.class);
        assertNotNull(jobs.getPendingJob(Scheduler.EVERY_15_MIN));
        assertNotNull(jobs.getPendingJob(Scheduler.AFTER_A_CALL));
        waitForRequest(screen, Sync.audioPermission());
        waitUntil(() -> !server.calls.isEmpty());
        String sent = server.calls.get(0);
        assertTrue(sent, sent.contains("\"number\":\"99893 76205\""));
        assertTrue(sent, sent.contains("\"callHistory\":\"allowed\""));
        assertTrue(sent, sent.contains("\"appVersion\":\"" + BuildConfig.VERSION_NAME + "\""));

        // Back on screen (as after the permission dialog closes): still fine.
        controller.pause().resume();
        idle();
        waitUntil(() -> server.paths.contains("/status"));
        assertEquals(View.GONE, screen.findViewById(R.id.allow_calls).getVisibility());
    }

    @Test
    public void refusingCallHistoryKeepsTheAppOpenAndTellsWaReach() {
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity screen = controller.get();
        signIn(screen);
        ShadowActivity.PermissionsRequest first = waitForRequest(screen, Manifest.permission.READ_CALL_LOG);
        screen.onRequestPermissionsResult(first.requestCode, first.requestedPermissions, new int[] {PackageManager.PERMISSION_DENIED});
        controller.pause().resume();
        idle();

        assertEquals(View.VISIBLE, screen.findViewById(R.id.status).getVisibility());
        assertEquals(View.VISIBLE, screen.findViewById(R.id.allow_calls).getVisibility());
        // The background check-in still reaches WA Reach, saying call history is off.
        assertTrue(Sync.run(app));
        String sent = server.calls.get(server.calls.size() - 1);
        assertTrue(sent, sent.contains("\"callHistory\":\"denied\""));
        assertTrue(sent, sent.contains("\"calls\":[]"));
    }

    @Test
    public void anEmptyPermissionAnswerIsHandled() {
        // Android answers with empty lists when a request is interrupted (another dialog, rotation).
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        signIn(screen);
        waitForRequest(screen, Manifest.permission.READ_CALL_LOG);
        screen.onRequestPermissionsResult(1, new String[0], new int[0]);
        screen.onRequestPermissionsResult(2, new String[0], new int[0]);
        idle();
        assertEquals(View.VISIBLE, screen.findViewById(R.id.status).getVisibility());
    }

    @Test
    public void closingTheScreenWhileSigningInDoesNotCrash() throws Exception {
        server.loginDelayMs = 400;
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        signIn(controller.get());
        // Rotation or dark mode recreates the screen while the sign-in is still out.
        controller.pause().stop().destroy();
        waitUntil(() -> new Prefs(app).signedIn());
        Thread.sleep(100);
        idle();
        MainActivity again = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertEquals(View.VISIBLE, again.findViewById(R.id.status).getVisibility());
        // The new screen can still send (the shared network thread was not shut down).
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG);
        ((Button) again.findViewById(R.id.send_now)).performClick();
        waitUntil(() -> !server.calls.isEmpty());
    }

    @Test
    @Config(shadows = RefusingJobScheduler.class)
    public void aRefusedBackgroundJobNeverClosesTheApp() {
        // Android 14+ throws when a job's network rule isn't allowed (what closed 1.0.0); phone makers
        // refuse jobs too. The app opens, signs in and allows call history all the same.
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity screen = controller.get();
        signIn(screen);
        ShadowActivity.PermissionsRequest first = waitForRequest(screen, Manifest.permission.READ_CALL_LOG);
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG);
        screen.onRequestPermissionsResult(first.requestCode, first.requestedPermissions, new int[] {PackageManager.PERMISSION_GRANTED});
        controller.pause().resume();
        idle();
        Scheduler.armCallTrigger(app);
        Scheduler.cancel(app);
        assertEquals(View.VISIBLE, screen.findViewById(R.id.status).getVisibility());
        // Sending by hand still works, and the screen says why background sending isn't on.
        waitForRequest(screen, Sync.audioPermission());
        waitUntil(() -> !server.calls.isEmpty());
        new Prefs(app).failed(app.getString(R.string.error_background));
        Scheduler.schedule(app);
        assertEquals(app.getString(R.string.error_background), new Prefs(app).lastError());
    }

    @Test
    public void showsAndReportsWhyItClosedLastTime() {
        new Prefs(app).signIn(server.address(), "abc123.ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ", "Shop", "Naveen", 0);
        new Prefs(app).crashed(App.describe(new IllegalStateException("boom")));
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        TextView problem = screen.findViewById(R.id.problem);
        assertEquals(View.VISIBLE, problem.getVisibility());
        assertTrue(problem.getText().toString(), problem.getText().toString().contains("IllegalStateException: boom"));
        // Just after closing, the screen opens quietly: no background setup that could close it again.
        assertNull(app.getSystemService(JobScheduler.class).getPendingJob(Scheduler.EVERY_15_MIN));

        // The next send tells WA Reach once.
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG);
        assertTrue(Sync.run(app));
        assertTrue(server.calls.get(0).contains("IllegalStateException: boom"));
        assertTrue(new Prefs(app).problemReported());
        assertTrue(Sync.run(app));
        assertFalse(server.calls.get(1).contains("IllegalStateException"));
    }

    @Test
    public void appInstallsItsCrashRecorder() {
        assertTrue(app instanceof App);
        assertNotNull(Thread.getDefaultUncaughtExceptionHandler());
    }

    @Test
    public void noNetworkIsAnErrorOnScreenNotACrash() {
        new Prefs(app).signIn("http://127.0.0.1:1", "abc123.ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ", "Shop", "Naveen", 0);
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG);
        assertFalse(Sync.run(app));
        assertEquals(app.getString(R.string.error_offline), new Prefs(app).lastError());
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertEquals(View.VISIBLE, screen.findViewById(R.id.sync_error).getVisibility());
    }

    @Test
    public void wrongPasswordStaysOnSignIn() {
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        ((EditText) screen.findViewById(R.id.server)).setText("http://127.0.0.1:1");
        ((EditText) screen.findViewById(R.id.email)).setText("naveen@example.com");
        ((EditText) screen.findViewById(R.id.password)).setText("secret");
        ((Button) screen.findViewById(R.id.connect)).performClick();
        waitUntil(() -> {
            idle();
            return screen.findViewById(R.id.signin_error).getVisibility() == View.VISIBLE;
        });
        assertEquals(View.VISIBLE, screen.findViewById(R.id.signin).getVisibility());
    }

    // ---------------------------------------------------------------- helpers

    private void signIn(MainActivity screen) {
        ((EditText) screen.findViewById(R.id.server)).setText(server.address());
        ((EditText) screen.findViewById(R.id.email)).setText("naveen@example.com");
        ((EditText) screen.findViewById(R.id.password)).setText("secret");
        ((Button) screen.findViewById(R.id.connect)).performClick();
    }

    private ShadowActivity.PermissionsRequest waitForRequest(MainActivity screen, String permission) {
        ShadowActivity.PermissionsRequest[] found = new ShadowActivity.PermissionsRequest[1];
        waitUntil(() -> {
            idle();
            ShadowActivity.PermissionsRequest last = shadowOf(screen).getLastRequestedPermission();
            if (last != null && last.requestedPermissions.length == 1 && last.requestedPermissions[0].equals(permission)) found[0] = last;
            return found[0] != null;
        });
        return found[0];
    }

    private void waitUntil(BooleanSupplier condition) {
        long end = System.currentTimeMillis() + 10_000;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > end) fail("timed out; server saw " + server.paths + "; last error: " + new Prefs(app).lastError() + "; problem: " + new Prefs(app).problem());
            idle();
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private static void idle() {
        shadowOf(Looper.getMainLooper()).idle();
    }

    private static String text(MainActivity screen, int id) {
        return ((TextView) screen.findViewById(id)).getText().toString();
    }

    /** Android's job scheduler refusing everything, as Android 14+ does when a job's rule isn't allowed. */
    @Implements(className = "android.app.JobSchedulerImpl", isInAndroidSdk = false)
    public static class RefusingJobScheduler extends ShadowJobScheduler.ShadowJobSchedulerImpl {
        @Implementation
        @Override
        public int schedule(JobInfo job) {
            throw new SecurityException("Error: requested job be persisted without holding RECEIVE_BOOT_COMPLETED permission / ACCESS_NETWORK_STATE");
        }

        @Implementation
        @Override
        public JobInfo getPendingJob(int jobId) {
            return null;
        }

        @Implementation
        @Override
        public void cancelAll() {
            throw new IllegalStateException("refused");
        }
    }
}
