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
 * finds the one for a call with a lead and uploads it, or tells WA Reach there is none, and says in
 * words what it found either way.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {26, 29, 33, 35})
public class RecordingTest {
    private static final String TOKEN = "abc123.ABCDEFGHIJABCDEFGHIJABCDEFGHIJABCDEFGHIJ";
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    private Application app;
    private FakeServer server;
    private long startedAt;
    private long callEnd;

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
        callEnd = startedAt + 226_000;
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
        add(11, "Record/Call/", "Pratik dey 20261117_172705.m4a", 5000, 246_000);
        // A voice note recorded at the same time is never sent.
        add(12, "Recordings/", "Voice 001.m4a", 3000, 226_000);

        assertTrue(Sync.run(app));
        assertEquals(1, server.recordings.size());
        assertEquals("/recordings/7 audio/mp4 5000", server.recordings.get(0));
        // The phone tells WA Reach where its dialer keeps recordings, and what happened, straight away.
        assertTrue(new Prefs(app).recordingsFolder().endsWith("Record/Call/"));
        String report = new Prefs(app).recordingReport();
        assertTrue(report, report.startsWith("Call at ") && report.contains("recording sent (from "));
        assertTrue(server.calls.get(server.calls.size() - 1).contains("recording sent"));
    }

    @Test
    public void readsTheFileItselfWhenTheMediaListWontOpenIt() throws Exception {
        add(13, "Record/Call/", "Pratik dey 20261117_172705.m4a", 4800, 226_000);
        FakeMedia.refuseOpen = true;
        assertTrue(Sync.run(app));
        assertEquals("/recordings/7 audio/mp4 4800", server.recordings.get(0));
    }

    @Test
    public void picksTheRecordingByTheNumberInItsName() throws Exception {
        // Two recordings at once: the one named with the lead's number wins.
        add(21, "Recordings/Call/", "Call_9988776655_1727.m4a", 4000, 226_000);
        add(22, "Recordings/Call/", "Call_6003416630_1727.m4a", 4100, 226_000);
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
    public void explainsWhyThereIsNoRecording() throws Exception {
        // Nothing saved at all: the Phone app didn't record.
        assertTrue(Sync.run(app));
        assertTrue(new Prefs(app).recordingReport(), new Prefs(app).recordingReport().contains("no audio file was saved"));

        // Audio saved, but only somewhere that isn't a call recordings folder.
        add(41, "Recordings/", "Voice 002.m4a", 3000, 226_000);
        assertTrue(Sync.run(app));
        String report = new Prefs(app).recordingReport();
        assertTrue(report, report.contains("none in a call recordings folder") && report.contains("Recordings/"));

        // A call recording, but of another (much shorter) call.
        add(42, "Record/Call/", "Asha 20261117.m4a", 3000, 20_000);
        assertTrue(Sync.run(app));
        report = new Prefs(app).recordingReport();
        assertTrue(report, report.contains("20 s long and the call was 226 s"));
        assertTrue(server.recordings.isEmpty());
    }

    @Test
    public void tellsTheCallerWhenTheDialerIsntRecording() {
        assertTrue(Sync.run(app));
        assertTrue(server.calls.get(0).contains("\"recordingsFolder\":\"\""));
        MainActivity screen = Robolectric.buildActivity(MainActivity.class).setup().get();
        TextView found = screen.findViewById(R.id.recordings_found);
        assertEquals(View.VISIBLE, found.getVisibility());
        assertTrue(found.getText().toString(), found.getText().toString().startsWith(app.getString(R.string.recordings_none)));
        assertTrue(found.getText().toString(), found.getText().toString().contains("no audio file was saved"));
    }

    @Test
    public void aRecordingThatCantBeOpenedIsSkippedNotACrash() throws Exception {
        File file = add(31, "Recordings/Call/", "Call_6003416630.m4a", 5000, 226_000);
        assertTrue(file.delete());
        assertTrue(Sync.run(app));
        assertTrue(server.recordings.isEmpty());
        assertEquals("", new Prefs(app).lastError());
        String report = new Prefs(app).recordingReport();
        assertTrue(report, report.contains("couldn't open it") && report.contains("reading the file failed too"));
    }

    @Test
    public void recordingLengthAllowsForRinging() {
        assertTrue(RecordingFinder.lengthFits(246, 226));
        assertTrue(RecordingFinder.lengthFits(95, 60)); // 35 s of ringing on a one-minute call
        assertTrue(RecordingFinder.lengthFits(50, 60));
        assertFalse(RecordingFinder.lengthFits(300, 60)); // another, longer call
        assertFalse(RecordingFinder.lengthFits(20, 226)); // a short clip, not this call
    }

    /** An audio file saved by the time the call ended, listed in the phone's media list. */
    private File add(long id, String folder, String name, int bytes, long durationMs) throws IOException {
        File dir = new File(tmp.getRoot(), "emulated/0/" + folder);
        assertTrue(dir.isDirectory() || dir.mkdirs());
        File file = new File(dir, name);
        byte[] data = new byte[bytes];
        byte[] head = {0, 0, 0, 0x20, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '};
        System.arraycopy(head, 0, data, 0, head.length);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
        FakeMedia.add(new FakeMedia.Row(id, name, folder, startedAt / 1000 + 2, callEnd / 1000 + 3, file, "audio/mp4", durationMs));
        return file;
    }
}
