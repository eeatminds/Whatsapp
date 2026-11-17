package app.wareach.calls;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.provider.CallLog;
import android.provider.MediaStore;
import android.view.View;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * Call recordings: the phone's dialer saves the file (Vivo: Record/Call or Recordings/Call); the app
 * finds the one for a call with a lead and uploads it, or tells WA Reach there is none.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 33, 35})
public class RecordingTest {
    private static final String TOKEN = "abc123.ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ";
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    private Application app;
    private FakeServer server;
    private long startedAt;

    @Before
    public void setUp() throws Exception {
        app = RuntimeEnvironment.getApplication();
        server = new FakeServer();
        FakeCallLog.ROWS.clear();
        FakeMedia.clear();
        Robolectric.setupContentProvider(FakeCallLog.class, CallLog.AUTHORITY);
        Robolectric.setupContentProvider(FakeMedia.class, MediaStore.AUTHORITY);
        new Prefs(app).signIn(server.address(), TOKEN, "Naveen tile", "Shreyas", 0);
        shadowOf(app).grantPermissions(Manifest.permission.READ_CALL_LOG, Sync.audioPermission());
        // A 3 min 46 s call to Pratik dey that started 10 minutes ago.
        startedAt = System.currentTimeMillis() - 10 * 60_000;
        FakeCallLog.add(1, "6003416630", CallLog.Calls.OUTGOING_TYPE, startedAt, 226);
        server.wanted = "[{\"id\":7,\"number\":\"916003416630\",\"startedAt\":" + startedAt + ",\"duration\":226}]";
    }

    @After
    public void tearDown() throws Exception {
        server.close();
    }

    @Test
    public void uploadsTheDialersRecordingOfTheCall() throws Exception {
        // Vivo's dialer started recording while it rang, so the file runs 20 s longer than the call.
        File file = recording(5000);
        FakeMedia.add(new FakeMedia.Row(11, "Pratik dey 20261117_172705.m4a", "Record/Call/", startedAt / 1000 + 2, (startedAt + 226_000) / 1000 + 3, file, "audio/mp4", 246_000));
        // A voice note recorded at the same time is never sent.
        FakeMedia.add(new FakeMedia.Row(12, "Voice 001.m4a", "Recordings/", startedAt / 1000 + 2, (startedAt + 226_000) / 1000 + 3, recording(3000), "audio/mp4", 226_000));

        assertTrue(Sync.run(app));
        assertEquals(1, server.recordings.size());
        assertEquals("/recordings/7 audio/mp4 5000", server.recordings.get(0));
        // The phone tells WA Reach where its dialer keeps recordings.
        String sent = server.calls.get(0);
        assertTrue(sent, sent.contains("\"recordingsFolder\":\"Record\\/Call\\/\"") || sent.contains("\"recordingsFolder\":\"Record/Call/\""));
        assertEquals("Record/Call/", new Prefs(app).recordingsFolder());
    }

    @Test
    public void picksTheRecordingByTheNumberInItsName() throws Exception {
        // Two recordings at once: the one named with the lead's number wins.
        FakeMedia.add(new FakeMedia.Row(21, "Call_9988776655_1727.m4a", "Recordings/Call/", startedAt / 1000, (startedAt + 226_000) / 1000, recording(4000), "audio/mp4", 226_000));
        FakeMedia.add(new FakeMedia.Row(22, "Call_6003416630_1727.m4a", "Recordings/Call/", startedAt / 1000, (startedAt + 226_000) / 1000 + 40, recording(4100), "audio/mp4", 226_000));
        assertTrue(Sync.run(app));
        assertEquals("/recordings/7 audio/mp4 4100", server.recordings.get(0));
    }

    @Test
    public void looksAgainSoonWhileTheDialerIsStillSaving() {
        assertTrue(Sync.run(app));
        assertTrue(server.recordings.isEmpty());
        JobInfo again = app.getSystemService(JobScheduler.class).getPendingJob(Scheduler.NOW);
        assertNotNull("a look in a couple of minutes", again);
        assertEquals(2 * 60_000L, again.getMinLatencyMillis());
        // That look doesn't book yet another one.
        app.getSystemService(JobScheduler.class).cancel(Scheduler.NOW);
        assertTrue(Sync.run(app, false));
        assertNull(app.getSystemService(JobScheduler.class).getPendingJob(Scheduler.NOW));
    }

    @Test
    public void saysThereIsNoneOnceTheCallIsOld() {
        long old = System.currentTimeMillis() - 2 * 3_600_000L;
        server.wanted = "[{\"id\":8,\"number\":\"916003416630\",\"startedAt\":" + old + ",\"duration\":60}]";
        assertTrue(Sync.run(app));
        assertEquals(1, server.recordings.size());
        assertTrue(server.recordings.get(0), server.recordings.get(0).startsWith("/recordings/8/none "));
    }

    @Test
    public void tellsTheCallerWhenTheDialerIsntRecording() {
        assertTrue(Sync.run(app));
        assertTrue(server.calls.get(0).contains("\"recordingsFolder\":\"\""));
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        TextView found = screen.findViewById(R.id.recordings_found);
        assertEquals(View.VISIBLE, found.getVisibility());
        assertEquals(app.getString(R.string.recordings_none), found.getText().toString());
    }

    @Test
    public void aRecordingThatCantBeOpenedIsSkippedNotACrash() throws Exception {
        File file = recording(5000);
        FakeMedia.add(new FakeMedia.Row(31, "Call_6003416630.m4a", "Recordings/Call/", startedAt / 1000, (startedAt + 226_000) / 1000, file, "audio/mp4", 226_000));
        assertTrue(file.delete());
        assertTrue(Sync.run(app));
        assertTrue(server.recordings.isEmpty());
        assertEquals("", new Prefs(app).lastError());
    }

    @Test
    public void recordingLengthAllowsForRinging() {
        assertTrue(RecordingFinder.lengthFits(246, 226));
        assertTrue(RecordingFinder.lengthFits(95, 60)); // 35 s of ringing on a one-minute call
        assertTrue(RecordingFinder.lengthFits(50, 60));
        assertFalse(RecordingFinder.lengthFits(300, 60)); // another, longer call
        assertFalse(RecordingFinder.lengthFits(20, 226)); // a short clip, not this call
    }

    private File recording(int bytes) throws IOException {
        File file = tmp.newFile();
        byte[] data = new byte[bytes];
        byte[] head = {0, 0, 0, 0x20, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '};
        System.arraycopy(head, 0, data, 0, head.length);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
        return file;
    }
}
