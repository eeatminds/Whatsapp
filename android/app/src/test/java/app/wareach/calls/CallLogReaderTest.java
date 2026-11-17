package app.wareach.calls;

import static org.junit.Assert.assertEquals;

import android.app.Application;
import android.provider.CallLog;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Reading the phone's call log: only new rows, from the sign-in date on, oldest first, no blank numbers. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class CallLogReaderTest {
    private Application app;

    @Before
    public void setUp() {
        app = RuntimeEnvironment.getApplication();
        FakeCallLog.ROWS.clear();
        Robolectric.setupContentProvider(FakeCallLog.class, CallLog.AUTHORITY);
    }

    @Test
    public void readsNewCallsOldestFirst() {
        FakeCallLog.add(3, "+91 99893 76205", CallLog.Calls.INCOMING_TYPE, 3_000, 40);
        FakeCallLog.add(1, "99893 76205", CallLog.Calls.OUTGOING_TYPE, 1_000, 95);
        FakeCallLog.add(2, "", CallLog.Calls.MISSED_TYPE, 2_000, 0);
        FakeCallLog.add(4, "09989376205", CallLog.Calls.OUTGOING_TYPE, 500, 10);
        List<CallLogReader.Entry> entries = CallLogReader.read(app, 0, 1_000, 200);
        assertEquals(2, entries.size());
        assertEquals("99893 76205", entries.get(0).number);
        assertEquals(95, entries.get(0).duration);
        assertEquals("+91 99893 76205", entries.get(1).number);
        // After row 1 (already sent), from any date: rows 3 and 4; the blank number is skipped.
        assertEquals(2, CallLogReader.read(app, 1, 0, 200).size());
        assertEquals(4, CallLogReader.newestId(app));
    }
}
